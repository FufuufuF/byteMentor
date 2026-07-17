import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "@byte-mentor/session";

interface RawStatement {
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
}

interface RawDatabase {
  prepare(sql: string): RawStatement;
  pragma(sql: string): unknown;
  close(): void;
}

const requireFromSession = createRequire(
  new URL("../../packages/session/package.json", import.meta.url),
);
const RawDatabase = requireFromSession("better-sqlite3") as new (dbPath: string) => RawDatabase;

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

describe("SqliteSessionStore create", () => {
  it("returns a retrievable session", async () => {
    const store = await createStore();

    const session = await store.create();

    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);
    await expect(store.get(session.id)).resolves.toEqual(session);
  });

  it("returns undefined for an unknown sessionId", async () => {
    const store = await createStore();
    const unknownId = "00000000-0000-4000-8000-000000000000" as never;

    await expect(store.get(unknownId)).resolves.toBeUndefined();
  });
});

describe("SqliteSessionStore history", () => {
  it("appends messages preserving order across calls", async () => {
    const store = await createStore();
    const session = await store.create();
    const first = { role: "user" as const, content: "q1" };
    const second = { role: "assistant" as const, content: "a1" };
    const third = { role: "user" as const, content: "q2" };

    await store.appendMessages(session.id, [first]);
    await store.appendMessages(session.id, [second, third]);

    await expect(store.getHistory(session.id)).resolves.toEqual([first, second, third]);
  });

  it("returns an empty history for an unknown sessionId", async () => {
    const store = await createStore();
    const unknownId = "00000000-0000-4000-8000-000000000000" as never;

    await expect(store.getHistory(unknownId)).resolves.toEqual([]);
  });

  it("restores appended history after reopening the same database file", async () => {
    const dbPath = await createDbPath();
    const firstStore = new SqliteSessionStore({ dbPath });
    const session = await firstStore.create();
    const message = { role: "user" as const, content: "persist me" };
    await firstStore.appendMessages(session.id, [message]);
    await firstStore.close();

    const secondStore = new SqliteSessionStore({ dbPath });

    await expect(secondStore.get(session.id)).resolves.toEqual(session);
    await expect(secondStore.getHistory(session.id)).resolves.toEqual([message]);
    await secondStore.close();
  });

  it("allows close to be called more than once", async () => {
    const store = await createStore();

    await store.close();

    await expect(store.close()).resolves.toBeUndefined();
  });

  it("rejects create after close with SessionStoreClosedError", async () => {
    const store = await createStore();

    await store.close();

    await expect(store.create()).rejects.toMatchObject({
      name: "SessionStoreClosedError",
    });
  });

  it("rejects get after close with SessionStoreClosedError", async () => {
    const store = await createStore();
    const session = await store.create();

    await store.close();

    await expect(store.get(session.id)).rejects.toMatchObject({
      name: "SessionStoreClosedError",
    });
  });

  it("rejects appendMessages after close with SessionStoreClosedError", async () => {
    const store = await createStore();
    const session = await store.create();

    await store.close();

    await expect(
      store.appendMessages(session.id, [{ role: "user", content: "after close" }]),
    ).rejects.toMatchObject({
      name: "SessionStoreClosedError",
    });
  });

  it("rejects getHistory after close with SessionStoreClosedError", async () => {
    const store = await createStore();
    const session = await store.create();

    await store.close();

    await expect(store.getHistory(session.id)).rejects.toMatchObject({
      name: "SessionStoreClosedError",
    });
  });
});

describe("SqliteSessionStore schema constraints", () => {
  it("rejects messages for an unknown sessionId", async () => {
    const store = await createStore();
    const unknownId = "00000000-0000-4000-8000-000000000000" as never;

    await expect(
      store.appendMessages(unknownId, [{ role: "user", content: "orphan" }]),
    ).rejects.toThrow();
  });

  it("cascades messages when a session is deleted", async () => {
    const dbPath = await createDbPath();
    const store = new SqliteSessionStore({ dbPath });
    const session = await store.create();
    await store.appendMessages(session.id, [{ role: "user", content: "delete me" }]);
    await store.close();
    const db = new RawDatabase(dbPath);
    db.pragma("foreign_keys = ON");

    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?")
      .get(session.id) as { count: number };

    expect(row.count).toBe(0);
    db.close();
  });

  it("rejects duplicate message sequence numbers within a session", async () => {
    const dbPath = await createDbPath();
    const store = new SqliteSessionStore({ dbPath });
    const session = await store.create();
    await store.appendMessages(session.id, [{ role: "user", content: "first" }]);
    await store.close();
    const db = new RawDatabase(dbPath);

    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (session_id, seq, role, message_json, created_at) VALUES (?, 1, ?, ?, ?)",
        )
        .run(
          session.id,
          "user",
          JSON.stringify({ role: "user", content: "duplicate" }),
          new Date().toISOString(),
        ),
    ).toThrow();
    db.close();
  });
});
