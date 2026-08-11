import type {
  ModelRef,
  StopReason,
  ThinkingLevel,
  TokenUsage,
  ToolCall,
  ToolCallId,
} from "@byte-mentor/core";

// Session Entry 领域模型（M2）：纯持久化数据，不带行为。sessionId 不进入领域 Entry，
// 由 SessionStore 在读写 API 与 SQLite 行上负责 session 归属。

// entry 在 session 内使用的稳定 ID；新数据使用 UUID。Entry ID 同时是 user/assistant/tool-result
// 消息的身份，不再额外保存 messageId，避免两个 ID 漂移。
export type EntryId = string;

// session 内严格递增的追加顺序，用于稳定排序与审计；不表达 parent 关系。
export type EntrySequence = number;

// 所有持久化 entry 的共同基础字段。id/sequence 在 session 内唯一；createdAt 只用于展示，
// 不承担排序正确性；parentId 指向对话树中的父节点，根 entry 为 null。
export interface BaseEntry {
  id: EntryId;
  sequence: EntrySequence;
  parentId: EntryId | null;
  createdAt: string;
}

// /fork 唯一可选类型。Tree 选中它时，实际导航目标是 parentId，content 回填编辑器作为草稿。
export interface UserEntry extends BaseEntry {
  type: "user";
  content: string;
}

// 一条模型回复。content 与 toolCalls 使用必填空值（""/[]），避免持久化后区分 missing 与 empty；
// model 记录该回复实际使用的模型，不依赖当前活动 model 状态反推。
export interface AssistantEntry extends BaseEntry {
  type: "assistant";
  content: string;
  toolCalls: ToolCall[];
  model: ModelRef;
  stopReason: StopReason;
  usage?: TokenUsage;
}

// 一条工具执行结果，独立树节点。toolCallId 必须能在活动祖先路径中找到对应的
// AssistantEntry.toolCalls[].id；同一 assistant 的多个结果按持久化顺序串在路径上。
export interface ToolResultEntry extends BaseEntry {
  type: "tool_result";
  toolCallId: ToolCallId;
  toolName: string;
  content: string;
  isError: boolean;
}

// 表示从该节点之后使用的新模型。不转成 provider message；沿活动路径扫描最后一个生效。
export interface ModelChangeEntry extends BaseEntry {
  type: "model_change";
  model: ModelRef;
}

// 表示从该节点之后使用的新 thinking level。不转成 provider message；沿活动路径扫描最后一个生效。
export interface ThinkingLevelChangeEntry extends BaseEntry {
  type: "thinking_level_change";
  level: ThinkingLevel;
}

// 上下文压缩节点。parentId 是压缩发生时的 active leaf；firstKeptEntryId 指向压缩后仍以原文
// 保留的最早 entry（null 表示不保留旧原文尾部）；tokensBefore 是压缩前上下文 token 数；
// model/usage 记录摘要实际由哪个模型、以多少 token 生成。
export interface CompactionEntry extends BaseEntry {
  type: "compaction";
  summary: string;
  firstKeptEntryId: EntryId | null;
  tokensBefore: number;
  trigger: "manual" | "automatic";
  model: ModelRef;
  usage?: TokenUsage;
}

// 带摘要导航节点。parentId 是导航目标位置；sourceLeafId 通常是导航前旧分支的 active leaf，
// fork 到独立 session 且 source leaf 不在复制路径中时置为 null，摘要文本仍然有效。
export interface BranchSummaryEntry extends BaseEntry {
  type: "branch_summary";
  sourceLeafId: EntryId | null;
  summary: string;
  model: ModelRef;
  usage?: TokenUsage;
}

// 七种持久化 entry 的并集；entry 一经提交不可修改、不可删除。
export type SessionEntry =
  | UserEntry
  | AssistantEntry
  | ToolResultEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry;
