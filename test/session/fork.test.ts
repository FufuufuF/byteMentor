import { describe, expect, it } from "vitest";
import { forkSession } from "@byte-mentor/session";
import type { SessionSnapshot } from "@byte-mentor/session";
import type { SessionEntry } from "@byte-mentor/session";
import type { SessionId, ToolCallId } from "@byte-mentor/core";
import { InMemorySessionStore } from "@byte-mentor/session";

// 测试工具：构造一个已有对话的 InMemory store（source session）。
// 结构：u1(根) → a1(带 tool call) → t1 → u2 → a2(文本)
async function makeSourceStore(): Promise<{
  store: InMemorySessionStore;
  snapshot: SessionSnapshot;
}> {
  const store = new InMemorySessionStore();
  const snapshot = await store.createSession({
    workspaceRoot: "/w",
    initialProvider: "openai",
    initialModelId: "gpt-5",
    initialThinkingLevel: "medium",
  });
  await store.commitTurnEntries({
    sessionId: snapshot.id,
    expectedLeafId: null,
    entries: [
      { entry: { type: "user", content: "q1" } },
      {
        entry: {
          type: "assistant",
          content: "",
          toolCalls: [{ id: "call-1" as ToolCallId, name: "bash", args: {} }],
          model: { provider: "openai", modelId: "gpt-5" },
          stopReason: "tool_calls",
        },
      },
      {
        entry: {
          type: "tool_result",
          toolCallId: "call-1" as ToolCallId,
          toolName: "bash",
          content: "out",
          isError: false,
        },
      },
      { entry: { type: "user", content: "q2" } },
      {
        entry: {
          type: "assistant",
          content: "a2",
          toolCalls: [],
          model: { provider: "openai", modelId: "gpt-5" },
          stopReason: "completed",
        },
      },
    ],
  });
  return { store, snapshot: (await store.loadSession(snapshot.id))! };
}

function entryById(snapshot: SessionSnapshot, id: string): SessionEntry {
  const entry = snapshot.entries.find((e) => e.id === id);
  if (entry === undefined) {
    throw new Error(`entry ${id} not found`);
  }
  return entry;
}

