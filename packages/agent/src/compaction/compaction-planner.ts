import type { EntryId, SessionCorruptedError, SessionEntry } from "@byte-mentor/session";
import { mapEntriesToMessages, selectEffectiveContextEntries } from "../context/session-context.js";
import { estimateRequestTokens } from "../token/token-estimator.js";
import { buildCompactionSummaryPrompt } from "./compaction-summary.js";
import { serializeSummaryInput } from "../summary/summary-serialize.js";

export type CompactionPlanningErrorKind =
  "invalid-budget" | "summary-input-overflow" | "invalid-tool-batch";

// Compaction 纯规划阶段的输入或摘要输入边界错误；不修改 Session，也不包装外部模型错误。
export class CompactionPlanningError extends Error {
  readonly kind: CompactionPlanningErrorKind;
  readonly estimatedTokens?: number;
  readonly budget?: number;

  constructor(
    kind: CompactionPlanningErrorKind,
    message: string,
    options: { estimatedTokens?: number; budget?: number } = {},
  ) {
    super(message);
    this.name = "CompactionPlanningError";
    this.kind = kind;
    this.estimatedTokens = options.estimatedTokens;
    this.budget = options.budget;
  }
}

export interface PlanCompactionInput {
  path: readonly SessionEntry[];
  // 压缩后希望保留的最近模型可见内容预算；允许 0 表示不保留旧原文尾部。
  keepRecentTokens: number;
  // 摘要请求可用的历史输入预算；未提供时不在规划阶段限制输入大小。
  summaryInputBudget?: number;
}

export interface CompactionPlan {
  sourceLeafId: EntryId | null;
  firstKeptEntryId: EntryId | null;
  retainedEntries: SessionEntry[];
  summarizedEntries: SessionEntry[];
  previousSummary: string | null;
  summaryInput: string;
  summaryInputTokens: number;
  summaryPrompt: string;
  tokensBefore: number;
}

export type CompactionPlanningResult =
  | { ok: true; mode: "ready"; plan: CompactionPlan }
  | { ok: true; mode: "noop"; reason: "no-compressible-content" }
  | { ok: false; error: CompactionPlanningError | SessionCorruptedError };

// 根据活动路径和最近内容预算选择安全切点，并构造增量摘要所需的纯输入数据。
export function planCompaction(input: PlanCompactionInput): CompactionPlanningResult {
  const budgetError = validateBudget(input.keepRecentTokens, input.summaryInputBudget);
  if (budgetError !== undefined) {
    return { ok: false, error: budgetError };
  }

  const compactionResult = selectEffectiveContextEntries(input.path);
  if (!compactionResult.ok) {
    return compactionResult;
  }

  const effectivePath = compactionResult.entries;
  const lastCompaction = findLastCompaction(effectivePath);
  const previousSummary = lastCompaction?.summary ?? null;
  const previousCompactionId = lastCompaction?.id;
  const pathIndexById = new Map(input.path.map((entry, index) => [entry.id, index]));
  const candidateEntries = effectivePath.filter((entry) => entry.id !== previousCompactionId);
  const visibleCandidates = candidateEntries.filter(isModelVisible);
  if (visibleCandidates.length === 0) {
    return { ok: true, mode: "noop", reason: "no-compressible-content" };
  }

  const tokensBefore = estimateRequestTokens({ messages: mapEntriesToMessages(effectivePath) });
  let cutIndex: number;
  if (input.keepRecentTokens === 0) {
    cutIndex = input.path.length;
  } else {
    const selectedIndex = chooseCutIndex(
      input.path,
      candidateEntries,
      pathIndexById,
      input.keepRecentTokens,
    );
    if (selectedIndex === undefined) {
      return { ok: true, mode: "noop", reason: "no-compressible-content" };
    }
    const normalized = normalizeToolResultCut(input.path, selectedIndex, pathIndexById);
    if (!normalized.ok) {
      return normalized;
    }
    cutIndex = normalized.cutIndex;
  }

  const summarizedEntries = effectivePath.filter((entry) => {
    const index = pathIndexById.get(entry.id);
    return index !== undefined && index < cutIndex && entry.id !== previousCompactionId;
  });
  if (!summarizedEntries.some(isModelVisible) && previousSummary === null) {
    return { ok: true, mode: "noop", reason: "no-compressible-content" };
  }

  const interactionPrefixEntries = findInteractionPrefixEntries(
    input.path,
    cutIndex,
    previousCompactionId,
  );
  const summaryInput = buildIncrementalSummaryInput(
    previousSummary,
    summarizedEntries,
    interactionPrefixEntries,
  );
  const summaryInputTokens = estimateRequestTokens({
    messages: [{ role: "user", content: summaryInput }],
  });
  if (input.summaryInputBudget !== undefined && summaryInputTokens > input.summaryInputBudget) {
    return {
      ok: false,
      error: new CompactionPlanningError(
        "summary-input-overflow",
        `serialized compaction summary input exceeds budget: ${summaryInputTokens} > ${input.summaryInputBudget}`,
        { estimatedTokens: summaryInputTokens, budget: input.summaryInputBudget },
      ),
    };
  }

  return {
    ok: true,
    mode: "ready",
    plan: {
      sourceLeafId: input.path.at(-1)?.id ?? null,
      firstKeptEntryId: input.path[cutIndex]?.id ?? null,
      retainedEntries: input.path.slice(cutIndex),
      summarizedEntries,
      previousSummary,
      summaryInput,
      summaryInputTokens,
      summaryPrompt: buildCompactionSummaryPrompt(),
      tokensBefore,
    },
  };
}

