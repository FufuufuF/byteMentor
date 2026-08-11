import Database from "better-sqlite3";
import { createSessionId } from "@byte-mentor/core";
import type { Message, SessionId, ThinkingLevel } from "@byte-mentor/core";
import type { SessionEntry } from "./entries.js";
import { decodeEntry, encodeEntry, encodeMessagesToEntries, randomEntryId } from "./entry-codec.js";
import {
  SessionLeafConflictError,
  SessionNotFoundError,
  SessionStoreClosedError,
  SessionStoreError,
  type CommitTurnInput,
  type CommitTurnResult,
  type CreateSessionInput,
  type Session,
  type SessionMetadata,
  type SessionSnapshot,
  type SessionStore,
  type SessionStoreErrorKind,
} from "./session-store.js";

export interface SqliteSessionStoreInput {
  dbPath: string;
}

// SQLite SessionStore：实现最终 schema（sessions + session_entries），落实 M3 的连接配置
// 与 M9 的稳定错误归一化。所有 SQLite 原始错误在边界处转换为 SessionStoreError 类别，
// 领域层与上层不解析原始错误字符串。
export class SqliteSessionStore implements SessionStore {
  private readonly db: Database.Database;
  private closed = false;

  constructor(input: SqliteSessionStoreInput) {
    this.db = new Database(input.dbPath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                TEXT    NOT NULL PRIMARY KEY,
        workspace_root    TEXT    NOT NULL,
        initial_provider       TEXT NOT NULL,
        initial_model_id       TEXT NOT NULL,
        initial_thinking_level TEXT NOT NULL CHECK (
          initial_thinking_level IN (
            'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
          )
        ),
        active_leaf_id    TEXT,
        next_entry_seq    INTEGER NOT NULL DEFAULT 1 CHECK (next_entry_seq > 0),
        metadata_json     TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
        created_at        TEXT    NOT NULL,
        updated_at        TEXT    NOT NULL,
        FOREIGN KEY (id, active_leaf_id)
          REFERENCES session_entries(session_id, id)
          DEFERRABLE INITIALLY DEFERRED
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS session_entries (
        session_id   TEXT    NOT NULL,
        id           TEXT    NOT NULL,
        entry_seq    INTEGER NOT NULL CHECK (entry_seq > 0),
        parent_id    TEXT,
        type         TEXT    NOT NULL CHECK (
          type IN (
            'user',
            'assistant',
            'tool_result',
            'compaction',
            'branch_summary',
            'model_change',
            'thinking_level_change'
          )
        ),
        created_at   TEXT    NOT NULL,
        payload_json TEXT    NOT NULL CHECK (json_valid(payload_json)),

        PRIMARY KEY (session_id, id),
        UNIQUE (session_id, entry_seq),

        CHECK (parent_id IS NULL OR parent_id <> id),

        FOREIGN KEY (session_id)
          REFERENCES sessions(id)
          ON DELETE CASCADE,
        FOREIGN KEY (session_id, parent_id)
          REFERENCES session_entries(session_id, id)
          DEFERRABLE INITIALLY DEFERRED
      ) WITHOUT ROWID;
    `);
  }

  // 仅供测试检查连接配置与表结构；生产代码不依赖。
  dbForTest(): Database.Database {
    return this.db;
  }

  async createSession(input: CreateSessionInput): Promise<SessionSnapshot> {
    this.assertOpen();
    const id = createSessionId();
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO sessions (
             id, workspace_root, initial_provider, initial_model_id, initial_thinking_level,
             next_entry_seq, metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 1, '{}', ?, ?)`,
        )
        .run(
          id,
          input.workspaceRoot,
          input.initialProvider,
          input.initialModelId,
          input.initialThinkingLevel,
          now,
          now,
        );
    } catch (error) {
      throw normalizeError(error);
    }
    return this.requireSnapshot(id);
  }

  async loadSession(id: SessionId): Promise<SessionSnapshot | undefined> {
    this.assertOpen();
    const row = this.sessionRow(id);
    if (row === undefined) {
      return undefined;
    }
    return this.buildSnapshot(id, row);
  }

  async getMetadata(id: SessionId): Promise<SessionMetadata> {
    this.assertOpen();
    const row = this.sessionRow(id);
    if (row === undefined) {
      throw new SessionNotFoundError(`session not found: ${id}`);
    }
    return parseMetadata(row.metadata_json);
  }

  async updateMetadata(
    id: SessionId,
    updater: (metadata: SessionMetadata) => SessionMetadata,
  ): Promise<SessionMetadata> {
    this.assertOpen();
    try {
      const metadata = this.db.transaction(() => {
        const row = this.sessionRow(id);
        if (row === undefined) {
          throw new SessionNotFoundError(`session not found: ${id}`);
        }
        const next = { ...updater(parseMetadata(row.metadata_json)) };
        this.db
          .prepare("UPDATE sessions SET metadata_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(next), new Date().toISOString(), id);
        return next;
      })();
      return metadata;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async setRuntimeCheckpoint(id: SessionId, checkpoint: unknown): Promise<SessionMetadata> {
    this.assertOpen();
    try {
      const row = this.db
        .prepare(
          `UPDATE sessions
           SET metadata_json = json_set(metadata_json, '$.runtime_checkpoint', json(:checkpoint_json)),
               updated_at = :now
           WHERE id = :id
           RETURNING metadata_json`,
        )
        .get({ id, checkpoint_json: JSON.stringify(checkpoint), now: new Date().toISOString() }) as
        { metadata_json: string } | undefined;
      if (row === undefined) {
        throw new SessionNotFoundError(`session not found: ${id}`);
      }
      return parseMetadata(row.metadata_json);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        throw error;
      }
      throw normalizeError(error);
    }
  }

  async clearRuntimeCheckpoint(id: SessionId): Promise<SessionMetadata> {
    this.assertOpen();
    try {
      const row = this.db
        .prepare(
          `UPDATE sessions
           SET metadata_json = json_remove(metadata_json, '$.runtime_checkpoint'),
               updated_at = :now
           WHERE id = :id
           RETURNING metadata_json`,
        )
        .get({ id, now: new Date().toISOString() }) as { metadata_json: string } | undefined;
      if (row === undefined) {
        throw new SessionNotFoundError(`session not found: ${id}`);
      }
      return parseMetadata(row.metadata_json);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        throw error;
      }
      throw normalizeError(error);
    }
  }

  async commitTurnEntries(input: CommitTurnInput): Promise<CommitTurnResult> {
    this.assertOpen();
    try {
      return this.db.transaction(() => {
        const row = this.sessionRow(input.sessionId);
        if (row === undefined) {
          throw new SessionNotFoundError(`session not found: ${input.sessionId}`);
        }
        if (input.entries.length === 0) {
          throw new SessionStoreError(
            "constraint",
            "commitTurnEntries requires at least one entry",
          );
        }
        if (row.active_leaf_id !== input.expectedLeafId) {
          throw new SessionLeafConflictError(
            `active leaf changed: expected ${String(input.expectedLeafId)}, got ${String(row.active_leaf_id)}`,
          );
        }
        const now = new Date().toISOString();
        let parentId = row.active_leaf_id;
        let nextSeq = row.next_entry_seq;
        for (const { entry } of input.entries) {
          const materialized = {
            ...entry,
            id: entry.id ?? randomEntryId(),
            sequence: nextSeq,
            parentId,
            createdAt: entry.createdAt ?? now,
          } as SessionEntry;
          const encoded = encodeEntry(materialized);
          this.db
            .prepare(
              `INSERT INTO session_entries
                 (session_id, id, entry_seq, parent_id, type, created_at, payload_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.sessionId,
              encoded.id,
              encoded.entry_seq,
              encoded.parent_id,
              encoded.type,
              encoded.created_at,
              encoded.payload_json,
            );
          parentId = materialized.id;
          nextSeq += 1;
        }
        this.db
          .prepare(
            `UPDATE sessions
             SET active_leaf_id = :leaf,
                 next_entry_seq = :seq,
                 metadata_json = json_remove(metadata_json, '$.runtime_checkpoint'),
                 updated_at = :now
             WHERE id = :id`,
          )
          .run({ leaf: parentId, seq: nextSeq, now, id: input.sessionId });
        // 循环至少执行一次（空批已在前面拒绝），parentId 必为非空 leaf。
        return { activeLeafId: parentId as string, nextEntrySeq: nextSeq };
      })();
    } catch (error) {
      if (error instanceof SessionNotFoundError || error instanceof SessionLeafConflictError) {
        throw error;
      }
      throw normalizeError(error);
    }
  }

  async updateLeaf(id: SessionId, leafId: string | null): Promise<void> {
    this.assertOpen();
    try {
      const result = this.db
        .prepare(`UPDATE sessions SET active_leaf_id = :leaf, updated_at = :now WHERE id = :id`)
        .run({ leaf: leafId, now: new Date().toISOString(), id });
      if (result.changes === 0) {
        throw new SessionNotFoundError(`session not found: ${id}`);
      }
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        throw error;
      }
      throw normalizeError(error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.closed = true;
  }

  // === deprecated 线性适配入口（仅短期兼容未迁移的 AgentLoop；B3 迁移完成后删除） ===

  /** @deprecated 见 SessionStore 契约注释。 */
  async create(): Promise<Session> {
    const snapshot = await this.createSession({
      workspaceRoot: "",
      initialProvider: "",
      initialModelId: "",
      initialThinkingLevel: "off",
    });
    return { id: snapshot.id, metadata: snapshot.metadata };
  }

  /** @deprecated 见 SessionStore 契约注释。 */
  async get(id: SessionId): Promise<Session | undefined> {
    this.assertOpen();
    const row = this.sessionRow(id);
    return row === undefined ? undefined : { id, metadata: parseMetadata(row.metadata_json) };
  }

  /** @deprecated 见 SessionStore 契约注释。 */
  async appendMessages(id: SessionId, messages: Message[]): Promise<void> {
    this.assertOpen();
    try {
      const row = this.sessionRow(id);
      if (row === undefined) {
        throw new SessionNotFoundError(`session not found: ${id}`);
      }
      const newEntries = encodeMessagesToEntries(messages, {
        provider: row.initial_provider,
        modelId: row.initial_model_id,
      });
      this.db.transaction(() => {
        let parentId = row.active_leaf_id;
        for (const entry of newEntries) {
          this.db
            .prepare(
              `INSERT INTO session_entries
                 (session_id, id, entry_seq, parent_id, type, created_at, payload_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              entry.id,
              row.next_entry_seq,
              parentId,
              entry.type,
              entry.createdAt,
              encodeEntry(entry).payload_json,
            );
          parentId = entry.id;
          row.next_entry_seq += 1;
        }
        this.db
          .prepare(
            "UPDATE sessions SET active_leaf_id = ?, next_entry_seq = ?, updated_at = ? WHERE id = ?",
          )
          .run(parentId, row.next_entry_seq, new Date().toISOString(), id);
      })();
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        throw error;
      }
      throw normalizeError(error);
    }
  }

  /** @deprecated 见 SessionStore 契约注释。 */
  async getHistory(id: SessionId): Promise<Message[]> {
    this.assertOpen();
    const snapshot = await this.loadSession(id);
    if (snapshot === undefined) {
      return [];
    }
    return linearHistoryFromSnapshot(snapshot);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SessionStoreClosedError();
    }
  }

  private sessionRow(id: SessionId): SessionRow | undefined {
    return this.db
      .prepare(
        `SELECT id, workspace_root, initial_provider, initial_model_id, initial_thinking_level,
                active_leaf_id, next_entry_seq, metadata_json, created_at, updated_at
         FROM sessions WHERE id = ?`,
      )
      .get(id) as SessionRow | undefined;
  }

  private requireSnapshot(id: SessionId, row = this.sessionRow(id)): SessionSnapshot {
    if (row === undefined) {
      throw new SessionNotFoundError(`session not found: ${id}`);
    }
    return this.buildSnapshot(id, row);
  }

  private buildSnapshot(id: SessionId, row: SessionRow): SessionSnapshot {
    const rows = this.db
      .prepare(
        `SELECT id, entry_seq, parent_id, type, created_at, payload_json
         FROM session_entries WHERE session_id = ? ORDER BY entry_seq ASC`,
      )
      .all(id) as SessionEntryRow[];
    return {
      id,
      workspaceRoot: row.workspace_root,
      initialProvider: row.initial_provider,
      initialModelId: row.initial_model_id,
      initialThinkingLevel: row.initial_thinking_level,
      activeLeafId: row.active_leaf_id,
      nextEntrySeq: row.next_entry_seq,
      metadata: parseMetadata(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      entries: rows.map((r) => decodeEntry(r)),
    };
  }
}

