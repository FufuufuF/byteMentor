import type { Message, ModelRef, SessionId, TokenUsage } from "@byte-mentor/core";
import type { SessionEntry } from "@byte-mentor/session";
import {
  SessionCorruptedError,
  SessionLeafConflictError,
  SessionNavigationError,
  SessionNotFoundError,
  SessionStoreError,
  SessionTree,
  listTreeTargets,
  replayRuntimeState,
  type ModelState,
  type SessionSnapshot,
  type SessionStore,
} from "@byte-mentor/session";
import {
  defaultRuntimeEnvironment,
  type RuntimeEnvironment,
} from "../runtime/runtime-environment.js";
import { buildProviderContext } from "../context/session-context.js";
import { executeSummaryWithRetry } from "./summary-executor.js";
import { computeSummaryInterval } from "./summary-interval.js";
import type { SummaryError, SummaryModelPort, SummaryRequest } from "./summary-port.js";
import { serializeSummaryInput } from "./summary-serialize.js";

// M5.6 带 Branch Summary 的 Tree 导航领域服务：消费 B7 的总结区间/序列化/摘要端口，
// 在数据库事务外生成摘要，成功后通过 session 的 commitBranchSummary 原子提交。
// 失败/取消/空摘要/stale source 不写 Entry、不移动 leaf；提交失败返回 prepared 摘要，
// 调用方可以复用重试而不必再次调用模型。成功后重建活动路径/状态/transcript（M5.7），
// 只返回领域结果，不直接操作 UI。

// 已生成、尚未提交的 Branch Summary（M5.6）：提交失败后可复用重试，不重新调用模型。
export interface PreparedBranchSummary {
  summary: string;
  model: ModelRef;
  usage?: TokenUsage;
}

// 摘要生成/提交阶段的领域错误分类（M5.5/M5.6/M5.8）。
export type BranchSummaryErrorKind =
  // source leaf 恢复出的模型当前不可执行：摘要导航失败且 leaf 不移动。
  | "model-unavailable"
  // 摘要模型返回空白文本：不写 Entry、不移动 leaf，也不自动降级为直接导航。
  | "empty-summary"
  // 摘要端口调用失败/取消；cause 携带原始 SummaryError。
  | "generation-failed"
  // 数据库提交失败；cause 为 SessionStoreError，prepared 供复用重试。
  | "commit-failed";

export class BranchSummaryError extends Error {
  readonly kind: BranchSummaryErrorKind;
  readonly cause?: SummaryError | SessionStoreError;
  readonly prepared?: PreparedBranchSummary;

  constructor(
    kind: BranchSummaryErrorKind,
    message: string,
    options: { cause?: SummaryError | SessionStoreError; prepared?: PreparedBranchSummary } = {},
  ) {
    super(message);
    this.name = "BranchSummaryError";
    this.kind = kind;
    this.cause = options.cause;
    this.prepared = options.prepared;
  }
}

// 导航提交成功后的重建结果（M5.7）：调用方据此重建 transcript/编辑器，不直接操作 UI。
export interface RebuiltNavigationContext {
  path: SessionEntry[];
  messages: Message[];
  modelState: ModelState;
  execution: { ok: true } | { ok: false; reason: string };
}

export type BranchSummaryNavigationResult =
  // 选择当前 leaf / user 的 parent 已是 leaf（M5.8）：不写库，user 时只回填草稿。
  | { ok: true; mode: "noop"; newLeafId: string | null; draft?: string }
  // 没有离开的旧分支或总结区间为空（M5.3）：退化为直接导航，不调用摘要模型。
  | ({
      ok: true;
      mode: "direct";
      newLeafId: string | null;
      draft?: string;
    } & RebuiltNavigationContext)
  // 摘要成功生成并原子提交：summary entry 成为 active leaf。
  | ({ ok: true; mode: "summary"; newLeafId: string; draft?: string } & RebuiltNavigationContext)
  // 失败：不写 Entry、不移动 leaf；commit-failed 时 error.prepared 可复用重试。
  | {
      ok: false;
      error:
        | SessionNotFoundError
        | SessionNavigationError
        | SessionCorruptedError
        | SessionLeafConflictError
        | BranchSummaryError;
    };

export interface NavigateWithBranchSummaryInput {
  store: SessionStore;
  sessionId: string;
  targetEntryId: string;
  summarize: SummaryModelPort;
  environment?: RuntimeEnvironment;
  signal?: AbortSignal;
  // 复用已生成的摘要（M5.6 提交失败后的重试）：跳过模型调用，重新校验并提交。
  preparedSummary?: PreparedBranchSummary;
}

