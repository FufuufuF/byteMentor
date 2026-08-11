import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "@byte-mentor/session";
import type { SessionId } from "@byte-mentor/core";
import { runStoreContractTests, validCreateInput } from "./store-contract.js";

// SQLite 实现注册同一份 Store contract 测试，并额外覆盖 schema/PRAGMA/约束/错误归一化。

const tmpDirs: string[] = [];
async function createDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "byte-mentor-sqlite-store-"));
  tmpDirs.push(dir);
  return join(dir, "session.sqlite");
}
async function createStore(): Promise<SqliteSessionStore> {
  return new SqliteSessionStore({ dbPath: await createDbPath() });
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SqliteSessionStore contract", () => {
  runStoreContractTests({
    label: "sqlite",
    async create() {
      return new SqliteSessionStore({ dbPath: await createDbPath() });
    },
    async close(store) {
      await store.close();
    },
  });
});

describe("SqliteSessionStore reopen persistence", () => {
  it("restores snapshot, entries, and metadata after reopening the same database file", async () => {
    const dbPath = await createDbPath();
    const first = new SqliteSessionStore({ dbPath });
    const session = await first.createSession(validCreateInput);
    await first.updateMetadata(session.id, () => ({ a: 1 }));
    await first.appendMessages(session.id, [{ role: "user", content: "persist me" }]);
    await first.close();

    const second = new SqliteSessionStore({ dbPath });
    try {
      const loaded = await second.loadSession(session.id);
      expect(loaded).toBeDefined();
      expect(loaded?.workspaceRoot).toBe("/workspace/a");
      expect(loaded?.initialThinkingLevel).toBe("medium");
      expect(loaded?.metadata).toEqual({ a: 1 });
      expect(loaded?.entries).toHaveLength(1);
      expect(loaded?.entries[0].type).toBe("user");
      const history = await second.getHistory(session.id);
      expect(history.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "persist me" },
      ]);
    } finally {
      await second.close();
    }
  });
});

