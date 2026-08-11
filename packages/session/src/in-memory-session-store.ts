import type { Message, SessionId, ThinkingLevel } from "@byte-mentor/core";
import { createSessionId } from "@byte-mentor/core";
import type { SessionEntry } from "./entries.js";
import { encodeMessagesToEntries, randomEntryId } from "./entry-codec.js";
import {
  SessionLeafConflictError,
  SessionNotFoundError,
  SessionStoreError,
  type CommitTurnInput,
  type CommitTurnResult,
  type CreateSessionInput,
  type Session,
  type SessionMetadata,
  type SessionSnapshot,
  type SessionStore,
} from "./session-store.js";

// 每个 Session 的领域状态：初始状态、活动分支、追加序号、metadata 与全量 Entry 树。
interface InMemorySessionRecord {
  workspaceRoot: string;
  initialProvider: string;
  initialModelId: string;
  initialThinkingLevel: ThinkingLevel;
  activeLeafId: string | null;
  nextEntrySeq: number;
  metadata: SessionMetadata;
  createdAt: string;
  updatedAt: string;
  entries: SessionEntry[];
}

// InMemory SessionStore：与 SQLite 实现共享同一领域契约（见 store-contract 测试），
// 数据只存活于进程内，close 后仍可用（与 SQLite 的 close 语义不同，由契约用例覆盖）。
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<SessionId, InMemorySessionRecord>();

  async createSession(input: CreateSessionInput): Promise<SessionSnapshot> {
    const id = createSessionId();
    const now = new Date().toISOString();
    const record: InMemorySessionRecord = {
      workspaceRoot: input.workspaceRoot,
      initialProvider: input.initialProvider,
      initialModelId: input.initialModelId,
      initialThinkingLevel: input.initialThinkingLevel,
      activeLeafId: null,
      nextEntrySeq: 1,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      entries: [],
    };
    this.sessions.set(id, record);
    return toSnapshot(id, record);
  }

  async loadSession(id: SessionId): Promise<SessionSnapshot | undefined> {
    const record = this.sessions.get(id);
    return record === undefined ? undefined : toSnapshot(id, record);
  }

  async getMetadata(id: SessionId): Promise<SessionMetadata> {
    const record = this.requireSession(id);
    return { ...record.metadata };
  }

  async updateMetadata(
    id: SessionId,
    updater: (metadata: SessionMetadata) => SessionMetadata,
  ): Promise<SessionMetadata> {
    const record = this.requireSession(id);
    const metadata = { ...updater({ ...record.metadata }) };
    record.metadata = metadata;
    record.updatedAt = new Date().toISOString();
    return { ...metadata };
  }

  async setRuntimeCheckpoint(id: SessionId, checkpoint: unknown): Promise<SessionMetadata> {
    const record = this.requireSession(id);
    record.metadata = { ...record.metadata, runtime_checkpoint: checkpoint };
    record.updatedAt = new Date().toISOString();
    return { ...record.metadata };
  }

  async clearRuntimeCheckpoint(id: SessionId): Promise<SessionMetadata> {
    const record = this.requireSession(id);
    const { runtime_checkpoint: _removed, ...rest } = record.metadata;
    record.metadata = rest;
    record.updatedAt = new Date().toISOString();
    return { ...record.metadata };
  }

  async commitTurnEntries(input: CommitTurnInput): Promise<CommitTurnResult> {
    const record = this.requireSession(input.sessionId);
    if (input.entries.length === 0) {
      throw new SessionStoreError("constraint", "commitTurnEntries requires at least one entry");
    }
    if (record.activeLeafId !== input.expectedLeafId) {
      throw new SessionLeafConflictError(
        `active leaf changed: expected ${String(input.expectedLeafId)}, got ${String(record.activeLeafId)}`,
      );
    }
    const now = new Date().toISOString();
    let parentId = record.activeLeafId;
    for (const { entry } of input.entries) {
      const materialized: SessionEntry = {
        ...entry,
        id: entry.id ?? randomEntryId(),
        sequence: record.nextEntrySeq,
        parentId,
        createdAt: entry.createdAt ?? now,
      } as SessionEntry;
      record.entries.push(materialized);
      parentId = materialized.id;
      record.nextEntrySeq += 1;
    }
    record.activeLeafId = parentId;
    delete record.metadata.runtime_checkpoint;
    record.updatedAt = now;
    // 循环至少执行一次（空批已在前面拒绝），parentId 必为非空 leaf。
    return { activeLeafId: parentId as string, nextEntrySeq: record.nextEntrySeq };
  }

  async close(): Promise<void> {}

  // === deprecated 线性适配入口（仅短期兼容未迁移的 AgentLoop；B3 迁移完成后删除） ===

  /** @deprecated 见 SessionStore 契约注释。 */
  async create(): Promise<Session> {
    const snapshot = await this.createSession(emptyCreateInput());
    return { id: snapshot.id, metadata: snapshot.metadata };
  }

  /** @deprecated 见 SessionStore 契约注释。 */
  async get(id: SessionId): Promise<Session | undefined> {
    const record = this.sessions.get(id);
    return record === undefined ? undefined : { id, metadata: { ...record.metadata } };
  }

  /** @deprecated 见 SessionStore 契约注释。 */
  async appendMessages(id: SessionId, messages: Message[]): Promise<void> {
    const record = this.requireSession(id);
    const base = { provider: record.initialProvider, modelId: record.initialModelId };
    const newEntries = encodeMessagesToEntries(messages, base);
    let parentId = record.activeLeafId;
    for (const entry of newEntries) {
      record.entries.push({ ...entry, sequence: record.nextEntrySeq, parentId });
      parentId = entry.id;
      record.nextEntrySeq += 1;
    }
    record.activeLeafId = parentId;
    record.updatedAt = new Date().toISOString();
  }

  /** @deprecated 见 SessionStore 契约注释。 */
  async getHistory(id: SessionId): Promise<Message[]> {
    const record = this.sessions.get(id);
    if (record === undefined) {
      return [];
    }
    return historyFromEntries(record.entries, record.activeLeafId);
  }

  private requireSession(id: SessionId): InMemorySessionRecord {
    const record = this.sessions.get(id);
    if (record === undefined) {
      throw new SessionNotFoundError(`session not found: ${id}`);
    }
    return record;
  }
}

