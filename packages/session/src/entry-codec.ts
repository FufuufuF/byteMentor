import type { Message, ToolCall, ToolCallId } from "@byte-mentor/core";
import type { EntryId, SessionEntry } from "./entries.js";

// SessionEntry 与 SQLite 行的编解码：公共字段映射到固定列，具体 Entry 独有字段
// 序列化进 payload_json；不重复保存公共字段，也不在 payload 中携带 sessionId。

// SQLite 行形态：与 session_entries 表列一一对应（session_id 由调用方注入）。
export interface SessionEntryRow {
  id: EntryId;
  entry_seq: number;
  parent_id: string | null;
  type: SessionEntry["type"];
  created_at: string;
  payload_json: string;
}

// 把领域 Entry 编码为 SQLite 行；公共字段（id/sequence/parentId/createdAt/type）抽到列，
// 其余字段整体进入 payload_json。
export function encodeEntry(entry: SessionEntry): Omit<SessionEntryRow, "session_id"> {
  const { id, sequence, parentId, createdAt, type, ...payload } = entry;
  return {
    id,
    entry_seq: sequence,
    parent_id: parentId,
    type,
    created_at: createdAt,
    payload_json: JSON.stringify(payload),
  };
}

// 把 SQLite 行解码回领域 Entry；payload 解析失败或类型不匹配属于数据损坏，抛出明确错误。
export function decodeEntry(row: SessionEntryRow): SessionEntry {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  switch (row.type) {
    case "user":
      return {
        id: row.id,
        sequence: row.entry_seq,
        parentId: row.parent_id,
        createdAt: row.created_at,
        type: "user" as const,
        content: payload.content as string,
      };
    case "assistant":
      return {
        id: row.id,
        sequence: row.entry_seq,
        parentId: row.parent_id,
        createdAt: row.created_at,
        type: "assistant" as const,
        content: payload.content as string,
        toolCalls: (payload.toolCalls as ToolCall[] | undefined) ?? [],
        model: payload.model as SessionEntryExtract<"assistant">["model"],
        stopReason: payload.stopReason as SessionEntryExtract<"assistant">["stopReason"],
        usage: payload.usage as SessionEntryExtract<"assistant">["usage"],
      };
    case "tool_result":
      return {
        id: row.id,
        sequence: row.entry_seq,
        parentId: row.parent_id,
        createdAt: row.created_at,
        type: "tool_result" as const,
        toolCallId: payload.toolCallId as ToolCallId,
        toolName: payload.toolName as string,
        content: payload.content as string,
        isError: payload.isError as boolean,
      };
    case "model_change":
      return {
        id: row.id,
        sequence: row.entry_seq,
        parentId: row.parent_id,
        createdAt: row.created_at,
        type: "model_change" as const,
        model: payload.model as SessionEntryExtract<"model_change">["model"],
      };
    case "thinking_level_change":
      return {
        id: row.id,
        sequence: row.entry_seq,
        parentId: row.parent_id,
        createdAt: row.created_at,
        type: "thinking_level_change" as const,
        level: payload.level as SessionEntryExtract<"thinking_level_change">["level"],
      };
    case "compaction":
      return {
        id: row.id,
        sequence: row.entry_seq,
        parentId: row.parent_id,
        createdAt: row.created_at,
        type: "compaction" as const,
        summary: payload.summary as string,
        firstKeptEntryId: (payload.firstKeptEntryId as string | null) ?? null,
        tokensBefore: payload.tokensBefore as number,
        trigger: payload.trigger as SessionEntryExtract<"compaction">["trigger"],
        model: payload.model as SessionEntryExtract<"compaction">["model"],
        usage: payload.usage as SessionEntryExtract<"compaction">["usage"],
      };
    case "branch_summary":
      return {
        id: row.id,
        sequence: row.entry_seq,
        parentId: row.parent_id,
        createdAt: row.created_at,
        type: "branch_summary" as const,
        sourceLeafId: (payload.sourceLeafId as string | null) ?? null,
        summary: payload.summary as string,
        model: payload.model as SessionEntryExtract<"branch_summary">["model"],
        usage: payload.usage as SessionEntryExtract<"branch_summary">["usage"],
      };
  }
}

// 从 SessionEntry union 中按 discriminator 提取具体类型（供解码时安全断言 payload 字段）。
type SessionEntryExtract<T extends SessionEntry["type"]> = Extract<SessionEntry, { type: T }>;

// deprecated 线性适配：把统一 Message 映射为待追加的领域 Entry 链。
// User 消息映射为 UserEntry；Assistant 消息映射为 AssistantEntry（content 缺失时为空串，
// model 用会话初始模型、stopReason 按有无 toolCalls 推断）；Tool 消息映射为 ToolResultEntry，
// toolName 从最近的 assistant 消息的对应 tool call 解析，缺失时为 ""。
export interface PendingEntry {
  entry: SessionEntry;
  toolCallId?: ToolCallId;
}

export function encodeMessagesToEntries(
  messages: readonly Message[],
  initialModel: { provider: string; modelId: string },
): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let lastAssistantToolCalls: ToolCall[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const entry: SessionEntry = {
        id: message.id ?? randomEntryId(),
        sequence: 0, // 由调用方分配
        parentId: null, // 由调用方连接
        createdAt: new Date().toISOString(),
        type: "user",
        content: message.content,
      };
      entries.push(entry);
    } else if (message.role === "assistant") {
      const toolCalls = message.toolCalls ?? [];
      lastAssistantToolCalls = toolCalls;
      const entry: SessionEntry = {
        id: message.id ?? randomEntryId(),
        sequence: 0,
        parentId: null,
        createdAt: new Date().toISOString(),
        type: "assistant",
        content: message.content ?? "",
        toolCalls,
        model: initialModel,
        stopReason: toolCalls.length > 0 ? "tool_calls" : "completed",
      };
      entries.push(entry);
    } else {
      const call = lastAssistantToolCalls.find((c) => c.id === message.toolCallId);
      const entry: SessionEntry = {
        id: message.id ?? randomEntryId(),
        sequence: 0,
        parentId: null,
        createdAt: new Date().toISOString(),
        type: "tool_result",
        toolCallId: message.toolCallId,
        toolName: call?.name ?? "",
        content: message.content,
        isError: false,
      };
      entries.push(entry);
    }
  }
  return entries;
}

// 生成 session 内唯一的 Entry ID（UUID 文本）。
export function randomEntryId(): EntryId {
  return crypto.randomUUID();
}