// 执行带摘要的 Tree 导航：校验目标 → 计算总结区间 → 事务外生成摘要 → 原子提交 → 重建。
export async function navigateWithBranchSummary(
  input: NavigateWithBranchSummaryInput,
): Promise<BranchSummaryNavigationResult> {
  const sessionId = input.sessionId as SessionId;
  const snapshot = await input.store.loadSession(sessionId);
  if (snapshot === undefined) {
    return { ok: false, error: new SessionNotFoundError(`session not found: ${sessionId}`) };
  }
  // M4.1 严格校验活动路径（leaf/parent/循环/seq 顺序），损坏则整体失败。
  const tree = new SessionTree(snapshot);
  const pathResult = tree.rebuildActivePath();
  if (!pathResult.ok) {
    return { ok: false, error: pathResult.error };
  }
  // M5.1 目标校验：可见且可选；user 归一化为 parent 并携带草稿。
  const target = listTreeTargets(snapshot).find((t) => t.entryId === input.targetEntryId);
  if (target === undefined || !target.selectable) {
    return {
      ok: false,
      error: new SessionNavigationError(`target ${input.targetEntryId} is not selectable`),
    };
  }
  const targetLeafId = target.navigationLeafId;
  const draft = target.draft;

  // M5.3 总结区间 (LCA, S]：没有离开的旧分支或区间为空时不生成摘要。
  const interval = computeSummaryInterval(snapshot, snapshot.activeLeafId, targetLeafId);
  if (!interval.ok) {
    if (interval.reason === "unknown-entry") {
      // 活动路径已通过重建校验，剩余只可能是目标祖先链缺失 → 结构损坏。
      return {
        ok: false,
        error: new SessionCorruptedError(
          "parent-missing",
          `summary interval for target ${input.targetEntryId} hit a missing entry`,
        ),
      };
    }
    if (interval.reason === "same-leaf") {
      return {
        ok: true,
        mode: "noop",
        newLeafId: targetLeafId,
        ...(draft === undefined ? {} : { draft }),
      };
    }
    // no-branch-leave / empty-interval：退化为直接导航（M5.3），不调用摘要模型。
    try {
      await input.store.updateLeaf(sessionId, targetLeafId);
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof SessionNavigationError
            ? error
            : new SessionNavigationError(`direct navigation commit failed: ${String(error)}`),
      };
    }
    return {
      ok: true,
      mode: "direct",
      newLeafId: targetLeafId,
      ...(draft === undefined ? {} : { draft }),
      ...(await rebuildContextAfterCommit(input.store, sessionId)),
    };
  }

  // 生成摘要：source leaf 恢复出的模型/thinking（M5.5），在数据库事务外调用（M5.6）。
  let summary: string;
  let model: ModelRef;
  let usage: TokenUsage | undefined;
  if (input.preparedSummary !== undefined) {
    summary = input.preparedSummary.summary;
    model = input.preparedSummary.model;
    usage = input.preparedSummary.usage;
  } else {
    const sourceState = replayRuntimeState(snapshot, snapshot.activeLeafId);
    const environment = input.environment ?? defaultRuntimeEnvironment;
    const availability = environment.canExecute(sourceState);
    if (!availability.ok) {
      return {
        ok: false,
        error: new BranchSummaryError("model-unavailable", availability.reason),
      };
    }
    const request: SummaryRequest = {
      historyText: serializeSummaryInput(interval.interval),
      model: sourceState.model,
      thinkingLevel: sourceState.thinkingLevel,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const response = await executeSummaryWithRetry(input.summarize, request);
    if (!response.ok) {
      return {
        ok: false,
        error: new BranchSummaryError(
          "generation-failed",
          `summary generation failed: ${response.error.kind}`,
          { cause: response.error },
        ),
      };
    }
    summary = response.text.trim();
    if (summary.length === 0) {
      return {
        ok: false,
        error: new BranchSummaryError("empty-summary", "summary model returned an empty summary"),
      };
    }
    model = request.model;
    usage = response.usage;
  }

  // M3.10 原子提交：事务内重新校验 active leaf 仍为 S；失败回滚，prepared 供复用重试。
  const prepared: PreparedBranchSummary = {
    summary,
    model,
    ...(usage === undefined ? {} : { usage }),
  };
  let commitResult;
  try {
    commitResult = await input.store.commitBranchSummary({
      sessionId,
      expectedLeafId: snapshot.activeLeafId,
      parentId: targetLeafId,
      summary,
      model,
      ...(usage === undefined ? {} : { usage }),
    });
  } catch (error) {
    if (error instanceof SessionLeafConflictError || error instanceof SessionNotFoundError) {
      return { ok: false, error };
    }
    if (error instanceof SessionStoreError) {
      return {
        ok: false,
        error: new BranchSummaryError(
          "commit-failed",
          `branch summary commit failed: ${String(error)}`,
          {
            cause: error,
            prepared,
          },
        ),
      };
    }
    throw error;
  }

  // M5.7 提交成功后重建活动路径、目标分支状态与 transcript（复用 B4/B5 能力）。
  return {
    ok: true,
    mode: "summary",
    newLeafId: commitResult.activeLeafId,
    ...(draft === undefined ? {} : { draft }),
    ...(await rebuildContextAfterCommit(input.store, sessionId)),
  };
}

// 提交成功后 reload 快照并重建活动路径/模型状态/transcript（M5.7）。
// 失败只可能来自结构损坏（提交本身刚成功，理论上不可达），按严格失败策略返回错误。
async function rebuildContextAfterCommit(
  store: SessionStore,
  sessionId: SessionId,
): Promise<RebuiltNavigationContext> {
  const snapshot = await store.loadSession(sessionId);
  if (snapshot === undefined) {
    throw new SessionCorruptedError(
      "leaf-missing",
      `session ${sessionId} disappeared after a successful navigation commit`,
    );
  }
  return rebuildContextFromSnapshot(snapshot);
}

function rebuildContextFromSnapshot(snapshot: SessionSnapshot): RebuiltNavigationContext {
  const tree = new SessionTree(snapshot);
  const pathResult = tree.rebuildActivePath();
  if (!pathResult.ok) {
    throw pathResult.error;
  }
  const context = buildProviderContext(snapshot, pathResult.path);
  if (!context.ok) {
    throw context.error;
  }
  return {
    path: pathResult.path,
    messages: context.messages,
    modelState: context.modelState,
    execution: context.execution,
  };
}