interface SessionRow {
  id: SessionId;
  workspace_root: string;
  initial_provider: string;
  initial_model_id: string;
  initial_thinking_level: ThinkingLevel;
  active_leaf_id: string | null;
  next_entry_seq: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface SessionEntryRow {
  id: string;
  entry_seq: number;
  parent_id: string | null;
  type: SessionEntry["type"];
  created_at: string;
  payload_json: string;
}

function parseMetadata(json: string): SessionMetadata {
  const value = JSON.parse(json) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionStoreError("corruption", "session metadata_json must contain an object");
  }
  return { ...(value as SessionMetadata) };
}

// deprecated getHistory 的线性重建：按 entry_seq 升序收集 user/assistant/tool_result，
// 忽略状态与摘要 Entry（与旧线性历史语义一致）。
function linearHistoryFromSnapshot(snapshot: SessionSnapshot): Message[] {
  const messages: Message[] = [];
  for (const entry of snapshot.entries) {
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

// 把 SQLite 原始错误归一化为 M9 稳定类别；unknown 类别保留原错误信息供诊断。
function normalizeError(error: unknown): SessionStoreError {
  if (error instanceof SessionStoreError) {
    return error;
  }
  const kind = classifySqliteError(error);
  return new SessionStoreError(kind, error instanceof Error ? error.message : String(error));
}

function classifySqliteError(error: unknown): SessionStoreErrorKind {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code.startsWith("SQLITE_BUSY")) {
      return "busy";
    }
    if (code.startsWith("SQLITE_FULL")) {
      return "capacity";
    }
    if (code.startsWith("SQLITE_READONLY")) {
      return "read_only";
    }
    if (code.startsWith("SQLITE_CORRUPT")) {
      return "corruption";
    }
    if (code.startsWith("SQLITE_CONSTRAINT")) {
      return "constraint";
    }
    if (
      code.startsWith("SQLITE_IOERR") ||
      code.startsWith("SQLITE_CANTOPEN") ||
      code.startsWith("SQLITE_NOMEM") ||
      code.startsWith("SQLITE_INTERRUPT")
    ) {
      return "io";
    }
  }
  return "unknown";
}