// 生成 snapshot 时深拷贝 entries 与 metadata，避免调用方修改内部状态。
function toSnapshot(id: SessionId, record: InMemorySessionRecord): SessionSnapshot {
  return {
    id,
    workspaceRoot: record.workspaceRoot,
    initialProvider: record.initialProvider,
    initialModelId: record.initialModelId,
    initialThinkingLevel: record.initialThinkingLevel,
    activeLeafId: record.activeLeafId,
    nextEntrySeq: record.nextEntrySeq,
    metadata: { ...record.metadata },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    entries: record.entries.map((entry) => ({ ...entry })),
  };
}

// deprecated create() 无参数时的占位初始状态；仅服务未迁移消费者，不构成新能力基础。
function emptyCreateInput(): CreateSessionInput {
  return {
    workspaceRoot: "",
    initialProvider: "",
    initialModelId: "",
    initialThinkingLevel: "off",
  };
}

// deprecated getHistory：从 active leaf 沿 parent 链反向收集，再反转为根到 leaf 的线性消息。
function historyFromEntries(entries: SessionEntry[], leafId: string | null): Message[] {
  if (leafId === null) {
    return [];
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain: SessionEntry[] = [];
  let cursor: SessionEntry | undefined = byId.get(leafId);
  while (cursor !== undefined) {
    chain.push(cursor);
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  chain.reverse();
  const messages: Message[] = [];
  for (const entry of chain) {
    if (entry.type === "user") {
      messages.push({ id: entry.id as Message["id"], role: "user", content: entry.content });
    } else if (entry.type === "assistant") {
      messages.push({
        id: entry.id as Message["id"],
        role: "assistant",
        content: entry.content,
        ...(entry.toolCalls.length > 0 ? { toolCalls: entry.toolCalls } : {}),
      });
    } else if (entry.type === "tool_result") {
      messages.push({
        id: entry.id as Message["id"],
        role: "tool",
        toolCallId: entry.toolCallId,
        content: entry.content,
      });
    }
  }
  return messages;
}
