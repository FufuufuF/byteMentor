import type { Message, ModelRef, SessionId, ThinkingLevel } from "@byte-mentor/core";
import type {
  EntryId,
  PendingCompactionEntry,
  PendingSessionEntry,
  SessionEntry,
  SessionSnapshot,
  SessionStore,
  ModelState,
} from "@byte-mentor/session";
import {
  SessionCorruptedError,
  SessionLeafConflictError,
  SessionNotFoundError,
  SessionStoreError,
  SessionTree,
  randomEntryId,
  replayRuntimeState,
} from "@byte-mentor/session";
import {
  buildProviderContext,
  mapEntriesToMessages,
  selectEffectiveContextEntries,
} from "../context/session-context.js";
import { planCompaction } from "./compaction-planner.js";
import type { CompactionPlan, CompactionPlanningError } from "./compaction-planner.js";
import { executeSummaryWithRetry } from "../summary/summary-executor.js";
import type { SummaryError, SummaryModelPort, SummaryRequest } from "../summary/summary-port.js";
import { estimateRequestTokens } from "../token/token-estimator.js";
import {
  defaultRuntimeEnvironment,
  type RuntimeEnvironment,
} from "../runtime/runtime-environment.js";

// M6.5/M6.9/M6.11 Compaction 领域服务：摘要生成在 Store 事务外完成，
// Turn 内只形成 pending 结果；空闲期成功后再通过 commitCompaction 原子落库并重建上下文。

export type CompactionTrigger = "manual" | "automatic";

// 规划路径可以同时包含已持久化 Entry 和当前 Turn 尚未分配 sequence 的 pending Entry。
export type CompactionPathEntry = SessionEntry | PendingSessionEntry;

export interface PreparedCompaction {
  // 稳定身份、时间和 parent 已冻结；提交时 Store 只补 sequence。
  entry: PendingCompactionEntry;
  // 应用该 Compaction 后继续 ReAct 所使用的 provider-neutral working context。
  workingMessages: Message[];
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export type CompactionErrorKind =
  "model-unavailable" | "empty-summary" | "generation-failed" | "commit-failed";

export class CompactionError extends Error {
  readonly kind: CompactionErrorKind;
  readonly cause?: SummaryError | SessionStoreError;
  readonly prepared?: PreparedCompaction;