// 校验压缩规划使用的 token 预算，避免 NaN、负数或小数传播到切点计算。
function validateBudget(
  keepRecentTokens: number,
  summaryInputBudget: number | undefined,
): CompactionPlanningError | undefined {
  if (!Number.isInteger(keepRecentTokens) || keepRecentTokens < 0) {
    return new CompactionPlanningError(
      "invalid-budget",
      "keepRecentTokens must be a non-negative integer",
    );
  }
  if (
    summaryInputBudget !== undefined &&
    (!Number.isInteger(summaryInputBudget) || summaryInputBudget < 0)
  ) {
    return new CompactionPlanningError(
      "invalid-budget",
      "summaryInputBudget must be a non-negative integer",
    );
  }
  return undefined;
}

// 从活动路径末端向前累计模型可见内容，直到达到 keepRecentTokens。
function chooseCutIndex(
  path: readonly SessionEntry[],
  candidateEntries: readonly SessionEntry[],
  pathIndexById: ReadonlyMap<EntryId, number>,
  keepRecentTokens: number,
): number | undefined {
  const candidateIds = new Set(candidateEntries.map((entry) => entry.id));
  let accumulated = 0;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    if (entry === undefined || !candidateIds.has(entry.id) || !isModelVisible(entry)) {
      continue;
    }
    accumulated += estimateEntryTokens(entry);
    if (accumulated >= keepRecentTokens) {
      return pathIndexById.get(entry.id);
    }
  }
  return undefined;
}

// ToolResult 不能作为上下文开头；命中结果时回退到产生它的 AssistantEntry。
function normalizeToolResultCut(
  path: readonly SessionEntry[],
  selectedIndex: number,
  pathIndexById: ReadonlyMap<EntryId, number>,
): { ok: true; cutIndex: number } | { ok: false; error: CompactionPlanningError } {
  const selected = path[selectedIndex];
  if (selected?.type !== "tool_result") {
    return { ok: true, cutIndex: selectedIndex };
  }
  for (let index = selectedIndex - 1; index >= 0; index -= 1) {
    const candidate = path[index];
    if (candidate?.type !== "assistant") {
      continue;
    }
    if (candidate.toolCalls.some((toolCall) => toolCall.id === selected.toolCallId)) {
      const assistantIndex = pathIndexById.get(candidate.id);
      if (assistantIndex === undefined) {
        break;
      }
      return { ok: true, cutIndex: assistantIndex };
    }
  }
  return {
    ok: false,
    error: new CompactionPlanningError(
      "invalid-tool-batch",
      `tool result ${selected.id} has no producing assistant on the active path`,
    ),
  };
}

// 只有从 Assistant/ToolResult 内部切分时，才提取需要并入摘要的交互前缀。
function findInteractionPrefixEntries(
  path: readonly SessionEntry[],
  cutIndex: number,
  previousCompactionId: EntryId | undefined,
): readonly SessionEntry[] | null {
  const cutEntry = path[cutIndex];
  if (cutEntry?.type !== "assistant" && cutEntry?.type !== "tool_result") {
    return null;
  }
  let userIndex = -1;
  for (let index = cutIndex - 1; index >= 0; index -= 1) {
    const entry = path[index];
    if (entry?.id === previousCompactionId) {
      break;
    }
    if (entry?.type === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex === -1) {
    return null;
  }
  return path.slice(userIndex, cutIndex);
}

// 组合旧 Compaction、被压掉的旧尾部和交互前缀，形成协议安全的增量摘要历史输入。
function buildIncrementalSummaryInput(
  previousSummary: string | null,
  summarizedEntries: readonly SessionEntry[],
  interactionPrefixEntries: readonly SessionEntry[] | null,
): string {
  const prefixIds = new Set(interactionPrefixEntries?.map((entry) => entry.id) ?? []);
  const olderEntries = summarizedEntries.filter((entry) => !prefixIds.has(entry.id));
  const parts: string[] = [];
  if (previousSummary !== null) {
    parts.push(`<previous_compaction_summary>\n${previousSummary}\n</previous_compaction_summary>`);
  }
  const olderText = serializeSummaryInput(olderEntries);
  if (olderText.length > 0) {
    parts.push(`<history>\n${olderText}\n</history>`);
  }
  if (interactionPrefixEntries !== null) {
    const prefixText = serializeSummaryInput(interactionPrefixEntries);
    if (prefixText.length > 0) {
      parts.push(`<interaction_prefix>\n${prefixText}\n</interaction_prefix>`);
    }
  }
  return parts.join("\n");
}

// 判断 Entry 是否会产生 provider message；状态 Entry 不参与 token 累计或摘要输入。
function isModelVisible(entry: SessionEntry): boolean {
  return mapEntriesToMessages([entry]).length > 0;
}

// 按当前 provider-neutral Message 映射估算单条 Entry 的协议和内容 token。
function estimateEntryTokens(entry: SessionEntry): number {
  return estimateRequestTokens({ messages: mapEntriesToMessages([entry]) });
}

// 找到压缩感知活动路径上最后一个 CompactionEntry。
function findLastCompaction(
  entries: readonly SessionEntry[],
): Extract<SessionEntry, { type: "compaction" }> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "compaction") {
      return entry;
    }
  }
  return undefined;
}