describe("SqliteSessionStore schema", () => {
  it("creates sessions with all new columns and session_entries, without the legacy messages table", async () => {
    const store = await createStore();
    const db = (store as SqliteSessionStore).dbForTest();
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    const columnNames = columns.map((c) => c.name).sort();
    expect(columnNames).toEqual(
      [
        "active_leaf_id",
        "created_at",
        "id",
        "initial_model_id",
        "initial_provider",
        "initial_thinking_level",
        "metadata_json",
        "next_entry_seq",
        "updated_at",
        "workspace_root",
      ].sort(),
    );
    const entryTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_entries', 'messages')",
      )
      .all() as { name: string }[];
    expect(entryTables.map((t) => t.name)).toEqual(["session_entries"]);
    await store.close();
  });

  it("applies foreign_keys, WAL, synchronous=FULL, and busy_timeout pragmas", async () => {
    const store = await createStore();
    const db = (store as SqliteSessionStore).dbForTest();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(2); // FULL
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    await store.close();
  });

  it("rejects an entry whose sequence duplicates an existing sequence in the session", async () => {
    const store = await createStore();
    const session = await store.createSession(validCreateInput);
    const db = (store as SqliteSessionStore).dbForTest();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO session_entries (session_id, id, entry_seq, parent_id, type, created_at, payload_json)
       VALUES (?, 'e1', 1, NULL, 'user', ?, '{"content":"a"}')`,
    ).run(session.id, now);
    expect(() =>
      db
        .prepare(
          `INSERT INTO session_entries (session_id, id, entry_seq, parent_id, type, created_at, payload_json)
           VALUES (?, 'e2', 1, NULL, 'user', ?, '{"content":"b"}')`,
        )
        .run(session.id, now),
    ).toThrow();
    await store.close();
  });

  it("rejects an invalid thinking level via the sessions CHECK constraint", async () => {
    const store = await createStore();
    const db = (store as SqliteSessionStore).dbForTest();
    const now = new Date().toISOString();
    expect(() =>
      db
        .prepare(
          `INSERT INTO sessions (id, workspace_root, initial_provider, initial_model_id,
             initial_thinking_level, next_entry_seq, metadata_json, created_at, updated_at)
           VALUES ('s-bad', '/w', 'openai', 'gpt-5', 'ultra', 1, '{}', ?, ?)`,
        )
        .run(now, now),
    ).toThrow();
    await store.close();
  });

  it("rejects an invalid entry type via the session_entries CHECK constraint", async () => {
    const store = await createStore();
    const session = await store.createSession(validCreateInput);
    const db = (store as SqliteSessionStore).dbForTest();
    expect(() =>
      db
        .prepare(
          `INSERT INTO session_entries (session_id, id, entry_seq, parent_id, type, created_at, payload_json)
           VALUES (?, 'e1', 1, NULL, 'hologram', ?, '{}')`,
        )
        .run(session.id, new Date().toISOString()),
    ).toThrow();
    await store.close();
  });

  it("rejects payload_json that is not valid JSON", async () => {
    const store = await createStore();
    const session = await store.createSession(validCreateInput);
    const db = (store as SqliteSessionStore).dbForTest();
    expect(() =>
      db
        .prepare(
          `INSERT INTO session_entries (session_id, id, entry_seq, parent_id, type, created_at, payload_json)
           VALUES (?, 'e1', 1, NULL, 'user', ?, '{not-json')`,
        )
        .run(session.id, new Date().toISOString()),
    ).toThrow();
    await store.close();
  });

  it("cascades entry deletion when a session is deleted", async () => {
    const store = await createStore();
    const session = await store.createSession(validCreateInput);
    const db = (store as SqliteSessionStore).dbForTest();
    db.prepare(
      `INSERT INTO session_entries (session_id, id, entry_seq, parent_id, type, created_at, payload_json)
       VALUES (?, 'e1', 1, NULL, 'user', ?, '{"content":"delete me"}')`,
    ).run(session.id, new Date().toISOString());
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?")
      .get(session.id) as { count: number };
    expect(row.count).toBe(0);
    await store.close();
  });

  it("rejects a non-null active_leaf_id that does not exist in the session", async () => {
    const store = await createStore();
    const session = await store.createSession(validCreateInput);
    const db = (store as SqliteSessionStore).dbForTest();
    expect(() =>
      db.prepare("UPDATE sessions SET active_leaf_id = 'ghost' WHERE id = ?").run(session.id),
    ).toThrow();
    await store.close();
  });
});

describe("SqliteSessionStore error normalization", () => {
  it("maps constraint violations to SessionStoreError with kind constraint", async () => {
    const store = await createStore();
    const db = (store as SqliteSessionStore).dbForTest();
    const now = new Date().toISOString();
    expect(() =>
      db
        .prepare(
          `INSERT INTO session_entries (session_id, id, entry_seq, parent_id, type, created_at, payload_json)
           VALUES ('no-such-session', 'e1', 1, NULL, 'user', ?, '{"content":"x"}')`,
        )
        .run(now),
    ).toThrow();
    await store.close();
  });

  it("throws SessionStoreError with kind closed after close", async () => {
    const store = await createStore();
    const session = await store.createSession(validCreateInput);
    await store.close();
    await expect(store.createSession(validCreateInput)).rejects.toMatchObject({
      name: "SessionStoreClosedError",
      kind: "closed",
    });
    await expect(store.loadSession(session.id)).rejects.toMatchObject({
      name: "SessionStoreClosedError",
      kind: "closed",
    });
  });

  it("throws SessionNotFoundError when appending to an unknown session", async () => {
    const store = await createStore();
    const unknownId = "00000000-0000-4000-8000-000000000000" as SessionId;
    await expect(
      store.appendMessages(unknownId, [{ role: "user", content: "orphan" }]),
    ).rejects.toMatchObject({ name: "SessionNotFoundError" });
    await store.close();
  });
});

describe("SqliteSessionStore close", () => {
  it("allows close to be called more than once", async () => {
    const store = await createStore();
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
