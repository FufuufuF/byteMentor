import Database from "better-sqlite3";
import { createSessionId } from "@byte-mentor/core";
import type { Message, SessionId } from "@byte-mentor/core";
import {
  SessionStoreClosedError,
  type Session,
  type SessionMetadata,
  type SessionStore,
} from "./session-store.js";

export interface SqliteSessionStoreInput {
  dbPath: string;
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: Database.Database;
  private closed = false;

  constructor(input: SqliteSessionStoreInput) {
    this.db = new Database(input.dbPath);
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT NOT NULL PRIMARY KEY,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS messages (
        session_id   TEXT    NOT NULL,
        seq          INTEGER NOT NULL,
        role         TEXT    NOT NULL,
        message_json TEXT    NOT NULL,
        created_at   TEXT    NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      ) WITHOUT ROWID;
    `);
  }

  async create(): Promise<Session> {
    this.assertOpen();
    const id = createSessionId();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id, created_at, updated_at, metadata_json) VALUES (?, ?, ?, '{}')",
      )
      .run(id, now, now);
    return { id, metadata: {} };
  }

  async get(id: SessionId): Promise<Session | undefined> {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT id, metadata_json FROM sessions WHERE id = ?")
      .get(id) as { id: SessionId; metadata_json: string } | undefined;
    return row === undefined
      ? undefined
      : { id: row.id, metadata: parseMetadata(row.metadata_json) };
  }

  async appendMessages(id: SessionId, messages: Message[]): Promise<void> {
    this.assertOpen();
    const now = new Date().toISOString();
    const insertMessage = this.db.prepare(`
      INSERT INTO messages (session_id, seq, role, message_json, created_at)
      SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?
      FROM messages WHERE session_id = ?
    `);
    const updateSession = this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?");
    const append = this.db.transaction(() => {
      for (const message of messages) {
        insertMessage.run(id, message.role, JSON.stringify(message), now, id);
      }
      updateSession.run(now, id);
    });
    append();
  }

  async getHistory(id: SessionId): Promise<Message[]> {
    this.assertOpen();
    const rows = this.db
      .prepare("SELECT message_json FROM messages WHERE session_id = ? ORDER BY seq ASC")
      .all(id) as { message_json: string }[];
    return rows.map((row) => JSON.parse(row.message_json) as Message);
  }

  async updateMetadata(
    id: SessionId,
    updater: (metadata: SessionMetadata) => SessionMetadata,
  ): Promise<SessionMetadata> {
    this.assertOpen();
    const update = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT metadata_json FROM sessions WHERE id = ?")
        .get(id) as { metadata_json: string } | undefined;
      if (row === undefined) {
        throw new Error(`session not found: ${id}`);
      }
      const metadata = { ...updater(parseMetadata(row.metadata_json)) };
      this.db
        .prepare("UPDATE sessions SET metadata_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(metadata), new Date().toISOString(), id);
      return metadata;
    });
    return update();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SessionStoreClosedError();
    }
  }
}

function parseMetadata(json: string): SessionMetadata {
  const value = JSON.parse(json) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("session metadata_json must contain an object");
  }
  return { ...(value as SessionMetadata) };
}