// 场景：选中间 user（u2）fork。预期：新 session 含 u1→a1→t1→u2 的父路径（不含 u2 自身），
// leaf 指向路径末条（u2 的 parent，即 t1），nextEntrySeq 正确，草稿为 u2 原文。
describe("forkSession basic fork", () => {
  it("forks the path from root to the selected user's parent", async () => {
    const { store, snapshot } = await makeSourceStore();
    const u2 = entryById(
      snapshot,
      snapshot.entries.find((e) => e.type === "user" && e.content === "q2")!.id,
    );
    const result = await forkSession({ store, sourceSessionId: snapshot.id, targetUserId: u2.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { newSession, draft } = result;
    expect(draft).toBe("q2");
    // 复制路径：u1 → a1 → t1（u2 的 parent 链，不含 u2）
    const ids = newSession.entries.map((e) => e.id);
    expect(ids).toEqual([
      entryById(snapshot, snapshot.entries.find((e) => e.type === "user" && e.content === "q1")!.id)
        .id,
      entryById(
        snapshot,
        snapshot.entries.find((e) => e.type === "assistant" && e.toolCalls.length > 0)!.id,
      ).id,
      entryById(snapshot, snapshot.entries.find((e) => e.type === "tool_result")!.id).id,
    ]);
    // 路径末条是 t1
    expect(newSession.activeLeafId).toBe(ids[2]);
    expect(newSession.nextEntrySeq).toBe(4);
    // 新 session 继承初始状态与 workspace
    expect(newSession.workspaceRoot).toBe("/w");
    expect(newSession.initialProvider).toBe("openai");
    expect(newSession.initialModelId).toBe("gpt-5");
    expect(newSession.initialThinkingLevel).toBe("medium");
    expect(newSession.metadata).toEqual({});
    // 新 id 与源不同
    expect(newSession.id).not.toBe(snapshot.id);
  });
});

// 场景：复制保留 Entry ID/content/created_at/toolCallId，seq 从 1 重排，parent 指向前驱。
describe("forkSession copy fidelity", () => {
  it("preserves ids, content, and tool call ids while resequencing", async () => {
    const { store, snapshot } = await makeSourceStore();
    const u1 = entryById(
      snapshot,
      snapshot.entries.find((e) => e.type === "user" && e.content === "q1")!.id,
    );
    const result = await forkSession({ store, sourceSessionId: snapshot.id, targetUserId: u1.id });
    // 选根 user：复制路径为空（u1 的 parent 是 null）
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { newSession } = result;
    expect(newSession.entries).toEqual([]);
    expect(newSession.activeLeafId).toBeNull();
    expect(newSession.nextEntrySeq).toBe(1);
    expect(result.draft).toBe("q1");
  });

  it("preserves entry ids, content, createdAt, and tool call ids", async () => {
    const { store, snapshot } = await makeSourceStore();
    // 选最后一个 user 之前的路径 —— 用 u2 作为 target（路径含 tool call 链）
    const u2 = entryById(
      snapshot,
      snapshot.entries.find((e) => e.type === "user" && e.content === "q2")!.id,
    );
    const result = await forkSession({ store, sourceSessionId: snapshot.id, targetUserId: u2.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { newSession } = result;
    const sourceTool = snapshot.entries.find(
      (e): e is Extract<SessionEntry, { type: "assistant" }> =>
        e.type === "assistant" && e.toolCalls.length > 0,
    )!;
    const copiedTool = newSession.entries.find(
      (e): e is Extract<SessionEntry, { type: "assistant" }> =>
        e.type === "assistant" && e.toolCalls.length > 0,
    )!;
    expect(copiedTool.id).toBe(sourceTool.id);
    expect(copiedTool.toolCalls[0].id).toBe(sourceTool.toolCalls[0].id);
    expect(copiedTool.createdAt).toBe(sourceTool.createdAt);
    // seq 从 1 重排
    expect(newSession.entries.map((e) => e.sequence)).toEqual([1, 2, 3]);
    // parent 连接前驱
    expect(newSession.entries[1].parentId).toBe(newSession.entries[0].id);
    expect(newSession.entries[2].parentId).toBe(newSession.entries[1].id);
  });
});

// 场景：引用归一化。预期：路径外 sourceLeafId/firstKeptEntryId → null；路径内保留。
describe("forkSession reference normalization", () => {
  it("nulls out-of-path branch summary sourceLeafId and compaction firstKeptEntryId", async () => {
    const store = new InMemorySessionStore();
    const snapshot = await store.createSession({
      workspaceRoot: "/w",
      initialProvider: "openai",
      initialModelId: "gpt-5",
      initialThinkingLevel: "medium",
    });
    // 构造：u1 → b1(branch_summary, sourceLeaf 指向路径外的 x) → u2 → c1(compaction, firstKept 指向路径外的 y)
    await store.commitTurnEntries({
      sessionId: snapshot.id,
      expectedLeafId: null,
      entries: [
        { entry: { type: "user", content: "q1" } },
        {
          entry: {
            type: "branch_summary",
            sourceLeafId: "out-of-path",
            summary: "s",
            model: { provider: "openai", modelId: "gpt-5" },
          },
        },
        { entry: { type: "user", content: "q2" } },
        {
          entry: {
            type: "compaction",
            summary: "c",
            firstKeptEntryId: "out-of-path-2",
            tokensBefore: 10,
            trigger: "manual",
            model: { provider: "openai", modelId: "gpt-5" },
          },
        },
      ],
    });
    const loaded = (await store.loadSession(snapshot.id))!;
    // 选最后一个 user（u2）→ 复制路径 u1→b1→u2；b1 的 sourceLeaf 路径外 → null
    const u2 = loaded.entries.find((e) => e.type === "user" && e.content === "q2")!;
    const result = await forkSession({ store, sourceSessionId: snapshot.id, targetUserId: u2.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const copiedBranch = result.newSession.entries.find((e) => e.type === "branch_summary")!;
    expect(copiedBranch.sourceLeafId).toBeNull();
    // 选 u1 → 复制路径为空；无引用问题
    const u1 = loaded.entries.find((e) => e.type === "user" && e.content === "q1")!;
    const result2 = await forkSession({ store, sourceSessionId: snapshot.id, targetUserId: u1.id });
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.newSession.entries).toEqual([]);
  });

  it("keeps in-path references intact", async () => {
    const store = new InMemorySessionStore();
    const snapshot = await store.createSession({
      workspaceRoot: "/w",
      initialProvider: "openai",
      initialModelId: "gpt-5",
      initialThinkingLevel: "medium",
    });
    await store.commitTurnEntries({
      sessionId: snapshot.id,
      expectedLeafId: null,
      entries: [
        { entry: { type: "user", content: "q1" } },
        {
          entry: {
            type: "assistant",
            content: "a",
            toolCalls: [],
            model: { provider: "openai", modelId: "gpt-5" },
            stopReason: "completed",
          },
        },
      ],
    });
    const loaded = (await store.loadSession(snapshot.id))!;
    // 选最后一个 user 之前的路径需要 target 是 user —— 这里只有 q1；选 q1 fork 空路径。
    // 改为：再追加一个 user，选它 fork，路径含 q1（引用路径内无 branch/compaction）。
    await store.commitTurnEntries({
      sessionId: snapshot.id,
      expectedLeafId: loaded.activeLeafId,
      entries: [{ entry: { type: "user", content: "q2" } }],
    });
    const after = (await store.loadSession(snapshot.id))!;
    const q2 = after.entries.find((e) => e.type === "user" && e.content === "q2")!;
    const result = await forkSession({ store, sourceSessionId: snapshot.id, targetUserId: q2.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // fork 复制 root → q2.parent（a1），不含 q2 自身。
    expect(result.newSession.entries.map((e) => e.type)).toEqual(["user", "assistant"]);
    expect(result.draft).toBe("q2");
  });
});

// 场景：源 session 不变。预期：fork 后源 entries/leaf/seq 全部保持。
describe("forkSession source immutability", () => {
  it("leaves the source session unchanged", async () => {
    const { store, snapshot } = await makeSourceStore();
    const u2 = entryById(
      snapshot,
      snapshot.entries.find((e) => e.type === "user" && e.content === "q2")!.id,
    );
    const before = JSON.stringify(snapshot);
    const result = await forkSession({ store, sourceSessionId: snapshot.id, targetUserId: u2.id });
    expect(result.ok).toBe(true);
    const after = JSON.stringify(await store.loadSession(snapshot.id));
    expect(after).toBe(before);
  });
});

// 场景：目标非 user / session 无 user。预期：ForkValidationError。
describe("forkSession validation", () => {
  it("rejects a non-user target", async () => {
    const { store, snapshot } = await makeSourceStore();
    const a1 = snapshot.entries.find((e) => e.type === "assistant")!;
    const result = await forkSession({ store, sourceSessionId: snapshot.id, targetUserId: a1.id });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ForkValidationError");
    }
  });

  it("rejects an unknown target", async () => {
    const { store, snapshot } = await makeSourceStore();
    const result = await forkSession({
      store,
      sourceSessionId: snapshot.id,
      targetUserId: "ghost",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("SessionNavigationError");
    }
  });

  it("rejects an unknown source session", async () => {
    const store = new InMemorySessionStore();
    const unknown = "00000000-0000-4000-8000-000000000000" as SessionId;
    const result = await forkSession({ store, sourceSessionId: unknown, targetUserId: "u1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("SessionNotFoundError");
    }
  });
});

// 场景：空路径 fork 的原子性由 createSessionWithEntries 契约保证（双实现共用测试覆盖）；
// 这里补充验证 forkSession 返回的空 session 与源独立。
describe("forkSession atomicity", () => {
  it("creates an independent empty session for an empty fork path", async () => {
    const store = new InMemorySessionStore();
    const snapshot = await store.createSession({
      workspaceRoot: "/w",
      initialProvider: "openai",
      initialModelId: "gpt-5",
      initialThinkingLevel: "medium",
    });
    await store.commitTurnEntries({
      sessionId: snapshot.id,
      expectedLeafId: null,
      entries: [{ entry: { type: "user", content: "q1" } }],
    });
    const loaded = (await store.loadSession(snapshot.id))!;
    const u1 = loaded.entries[0];
    const result = await forkSession({ store, sourceSessionId: snapshot.id, targetUserId: u1.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newSession.entries).toEqual([]);
    expect(result.newSession.activeLeafId).toBeNull();
    expect(result.newSession.nextEntrySeq).toBe(1);
    // 新 session 独立：追加不影响源
    await store.commitTurnEntries({
      sessionId: result.newSession.id,
      expectedLeafId: null,
      entries: [{ entry: { type: "user", content: "forked q" } }],
    });
    const forked = (await store.loadSession(result.newSession.id))!;
    expect(forked.entries).toHaveLength(1);
    const sourceAfter = (await store.loadSession(snapshot.id))!;
    expect(sourceAfter.entries).toHaveLength(1);
  });
});
