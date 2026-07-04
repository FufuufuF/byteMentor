import { describe, expect, it } from "vitest";
import { InMemorySessionStore, type SessionStore } from "@byte-mentor/session";
import type { SessionId } from "@byte-mentor/core";

describe("InMemorySessionStore create", () => {
  it("create returns a Session with a unique non-empty id", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create();
    expect(session).toBeDefined();
    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);
  });

  it("create returns a Promise<Session>", async () => {
    const store = new InMemorySessionStore();
    const result = store.create();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it("each create returns a session with a distinct id", async () => {
    const store = new InMemorySessionStore();
    const a = await store.create();
    const b = await store.create();
    expect(a.id).not.toBe(b.id);
  });
});

describe("InMemorySessionStore get", () => {
  it("get returns the Session previously created by create", async () => {
    const store = new InMemorySessionStore();
    const created = await store.create();
    const fetched = await store.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(created.id);
  });

  it("get returns undefined for an unknown sessionId", async () => {
    const store = new InMemorySessionStore();
    const unknownId = "00000000-0000-4000-8000-000000000000" as SessionId;
    const fetched = await store.get(unknownId);
    expect(fetched).toBeUndefined();
  });
});

describe("SessionStore contract", () => {
  it("InMemorySessionStore is assignable to SessionStore", () => {
    const store: SessionStore = new InMemorySessionStore();
    expect(store).toBeInstanceOf(InMemorySessionStore);
  });
});
