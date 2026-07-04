import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "@byte-mentor/session";
import type { Message } from "@byte-mentor/core";

describe("InMemorySessionStore appendMessages", () => {
  it("appends a single message to a freshly created session", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create();
    const userMsg: Message = { role: "user", content: "hello" };
    await store.appendMessages(session.id, [userMsg]);
    const history = await store.getHistory(session.id);
    expect(history).toEqual([userMsg]);
  });

  it("appends multiple messages preserving order across calls", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create();
    const first: Message = { role: "user", content: "q1" };
    const second: Message = { role: "assistant", content: "a1" };
    const third: Message = { role: "user", content: "q2" };
    await store.appendMessages(session.id, [first]);
    await store.appendMessages(session.id, [second, third]);
    const history = await store.getHistory(session.id);
    expect(history).toEqual([first, second, third]);
  });

  it("throws when appending to an unknown sessionId", async () => {
    const store = new InMemorySessionStore();
    const unknownId = "00000000-0000-4000-8000-000000000000" as never;
    await expect(
      store.appendMessages(unknownId, [{ role: "user", content: "x" }]),
    ).rejects.toThrow();
  });
});

describe("InMemorySessionStore getHistory", () => {
  it("returns an empty array for a freshly created session", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create();
    const history = await store.getHistory(session.id);
    expect(history).toEqual([]);
  });

  it("returns a copy: mutating the result does not affect internal state", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create();
    const msg: Message = { role: "user", content: "hi" };
    await store.appendMessages(session.id, [msg]);
    const history = await store.getHistory(session.id);
    history.push({ role: "assistant", content: "mutated" });
    const again = await store.getHistory(session.id);
    expect(again).toEqual([msg]);
  });

  it("returns an empty array for an unknown sessionId", async () => {
    const store = new InMemorySessionStore();
    const unknownId = "00000000-0000-4000-8000-000000000000" as never;
    const history = await store.getHistory(unknownId);
    expect(history).toEqual([]);
  });
});
