import type { Message, SessionId, ThinkingLevel } from "@byte-mentor/core";
import type { SessionEntry } from "./entries.js";

// SessionStore 领域契约：只暴露领域原子能力，不包含 provider、Runtime 或 UI 决策。
// 多步写事务（Turn 提交、导航、fork、compaction）不在本契约内，由后续 Batch 的功能事务提供。

// 会话的初始状态与工作区归属；用户第一次发送消息时由 Runtime 提供（M4.2 延迟创建）。
export interface CreateSessionInput {
  workspaceRoot: string;
  initialProvider: string;
  initialModelId: string;
  initialThinkingLevel: ThinkingLevel;
}

// Session 的完整持久化快照：初始状态、活动分支指针、追加序号、metadata 与全量 Entry 树。
// entries 按 (session_id, entry_seq) 升序返回，供领域层在内存重建 id/children 索引。
export interface SessionSnapshot {
  id: SessionId;
  workspaceRoot: string;
  initialProvider: string;
  initialModelId: string;
  initialThinkingLevel: ThinkingLevel;
  activeLeafId: SessionEntry["id"] | null;
  nextEntrySeq: number;
  metadata: SessionMetadata;
  createdAt: string;
  updatedAt: string;
  entries: SessionEntry[];
}

export type SessionMetadata = Record<string, unknown>;

// deprecated 线性适配入口的历史遗留返回类型：仅 metadata 子集，供未迁移的 AgentLoop 使用。
export interface Session {
  id: SessionId;
  metadata: SessionMetadata;
}

// M9 稳定错误分类：上层不解析 SQLite 原始字符串决定业务行为。
export type SessionStoreErrorKind =
  "busy" | "capacity" | "read_only" | "io" | "constraint" | "corruption" | "closed" | "unknown";

// 归一化存储错误：kind 供程序分支，message 保留底层信息供诊断。
export class SessionStoreError extends Error {
  readonly kind: SessionStoreErrorKind;

  constructor(kind: SessionStoreErrorKind, message: string) {
    super(message);
    this.name = "SessionStoreError";
    this.kind = kind;
  }
}

// Session 不存在的领域错误；与存储错误区分，便于上层给出准确反馈。
export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}

// Store 已关闭后仍被使用。
export class SessionStoreClosedError extends SessionStoreError {
  constructor() {
    super("closed", "session store is closed");
    this.name = "SessionStoreClosedError";
  }
}

// 批量提交时 active leaf 与 expectedLeafId 不一致（并发下 leaf 已变或调用方持有过期快照）。
// 属于 M9 D 级"当前操作失败"，不是存储错误；不写任何 entry、不推进 leaf/seq、不清 checkpoint。
export class SessionLeafConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLeafConflictError";
  }
}

// Turn 批量提交中的一条 pending entry：不含 sequence（事务内从 next_entry_seq 分配）与
// parentId（第一条接当前 active leaf，后续依次连接前一条）；id/createdAt 未提供时由事务生成。
// DistributiveOmit 保留 union 收窄。
export type PendingTurnEntry = {
  entry: DistributiveOmit<SessionEntry, "sequence" | "parentId" | "id" | "createdAt"> &
    Partial<Pick<SessionEntry, "id" | "createdAt">>;
};

// 保留 discriminated union 结构地省略公共字段的类型工具。
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface CommitTurnInput {
  sessionId: SessionId;
  // 事务内校验当前 active_leaf_id 仍等于该值；不匹配时抛 SessionLeafConflictError。
  expectedLeafId: SessionEntry["id"] | null;
  entries: PendingTurnEntry[];
}

export interface CommitTurnResult {
  activeLeafId: SessionEntry["id"];
  nextEntrySeq: number;
}

export interface SessionStore {
  // 创建一个持久化 Session；返回初始 snapshot。
  createSession(input: CreateSessionInput): Promise<SessionSnapshot>;
  // 全量加载一个 Session 的完整快照（含全部 Entry，按 entry_seq 升序）；不存在返回 undefined。
  loadSession(id: SessionId): Promise<SessionSnapshot | undefined>;
  // 读取 metadata；Session 不存在抛 SessionNotFoundError。
  getMetadata(id: SessionId): Promise<SessionMetadata>;
  // 读改写 metadata：以当前 metadata 为入参调用 updater，原子写回并返回新值。
  updateMetadata(
    id: SessionId,
    updater: (metadata: SessionMetadata) => SessionMetadata,
  ): Promise<SessionMetadata>;
  // 单语句写入 runtime_checkpoint（json_set），不读改写整个 metadata；返回更新后的 metadata。
  setRuntimeCheckpoint(id: SessionId, checkpoint: unknown): Promise<SessionMetadata>;
  // 单语句移除 runtime_checkpoint（json_remove），保留其他 metadata 字段；返回更新后的 metadata。
  clearRuntimeCheckpoint(id: SessionId): Promise<SessionMetadata>;
  // Turn 最终提交/恢复提交共用的批量追加事务：短 BEGIN IMMEDIATE 内校验 leaf、连续分配 seq、
  // 批量插入、推进 leaf/seq、清除 runtime_checkpoint，全有或全无。
  commitTurnEntries(input: CommitTurnInput): Promise<CommitTurnResult>;
  close(): Promise<void>;

  /** @deprecated 仅短期兼容未迁移的 AgentLoop；AgentLoop 迁移到新契约后（B3 收尾）删除。 */
  create(): Promise<Session>;
  /** @deprecated 仅短期兼容未迁移的 AgentLoop；AgentLoop 迁移到新契约后（B3 收尾）删除。 */
  get(id: SessionId): Promise<Session | undefined>;
  /** @deprecated 仅短期兼容未迁移的 AgentLoop；AgentLoop 迁移到新契约后（B3 收尾）删除。 */
  appendMessages(id: SessionId, messages: Message[]): Promise<void>;
  /** @deprecated 仅短期兼容未迁移的 AgentLoop；AgentLoop 迁移到新契约后（B3 收尾）删除。 */
  getHistory(id: SessionId): Promise<Message[]>;
}