  constructor(
    kind: CompactionErrorKind,
    message: string,
    options: {
      cause?: SummaryError | SessionStoreError;
      prepared?: PreparedCompaction;
    } = {},
  ) {
    super(message);
    this.name = "CompactionError";
    this.kind = kind;
    this.cause = options.cause;
    this.prepared = options.prepared;
  }
}

export interface PrepareCompactionInput {
  path: readonly CompactionPathEntry[];
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  trigger: CompactionTrigger;
  summarize: SummaryModelPort;
  keepRecentTokens: number;
  summaryInputBudget?: number;
  maxSummaryOutputTokens?: number;
  signal?: AbortSignal;
}

export type CompactionPreparationResult =
  | { ok: true; mode: "ready"; prepared: PreparedCompaction }
  | { ok: true; mode: "noop"; reason: "no-compressible-content" }
  | {
      ok: false;
      error: CompactionError | CompactionPlanningError | SessionCorruptedError;
    };

// 只生成 pending Compaction，不读取/修改 SessionStore；供 Turn checkpoint 和空闲期服务共用。
export async function prepareCompaction(
  input: PrepareCompactionInput,
): Promise<CompactionPreparationResult> {
  const planningPath = materializePlanningPath(input.path);
  const planning = planCompaction({
    path: planningPath,
    keepRecentTokens: input.keepRecentTokens,
    summaryInputBudget: input.summaryInputBudget,
  });
  if (!planning.ok || planning.mode === "noop") {
    return planning;
  }

  return prepareCompactionFromPlan(input, planning.plan, planningPath);
}

async function prepareCompactionFromPlan(
  input: PrepareCompactionInput,
  plan: CompactionPlan,
  planningPath: SessionEntry[],
): Promise<CompactionPreparationResult> {
  const request: SummaryRequest = {
    instructions: plan.summaryPrompt,
    historyText: plan.summaryInput,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    ...(input.maxSummaryOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.maxSummaryOutputTokens }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const response = await executeSummaryWithRetry(input.summarize, request);
  if (!response.ok) {
    return {
      ok: false,
      error: new CompactionError(
        "generation-failed",
        `compaction summary generation failed: ${response.error.kind}`,
        { cause: response.error },
      ),
    };
  }

  const summary = response.text.trim();
  if (summary.length === 0) {
    return {
      ok: false,
      error: new CompactionError("empty-summary", "compaction summary is empty"),
    };
  }

  const entry: PendingCompactionEntry = {
    id: randomEntryId(),
    parentId: plan.sourceLeafId,
    createdAt: new Date().toISOString(),
    type: "compaction",
    summary,
    firstKeptEntryId: plan.firstKeptEntryId,
    tokensBefore: plan.tokensBefore,
    trigger: input.trigger,
    model: input.model,
    ...(response.usage === undefined ? {} : { usage: response.usage }),
  };
  const workingPath = [
    ...planningPath,
    { ...entry, sequence: planningPath.length + 1 } as SessionEntry,
  ];
  const effective = selectEffectiveContextEntries(workingPath);
  if (!effective.ok) {
    return effective;
  }
  const workingMessages = mapEntriesToMessages(effective.entries);
  return {
    ok: true,
    mode: "ready",
    prepared: {
      entry,
      workingMessages,
      tokensBefore: plan.tokensBefore,
      estimatedTokensAfter: estimateRequestTokens({ messages: workingMessages }),
    },
  };
}

export interface CompactSessionInput {
  store: SessionStore;
  sessionId: SessionId;
  summarize: SummaryModelPort;
  trigger: CompactionTrigger;
  keepRecentTokens: number;
  summaryInputBudget?: number;
  maxSummaryOutputTokens?: number;
  environment?: RuntimeEnvironment;
  signal?: AbortSignal;
  // 提交失败后的重试：使用同一 pending Entry 和摘要，跳过模型调用。
  preparedCompaction?: PreparedCompaction;
}

export interface RebuiltCompactionContext {
  path: SessionEntry[];
  messages: Message[];
  modelState: ModelState;
  execution: { ok: true } | { ok: false; reason: string };
  estimatedTokens: number;
}

export type CompactSessionResult =
  | { ok: true; mode: "noop"; reason: "no-compressible-content" }
  | ({ ok: true; mode: "compacted"; entryId: EntryId } & RebuiltCompactionContext)
  | {
      ok: false;
      error:
        | SessionNotFoundError
        | SessionCorruptedError
        | SessionLeafConflictError
        | CompactionError
        | CompactionPlanningError;
    };

// 空闲期 Compaction：加载并校验路径 → 事务外生成 → 原子提交 → reload/rebuild。
export async function compactSession(input: CompactSessionInput): Promise<CompactSessionResult> {
  const snapshot = await input.store.loadSession(input.sessionId);
  if (snapshot === undefined) {
    return {
      ok: false,
      error: new SessionNotFoundError(`session not found: ${input.sessionId}`),
    };
  }

  const tree = new SessionTree(snapshot);
  const pathResult = tree.rebuildActivePath();
  if (!pathResult.ok) {
    return { ok: false, error: pathResult.error };
  }

  let prepared = input.preparedCompaction;
  if (prepared === undefined) {
    const planning = planCompaction({
      path: pathResult.path,
      keepRecentTokens: input.keepRecentTokens,
      summaryInputBudget: input.summaryInputBudget,
    });
    if (!planning.ok || planning.mode === "noop") {
      return planning;
    }
    const modelState = replayRuntimeState(snapshot, snapshot.activeLeafId);
    const environment = input.environment ?? defaultRuntimeEnvironment;
    const availability = environment.canExecute(modelState);
    if (!availability.ok) {
      return {
        ok: false,
        error: new CompactionError("model-unavailable", availability.reason),
      };
    }
    const preparation = await prepareCompactionFromPlan(
      {
        path: pathResult.path,
        model: modelState.model,
        thinkingLevel: modelState.thinkingLevel,
        trigger: input.trigger,
        summarize: input.summarize,
        keepRecentTokens: input.keepRecentTokens,
        summaryInputBudget: input.summaryInputBudget,
        maxSummaryOutputTokens: input.maxSummaryOutputTokens,
        signal: input.signal,
      },
      planning.plan,
      pathResult.path,
    );
    if (!preparation.ok || preparation.mode === "noop") {
      return preparation;
    }
    prepared = preparation.prepared;
  }

  let commitResult;
  try {
    commitResult = await input.store.commitCompaction({
      sessionId: input.sessionId,
      expectedLeafId: snapshot.activeLeafId,
      entry: prepared.entry,
    });
  } catch (error) {
    if (error instanceof SessionLeafConflictError || error instanceof SessionNotFoundError) {
      return { ok: false, error };
    }
    if (error instanceof SessionStoreError) {
      return {
        ok: false,
        error: new CompactionError("commit-failed", `compaction commit failed: ${String(error)}`, {
          cause: error,
          prepared,
        }),
      };
    }
    throw error;
  }

  return {
    ok: true,
    mode: "compacted",
    entryId: commitResult.entryId,
    ...(await rebuildCompactionContext(
      input.store,
      input.sessionId,
      input.environment ?? defaultRuntimeEnvironment,
    )),
  };
}

// pending Entry 缺少 sequence 时只为纯规划/上下文计算补临时顺序；不会泄漏到提交对象。
function materializePlanningPath(path: readonly CompactionPathEntry[]): SessionEntry[] {
  return path.map((entry, index) => {
    if ("sequence" in entry) {
      return { ...entry };
    }
    return { ...entry, sequence: index + 1 } as SessionEntry;
  });
}

async function rebuildCompactionContext(
  store: SessionStore,
  sessionId: SessionId,
  environment: RuntimeEnvironment,
): Promise<RebuiltCompactionContext> {
  const snapshot = await store.loadSession(sessionId);
  if (snapshot === undefined) {
    throw new SessionCorruptedError(
      "leaf-missing",
      `session ${sessionId} disappeared after a successful compaction commit`,
    );
  }
  return rebuildContextFromSnapshot(snapshot, environment);
}

function rebuildContextFromSnapshot(
  snapshot: SessionSnapshot,
  environment: RuntimeEnvironment,
): RebuiltCompactionContext {
  const tree = new SessionTree(snapshot);
  const pathResult = tree.rebuildActivePath();
  if (!pathResult.ok) {
    throw pathResult.error;
  }
  const context = buildProviderContext(snapshot, pathResult.path, environment);
  if (!context.ok) {
    throw context.error;
  }
  return {
    path: pathResult.path,
    messages: context.messages,
    modelState: context.modelState,
    execution: context.execution,
    estimatedTokens: estimateRequestTokens({ messages: context.messages }),
  };
}
