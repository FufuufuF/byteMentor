import { describe, expect, it } from "vitest";
import type {
  CreateSessionInput,
  SessionStore,
  SessionStoreError,
  SessionStoreErrorKind,
} from "@byte-mentor/session";
import type { SessionId } from "@byte-mentor/core";
import { makePendingEntries } from "./pending-entries.js";

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
    // 场景：提交带稳定身份的 pending 链到空 Session。预期：ID、时间和根 parent 原样保留，Store 只分配 sequence。
    it("commits a batch to an empty session: first entry rooted at null, leaf advances, seq starts at 1", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const result = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("empty-turn", null, [
            { type: "user", content: "q1" },
            {
              type: "assistant",
              content: "a1",
              toolCalls: [],
              model: { provider: "openai", modelId: "gpt-5" },
              stopReason: "completed",
            },
          ]),
        });
        expect(result.activeLeafId).toBeDefined();
        const loaded = await store.loadSession(session.id);
        expect(loaded?.entries).toHaveLength(2);
        expect(loaded?.entries[0].id).toBe("empty-turn-1");
        expect(loaded?.entries[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
        expect(loaded?.entries[0].sequence).toBe(1);
        expect(loaded?.entries[0].parentId).toBeNull();
        expect(loaded?.entries[1].id).toBe("empty-turn-2");
        expect(loaded?.entries[1].createdAt).toBe("2026-01-01T00:00:01.000Z");
        expect(loaded?.entries[1].parentId).toBe(loaded?.entries[0].id);
        expect(loaded?.entries[1].sequence).toBe(2);
        expect(loaded?.activeLeafId).toBe(loaded?.entries[1].id);
        expect(loaded?.nextEntrySeq).toBe(3);
      } finally {
        await factory.close(store);
      }
    });

    // 场景：稳定 pending 链从已有 active leaf 继续追加。预期：调用方提供的 parent 链不被 Store 重写，leaf/sequence 连续推进。
    it("commits a batch after an existing leaf: first entry chains to the current leaf", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("first-turn", null, [{ type: "user", content: "q1" }]),
        });
        const second = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: first.activeLeafId,
          entries: makePendingEntries("second-turn", first.activeLeafId, [
            { type: "user", content: "q2" },
          ]),
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

    // 场景：Turn 提交同时写入 Entry、leaf、sequence 并清除 checkpoint。预期：这些状态变化一起成功。
    it("clears runtime_checkpoint in the same commit as the entries", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        await store.setRuntimeCheckpoint(session.id, { phase: "ready_for_iteration" });
        await store.updateMetadata(session.id, (metadata) => ({ ...metadata, keep: 1 }));
        await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("checkpoint-turn", null, [{ type: "user", content: "q1" }]),
        });
        const metadata = await store.getMetadata(session.id);
        expect(metadata).toEqual({ keep: 1 });
      } finally {
        await factory.close(store);
      }
    });

    // 场景：Turn 使用过期 expectedLeafId 提交。预期：返回 leaf 冲突且 Entry、leaf、sequence、checkpoint 全部不变。
    it("rejects when expectedLeafId does not match the current leaf, leaving everything unchanged", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("stale-base", null, [{ type: "user", content: "q1" }]),
        });
        await store.setRuntimeCheckpoint(session.id, { phase: "awaiting_tools" });
        await expect(
          store.commitTurnEntries({
            sessionId: session.id,
            expectedLeafId: "stale-leaf-id",
            entries: makePendingEntries("stale-turn", first.activeLeafId, [
              { type: "user", content: "q2" },
            ]),
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

    // 场景：Turn 没有任何 pending Entry。预期：返回 constraint，Session 不发生变化。
    it("rejects an empty batch as a constraint violation", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const before = (await store.loadSession(session.id))!;
        await expect(
          store.commitTurnEntries({
            sessionId: session.id,
            expectedLeafId: null,
            entries: [],
          }),
        ).rejects.toMatchObject({ name: "SessionStoreError", kind: "constraint" });
        await expect(store.loadSession(session.id)).resolves.toEqual(before);
      } finally {
        await factory.close(store);
      }
    });

    // 场景：第一条或后续 pending Entry 的 parent 链不连续。预期：整批拒绝且不留下部分 Entry 或 checkpoint 清理。
    it.each([
      {
        name: "first entry does not point to the expected leaf",
        entries: [
          {
            id: "broken-first",
            parentId: "wrong-parent",
            createdAt: "2026-01-01T00:00:00.000Z",
            type: "user" as const,
            content: "q1",
          },
        ],
      },
      {
        name: "later entry does not point to the previous pending entry",
        entries: [
          {
            id: "valid-first",
            parentId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            type: "user" as const,
            content: "q1",
          },
          {
            id: "broken-later",
            parentId: "wrong-parent",
            createdAt: "2026-01-01T00:00:01.000Z",
            type: "user" as const,
            content: "q2",
          },
        ],
      },
    ])("rejects a non-contiguous pending chain ($name)", async ({ entries }) => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        await store.setRuntimeCheckpoint(session.id, { phase: "ready_for_iteration" });
        const before = (await store.loadSession(session.id))!;

        await expect(
          store.commitTurnEntries({
            sessionId: session.id,
            expectedLeafId: null,
            entries,
          }),
        ).rejects.toMatchObject({ name: "SessionStoreError", kind: "constraint" });

        await expect(store.loadSession(session.id)).resolves.toEqual(before);
      } finally {
        await factory.close(store);
      }
    });

    // 场景：Compaction 的 firstKeptEntryId 指向同一批中更早的 pending Entry。预期：整批物化后引用和 parent 链保持有效。
    it("preserves a pending Compaction reference to an earlier pending Entry", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const entries = [
          {
            id: "pending-user",
            parentId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            type: "user" as const,
            content: "q1",
          },
          {
            id: "pending-compaction",
            parentId: "pending-user",
            createdAt: "2026-01-01T00:00:01.000Z",
            type: "compaction" as const,
            summary: "compressed history",
            firstKeptEntryId: "pending-user",
            tokensBefore: 100,
            trigger: "automatic" as const,
            model: { provider: "openai", modelId: "gpt-5" },
          },
        ];

        await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries,
        });

        const loaded = (await store.loadSession(session.id))!;
        expect(loaded.entries).toEqual([
          { ...entries[0], sequence: 1 },
          { ...entries[1], sequence: 2 },
        ]);
        expect(loaded.activeLeafId).toBe("pending-compaction");
        expect(loaded.nextEntrySeq).toBe(3);
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

  describe(`SessionStore branch summary commit (${factory.label})`, () => {
    it("commits a BranchSummaryEntry under the target parent with sourceLeafId, advances leaf and seq", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("branch-base", null, [{ type: "user", content: "q1" }]),
        });
        const before = (await store.loadSession(session.id))!;
        const result = await store.commitBranchSummary({
          sessionId: session.id,
          expectedLeafId: first.activeLeafId,
          parentId: null,
          summary: "branch summary",
          model: { provider: "openai", modelId: "gpt-5" },
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        });
        expect(result.activeLeafId).toBeDefined();
        expect(result.nextEntrySeq).toBe(3);
        const loaded = (await store.loadSession(session.id))!;
        expect(loaded.entries).toHaveLength(2);
        expect(loaded.entries[1]).toMatchObject({
          type: "branch_summary",
          sequence: 2,
          parentId: null,
          sourceLeafId: first.activeLeafId,
          summary: "branch summary",
          model: { provider: "openai", modelId: "gpt-5" },
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        });
        expect(loaded.entries[1].id).toBe(result.activeLeafId);
        expect(loaded.activeLeafId).toBe(result.activeLeafId);
        expect(loaded.nextEntrySeq).toBe(3);
        expect(loaded.updatedAt >= before.updatedAt).toBe(true);
      } finally {
        await factory.close(store);
      }
    });

    it("rejects when expectedLeafId does not match the current leaf, leaving the session unchanged", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("branch-stale-base", null, [{ type: "user", content: "q1" }]),
        });
        await expect(
          store.commitBranchSummary({
            sessionId: session.id,
            expectedLeafId: "stale-leaf-id",
            parentId: null,
            summary: "branch summary",
            model: { provider: "openai", modelId: "gpt-5" },
          }),
        ).rejects.toMatchObject({ name: "SessionLeafConflictError" });
        const loaded = (await store.loadSession(session.id))!;
        expect(loaded.entries).toHaveLength(1);
        expect(loaded.activeLeafId).toBe(first.activeLeafId);
        expect(loaded.nextEntrySeq).toBe(2);
      } finally {
        await factory.close(store);
      }
    });

    it("rejects when the session does not exist", async () => {
      const store = await factory.create();
      try {
        await expect(
          store.commitBranchSummary({
            sessionId: "00000000-0000-4000-8000-000000000099" as SessionId,
            expectedLeafId: null,
            parentId: null,
            summary: "branch summary",
            model: { provider: "openai", modelId: "gpt-5" },
          }),
        ).rejects.toMatchObject({ name: "SessionNotFoundError" });
      } finally {
        await factory.close(store);
      }
    });

    it("rejects an empty summary as a constraint violation without writing an entry", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("branch-empty-base", null, [{ type: "user", content: "q1" }]),
        });
        await expect(
          store.commitBranchSummary({
            sessionId: session.id,
            expectedLeafId: first.activeLeafId,
            parentId: null,
            summary: "   \n  ",
            model: { provider: "openai", modelId: "gpt-5" },
          }),
        ).rejects.toMatchObject({ name: "SessionStoreError", kind: "constraint" });
        const loaded = (await store.loadSession(session.id))!;
        expect(loaded.entries).toHaveLength(1);
        expect(loaded.activeLeafId).toBe(first.activeLeafId);
        expect(loaded.nextEntrySeq).toBe(2);
      } finally {
        await factory.close(store);
      }
    });

    it("rejects a parentId that does not exist in the session and rolls back the whole transaction", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("branch-parent-base", null, [
            { type: "user", content: "q1" },
          ]),
        });
        await expect(
          store.commitBranchSummary({
            sessionId: session.id,
            expectedLeafId: first.activeLeafId,
            parentId: "missing-parent",
            summary: "branch summary",
            model: { provider: "openai", modelId: "gpt-5" },
          }),
        ).rejects.toMatchObject({ name: "SessionStoreError", kind: "constraint" });
        const loaded = (await store.loadSession(session.id))!;
        expect(loaded.entries).toHaveLength(1);
        expect(loaded.activeLeafId).toBe(first.activeLeafId);
        expect(loaded.nextEntrySeq).toBe(2);
      } finally {
        await factory.close(store);
      }
    });

    it("does not clear runtime_checkpoint (unlike commitTurnEntries)", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("branch-checkpoint-base", null, [
            { type: "user", content: "q1" },
          ]),
        });
        await store.setRuntimeCheckpoint(session.id, { phase: "ready_for_iteration" });
        await store.commitBranchSummary({
          sessionId: session.id,
          expectedLeafId: first.activeLeafId,
          parentId: null,
          summary: "branch summary",
          model: { provider: "openai", modelId: "gpt-5" },
        });
        const metadata = await store.getMetadata(session.id);
        expect(metadata).toEqual({ runtime_checkpoint: { phase: "ready_for_iteration" } });
      } finally {
        await factory.close(store);
      }
    });
  });

  describe(`SessionStore compaction commit (${factory.label})`, () => {
    // 场景：已有 active leaf 时提交完整 pending Compaction。预期：payload 原样保存，Store 只分配 sequence 并推进 leaf。
    it("commits a CompactionEntry and advances the leaf and sequence", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("compaction-base", null, [{ type: "user", content: "q1" }]),
        });
        const pending = {
          id: "compaction-1",
          parentId: first.activeLeafId,
          createdAt: "2026-01-01T00:00:02.000Z",
          type: "compaction" as const,
          summary: "compressed history",
          firstKeptEntryId: null,
          tokensBefore: 1234,
          trigger: "manual" as const,
          model: { provider: "openai", modelId: "gpt-5" },
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        };

        const result = await store.commitCompaction({
          sessionId: session.id,
          expectedLeafId: first.activeLeafId,
          entry: pending,
        });

        const loaded = (await store.loadSession(session.id))!;
        expect(result).toEqual({
          entryId: "compaction-1",
          activeLeafId: "compaction-1",
          nextEntrySeq: 3,
        });
        expect(loaded.entries[1]).toEqual({
          ...pending,
          sequence: 2,
        });
        expect(loaded.activeLeafId).toBe("compaction-1");
        expect(loaded.nextEntrySeq).toBe(3);
      } finally {
        await factory.close(store);
      }
    });

    // 场景：独立 Compaction 提交时 metadata 含 checkpoint。预期：只追加 Entry，不清除 checkpoint 或其他 metadata。
    it("preserves runtime_checkpoint and other metadata", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("compaction-metadata-base", null, [
            { type: "user", content: "q1" },
          ]),
        });
        await store.updateMetadata(session.id, () => ({ keep: 1 }));
        await store.setRuntimeCheckpoint(session.id, { phase: "ready_for_iteration" });

        await store.commitCompaction({
          sessionId: session.id,
          expectedLeafId: first.activeLeafId,
          entry: {
            id: "compaction-preserve-checkpoint",
            parentId: first.activeLeafId,
            createdAt: "2026-01-01T00:00:02.000Z",
            type: "compaction",
            summary: "compressed history",
            firstKeptEntryId: null,
            tokensBefore: 100,
            trigger: "automatic",
            model: { provider: "openai", modelId: "gpt-5" },
          },
        });

        await expect(store.getMetadata(session.id)).resolves.toEqual({
          keep: 1,
          runtime_checkpoint: { phase: "ready_for_iteration" },
        });
      } finally {
        await factory.close(store);
      }
    });

    // 场景：提交使用过期 source leaf。预期：抛出 leaf 冲突，Entry、leaf、sequence 和 metadata 全部保持不变。
    it("rejects a stale source leaf without changing the session", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("compaction-stale-base", null, [
            { type: "user", content: "q1" },
          ]),
        });
        await store.setRuntimeCheckpoint(session.id, { phase: "ready_for_iteration" });
        const before = (await store.loadSession(session.id))!;

        await expect(
          store.commitCompaction({
            sessionId: session.id,
            expectedLeafId: "stale-leaf-id",
            entry: {
              id: "compaction-stale",
              parentId: "stale-leaf-id",
              createdAt: "2026-01-01T00:00:02.000Z",
              type: "compaction",
              summary: "should not persist",
              firstKeptEntryId: null,
              tokensBefore: 100,
              trigger: "manual",
              model: { provider: "openai", modelId: "gpt-5" },
            },
          }),
        ).rejects.toMatchObject({ name: "SessionLeafConflictError" });

        await expect(store.loadSession(session.id)).resolves.toEqual(before);
        expect(first.activeLeafId).toBe(before.activeLeafId);
      } finally {
        await factory.close(store);
      }
    });

    // 场景：expectedLeafId 是当前 leaf，但 Compaction parent 指向同一 Session 中的旧节点。预期：拒绝提交且 Session 完整不变。
    it("rejects a parent that is not the current active leaf", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("compaction-parent-base", null, [
            { type: "user", content: "q1" },
          ]),
        });
        const second = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: first.activeLeafId,
          entries: makePendingEntries("compaction-parent-next", first.activeLeafId, [
            { type: "user", content: "q2" },
          ]),
        });
        const before = (await store.loadSession(session.id))!;

        await expect(
          store.commitCompaction({
            sessionId: session.id,
            expectedLeafId: second.activeLeafId,
            entry: {
              id: "compaction-non-leaf-parent",
              parentId: first.activeLeafId,
              createdAt: "2026-01-01T00:00:03.000Z",
              type: "compaction",
              summary: "should not persist",
              firstKeptEntryId: null,
              tokensBefore: 100,
              trigger: "manual",
              model: { provider: "openai", modelId: "gpt-5" },
            },
          }),
        ).rejects.toMatchObject({ name: "SessionStoreError", kind: "constraint" });

        await expect(store.loadSession(session.id)).resolves.toEqual(before);
      } finally {
        await factory.close(store);
      }
    });

    // 场景：提交到不存在的 Session。预期：抛出 SessionNotFoundError，且不产生任何持久化数据。
    it("rejects a compaction for an unknown session", async () => {
      const store = await factory.create();
      try {
        await expect(
          store.commitCompaction({
            sessionId: "00000000-0000-4000-8000-000000000099" as SessionId,
            expectedLeafId: null,
            entry: {
              id: "compaction-unknown-session",
              parentId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
              type: "compaction",
              summary: "should not persist",
              firstKeptEntryId: null,
              tokensBefore: 100,
              trigger: "manual",
              model: { provider: "openai", modelId: "gpt-5" },
            },
          }),
        ).rejects.toMatchObject({ name: "SessionNotFoundError" });
      } finally {
        await factory.close(store);
      }
    });

    // 场景：摘要只有空白字符。预期：返回 constraint 错误，且不写 Entry 或推进 Session 状态。
    it("rejects a blank summary without writing an entry", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("compaction-blank-base", null, [
            { type: "user", content: "q1" },
          ]),
        });
        const before = (await store.loadSession(session.id))!;

        await expect(
          store.commitCompaction({
            sessionId: session.id,
            expectedLeafId: first.activeLeafId,
            entry: {
              id: "compaction-blank",
              parentId: first.activeLeafId,
              createdAt: "2026-01-01T00:00:02.000Z",
              type: "compaction",
              summary: " \n\t ",
              firstKeptEntryId: null,
              tokensBefore: 100,
              trigger: "manual",
              model: { provider: "openai", modelId: "gpt-5" },
            },
          }),
        ).rejects.toMatchObject({ name: "SessionStoreError", kind: "constraint" });

        await expect(store.loadSession(session.id)).resolves.toEqual(before);
      } finally {
        await factory.close(store);
      }
    });

    // 场景：Compaction parent 不属于当前 Session。预期：返回 constraint，整笔提交回滚。
    it("rejects an invalid parentId and rolls back", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("compaction-invalid-parent-base", null, [
            { type: "user", content: "q1" },
          ]),
        });
        const before = (await store.loadSession(session.id))!;

        await expect(
          store.commitCompaction({
            sessionId: session.id,
            expectedLeafId: first.activeLeafId,
            entry: {
              id: "compaction-invalid-parent",
              parentId: "missing-parent",
              createdAt: "2026-01-01T00:00:02.000Z",
              type: "compaction",
              summary: "should not persist",
              firstKeptEntryId: null,
              tokensBefore: 100,
              trigger: "manual",
              model: { provider: "openai", modelId: "gpt-5" },
            },
          }),
        ).rejects.toMatchObject({ name: "SessionStoreError", kind: "constraint" });

        await expect(store.loadSession(session.id)).resolves.toEqual(before);
      } finally {
        await factory.close(store);
      }
    });

    // 场景：firstKeptEntryId 不存在于当前 Session。预期：返回 constraint，整笔提交回滚。
    it("rejects an invalid firstKeptEntryId and rolls back", async () => {
      const store = await factory.create();
      try {
        const session = await store.createSession(validCreateInput);
        const first = await store.commitTurnEntries({
          sessionId: session.id,
          expectedLeafId: null,
          entries: makePendingEntries("compaction-invalid-first-kept-base", null, [
            { type: "user", content: "q1" },
          ]),
        });
        const before = (await store.loadSession(session.id))!;

        await expect(
          store.commitCompaction({
            sessionId: session.id,
            expectedLeafId: first.activeLeafId,
            entry: {
              id: "compaction-invalid-first-kept",
              parentId: first.activeLeafId,
              createdAt: "2026-01-01T00:00:02.000Z",
              type: "compaction",
              summary: "should not persist",
              firstKeptEntryId: "missing-first-kept",
              tokensBefore: 100,
              trigger: "manual",
              model: { provider: "openai", modelId: "gpt-5" },
            },
          }),
        ).rejects.toMatchObject({ name: "SessionStoreError", kind: "constraint" });

        await expect(store.loadSession(session.id)).resolves.toEqual(before);
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
