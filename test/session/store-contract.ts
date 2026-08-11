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
