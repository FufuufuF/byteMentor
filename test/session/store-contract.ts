import { describe, expect, it } from "vitest";
import type {
  CreateSessionInput,
  SessionStore,
  SessionStoreError,
  SessionStoreErrorKind,
} from "@byte-mentor/session";
import type { SessionId } from "@byte-mentor/core";

// 双实现共享的 Store 契约测试：每个具体实现注册自己的构造器与 close/reopen 行为，
// 保证 InMemory 与 SQLite 满足同一份领域契约，而不是各写一套断言。

export const validCreateInput: CreateSessionInput = {
  workspaceRoot: "/workspace/a",
  initialProvider: "openai",
  initialModelId: "gpt-5",
  initialThinkingLevel: "medium",
};

export interface StoreFactory {
  label: string;
  create(): Promise<SessionStore>;
  close(store: SessionStore): Promise<void>;
}

export function runStoreContractTests(factory: StoreFactory): void {
  describe(`SessionStore contract (${factory.label})`, () => {
    it("createSession returns an initial snapshot with initial state and empty tree", async () => {
      const store = await factory.create();
      try {
        const snapshot = await store.createSession(validCreateInput);
        expect(snapshot.workspaceRoot).toBe("/workspace/a");
        expect(snapshot.initialProvider).toBe("openai");
        expect(snapshot.initialModelId).toBe("gpt-5");
        expect(snapshot.initialThinkingLevel).toBe("medium");
        expect(snapshot.activeLeafId).toBeNull();
        expect(snapshot.nextEntrySeq).toBe(1);
        expect(snapshot.metadata).toEqual({});
        expect(snapshot.entries).toEqual([]);
        expect(typeof snapshot.createdAt).toBe("string");
        expect(typeof snapshot.updatedAt).toBe("string");
      } finally {
        await factory.close(store);
      }
    });

    it("createSession assigns distinct ids across calls", async () => {
      const store = await factory.create();
      try {
        const a = await store.createSession(validCreateInput);
        const b = await store.createSession(validCreateInput);
        expect(a.id).not.toBe(b.id);
      } finally {
        await factory.close(store);
      }
    });

    it("loadSession returns the full snapshot with entries in sequence order", async () => {
      const store = await factory.create();
      try {
        const created = await store.createSession(validCreateInput);
        const loaded = await store.loadSession(created.id);
        expect(loaded).toBeDefined();
        expect(loaded?.id).toBe(created.id);
        expect(loaded?.entries).toEqual(created.entries);
        expect(loaded?.activeLeafId).toBe(created.activeLeafId);
      } finally {
        await factory.close(store);
      }
    });

    it("loadSession returns undefined for an unknown session id", async () => {
      const store = await factory.create();
      try {
        const unknown = "00000000-0000-4000-8000-000000000000" as SessionId;
        await expect(store.loadSession(unknown)).resolves.toBeUndefined();
      } finally {
        await factory.close(store);
      }
    });

    it("getMetadata reads metadata and reflects updateMetadata changes", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        await expect(store.getMetadata(session.id)).resolves.toEqual({});
        await expect(store.updateMetadata(session.id, () => ({ a: 1 }))).resolves.toEqual({ a: 1 });
        await expect(store.getMetadata(session.id)).resolves.toEqual({ a: 1 });
        await store.updateMetadata(session.id, (metadata) => ({ ...metadata, b: 2 }));
        await expect(store.getMetadata(session.id)).resolves.toEqual({ a: 1, b: 2 });
      } finally {
        await factory.close(store);
      }
    });

    it("throws SessionNotFoundError for metadata operations on an unknown session", async () => {
      const store = await factory.create();
      try {
        const unknown = "00000000-0000-4000-8000-000000000000" as SessionId;
        await expect(store.getMetadata(unknown)).rejects.toMatchObject({
          name: "SessionNotFoundError",
        });
      } finally {
        await factory.close(store);
      }
    });
  });

  describe(`SessionStore transactional writes (${factory.label})`, () => {
    it("commits a batch to an empty session: first entry rooted at null, leaf advances, seq starts at 1", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const result = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: [
            { entry: { type: "user", content: "q1" } },
            {
              entry: {
                type: "assistant",
                content: "a1",
                toolCalls: [],
                model: { provider: "openai", modelId: "gpt-5" },
                stopReason: "completed",
              },
            },
          ],
        });
        expect(result.activeLeafId).toBeDefined();
        const loaded = await store.loadSession(session.id);
        expect(loaded?.entries).toHaveLength(2);
        expect(loaded?.entries[0].sequence).toBe(1);
        expect(loaded?.entries[0].parentId).toBeNull();
        expect(loaded?.entries[1].parentId).toBe(loaded?.entries[0].id);
        expect(loaded?.entries[1].sequence).toBe(2);
        expect(loaded?.activeLeafId).toBe(loaded?.entries[1].id);
        expect(loaded?.nextEntrySeq).toBe(3);
      } finally {
        await factory.close(store);
      }
    });

    it("commits a batch after an existing leaf: first entry chains to the current leaf", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: [{ entry: { type: "user", content: "q1" } }],
        });
        const second = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: first.activeLeafId,
          entries: [{ entry: { type: "user", content: "q2" } }],
        });
        const loaded = await store.loadSession(session.id);
        expect(loaded?.entries).toHaveLength(2);
        expect(loaded?.entries[1].parentId).toBe(loaded?.entries[0].id);
        expect(loaded?.entries[1].sequence).toBe(2);
        expect(loaded?.activeLeafId).toBe(second.activeLeafId);
        expect(loaded?.nextEntrySeq).toBe(3);
      } finally {
        await factory.close(store);
      }
    });

    it("clears runtime_checkpoint in the same commit as the entries", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        await store.setRuntimeCheckpoint(session.id, { phase: "ready_for_iteration" });
        await store.updateMetadata(session.id, (metadata) => ({ ...metadata, keep: 1 }));
        await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: [{ entry: { type: "user", content: "q1" } }],
        });
        const metadata = await store.getMetadata(session.id);
        expect(metadata).toEqual({ keep: 1 });
      } finally {
        await factory.close(store);
      }
    });

    it("rejects when expectedLeafId does not match the current leaf, leaving everything unchanged", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: [{ entry: { type: "user", content: "q1" } }],
        });
        await store.setRuntimeCheckpoint(session.id, { phase: "awaiting_tools" });
        await expect(
          store.commitTurnEntries({
            sessionId: session.id,
            expectedLeafId: "stale-leaf-id",
            entries: [{ entry: { type: "user", content: "q2" } }],
          }),
        ).rejects.toMatchObject({ name: "SessionLeafConflictError" });
        const loaded = await store.loadSession(session.id);
        expect(loaded?.entries).toHaveLength(1);
        expect(loaded?.activeLeafId).toBe(first.activeLeafId);
        expect(loaded?.nextEntrySeq).toBe(2);
        expect(loaded?.metadata).toEqual({ runtime_checkpoint: { phase: "awaiting_tools" } });
      } finally {
        await factory.close(store);
      }
    });

    it("rejects an empty batch as a constraint violation", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        await expect(
          store.commitTurnEntries({
            sessionId: session.id,
            expectedLeafId: null,
            entries: [],
          }),
        ).rejects.toMatchObject({ name: "SessionStoreError", kind: "constraint" });
      } finally {
        await factory.close(store);
      }
    });

    it("createSessionWithEntries creates a session with entries, leaf, and nextEntrySeq", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSessionWithEntries({
          workspaceRoot: "/w",
          initialProvider: "openai",
          initialModelId: "gpt-5",
          initialThinkingLevel: "medium",
          entries: [
            {
              id: "u1",
              sequence: 1,
              parentId: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              type: "user",
              content: "q1",
            },
            {
              id: "a1",
              sequence: 2,
              parentId: "u1",
              createdAt: "2026-01-01T00:00:01.000Z",
              type: "assistant",
              content: "a",
              toolCalls: [],
              model: { provider: "openai", modelId: "gpt-5" },
              stopReason: "completed",
            },
          ],
        });
        expect(session.entries).toHaveLength(2);
        expect(session.entries[0].id).toBe("u1");
        expect(session.entries[1].parentId).toBe("u1");
        expect(session.activeLeafId).toBe("a1");
        expect(session.nextEntrySeq).toBe(3);
        expect(session.metadata).toEqual({});
        // 重新加载确认持久化
        const loaded = await store.loadSession(session.id);
        expect(loaded?.entries.map((e) => e.id)).toEqual(["u1", "a1"]);
      } finally {
        await factory.close(store);
      }
    });

    it("createSessionWithEntries accepts an empty entry list (empty fork path)", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSessionWithEntries({
          workspaceRoot: "/w",
          initialProvider: "openai",
          initialModelId: "gpt-5",
          initialThinkingLevel: "medium",
          entries: [],
        });
        expect(session.entries).toEqual([]);
        expect(session.activeLeafId).toBeNull();
        expect(session.nextEntrySeq).toBe(1);
      } finally {
        await factory.close(store);
      }
    });
  });

  describe(`SessionStore runtime checkpoint (${factory.label})`, () => {
    it("setRuntimeCheckpoint stores a JSON value under runtime_checkpoint and preserves other metadata", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        await store.updateMetadata(session.id, (metadata) => ({ ...metadata, keep: 1 }));
        await store.setRuntimeCheckpoint(session.id, { phase: "awaiting_tools" });
        const metadata = await store.getMetadata(session.id);
        expect(metadata).toEqual({ keep: 1, runtime_checkpoint: { phase: "awaiting_tools" } });
      } finally {
        await factory.close(store);
      }
    });

    it("setRuntimeCheckpoint overwrites a previous checkpoint value", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        await store.setRuntimeCheckpoint(session.id, { phase: "awaiting_tools" });
        await store.setRuntimeCheckpoint(session.id, { phase: "ready_for_iteration" });
        const metadata = await store.getMetadata(session.id);
        expect(metadata).toEqual({ runtime_checkpoint: { phase: "ready_for_iteration" } });
      } finally {
        await factory.close(store);
      }
    });

    it("clearRuntimeCheckpoint removes only the checkpoint key", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        await store.updateMetadata(session.id, (metadata) => ({ ...metadata, keep: 1 }));
        await store.setRuntimeCheckpoint(session.id, { phase: "awaiting_tools" });
        await store.clearRuntimeCheckpoint(session.id);
        const metadata = await store.getMetadata(session.id);
        expect(metadata).toEqual({ keep: 1 });
      } finally {
        await factory.close(store);
      }
    });
  });
}

// 断言辅助：验证错误属于归一化 SessionStoreError 且 kind 匹配。
export function expectStoreErrorKind(
  promise: Promise<unknown>,
  kind: SessionStoreErrorKind,
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: "SessionStoreError",
    kind,
  } satisfies Partial<SessionStoreError>);
}
