import { describe, expect, it } from "vitest";
import { listTreeTargets, navigateDirectly, type TreeTarget } from "@byte-mentor/session";
import type { SessionSnapshot } from "@byte-mentor/session";
import type { SessionEntry } from "@byte-mentor/session";
import type { SessionId, ToolCallId } from "@byte-mentor/core";
import { InMemorySessionStore } from "@byte-mentor/session";

// 测试工具：把字符串字面量提升为品牌化 ToolCallId。
function tc(id: string): ToolCallId {
  return id as ToolCallId;
}

// 测试工具：构造 SessionSnapshot。
function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001" as SessionId,
    workspaceRoot: "/w",
    initialProvider: "openai",
    initialModelId: "gpt-5",
    initialThinkingLevel: "medium",
    activeLeafId: null,
    nextEntrySeq: 1,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries: [],
    ...overrides,
  };
}

function userEntry(
  id: string,
  seq: number,
  parentId: string | null,
  content = `user ${id}`,
): SessionEntry {
  return { id, sequence: seq, parentId, createdAt: "", type: "user", content };
}

function assistantEntry(
  id: string,
  seq: number,
  parentId: string | null,
  opts: { content?: string; toolCalls?: { id: ToolCallId; name: string; args: unknown }[] } = {},
): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "assistant",
    content: opts.content ?? "",
    toolCalls: opts.toolCalls ?? [],
    model: { provider: "openai", modelId: "gpt-5" },
    stopReason: opts.toolCalls && opts.toolCalls.length > 0 ? "tool_calls" : "completed",
  };
}

function toolResultEntry(
  id: string,
  seq: number,
  parentId: string,
  toolCallId: string,
): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "tool_result",
    toolCallId: toolCallId as ToolCallId,
    toolName: "bash",
    content: `result ${id}`,
    isError: false,
  };
}

function compactionEntry(id: string, seq: number, parentId: string): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "compaction",
    summary: "s",
    firstKeptEntryId: null,
    tokensBefore: 10,
    trigger: "manual",
    model: { provider: "openai", modelId: "gpt-5" },
  };
}

function branchSummaryEntry(id: string, seq: number, parentId: string): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "branch_summary",
    sourceLeafId: null,
    summary: "s",
    model: { provider: "openai", modelId: "gpt-5" },
  };
}

function modelChangeEntry(id: string, seq: number, parentId: string | null): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "model_change",
    model: { provider: "openai", modelId: "gpt-5" },
  };
}

function thinkingChangeEntry(id: string, seq: number, parentId: string | null): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "thinking_level_change",
    level: "high",
  };
}

// 场景：混合树的 Tree 目标清单。预期：user/带文本 assistant/tool_result 可见可选；
// compaction/branch_summary 可见不可选；状态 entry 不显示；纯 tool-call assistant 不可选。
describe("listTreeTargets visibility and selectability", () => {
  it("builds the default-view target list per M5.1", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      assistantEntry("a1", 2, "u1", { content: "text answer" }),
      assistantEntry("a2", 3, "a1", { toolCalls: [{ id: tc("call-1"), name: "bash", args: {} }] }), // 纯 tool-call
      toolResultEntry("t1", 4, "a2", "call-1"),
      modelChangeEntry("m1", 5, "t1"),
      thinkingChangeEntry("k1", 6, "m1"),
      compactionEntry("c1", 7, "k1"),
      branchSummaryEntry("b1", 8, "c1"),
      userEntry("u2", 9, "b1"),
    ];
    const targets = listTreeTargets(makeSnapshot({ activeLeafId: "u2", entries }));
    expect(targets.map((t) => t.entryId)).toEqual(["u1", "a1", "a2", "t1", "c1", "b1", "u2"]);
    const byId = new Map(targets.map((t) => [t.entryId, t]));
    expect(byId.get("u1")).toMatchObject({ selectable: true, kind: "user" });
    expect(byId.get("a1")).toMatchObject({ selectable: true, kind: "assistant" });
    expect(byId.get("a2")).toMatchObject({ selectable: false, kind: "assistant" }); // 纯 tool-call
    expect(byId.get("t1")).toMatchObject({ selectable: true, kind: "tool_result" });
    expect(byId.get("c1")).toMatchObject({ selectable: false, kind: "compaction" });
    expect(byId.get("b1")).toMatchObject({ selectable: false, kind: "branch_summary" });
    expect(byId.get("u2")).toMatchObject({ selectable: true, kind: "user" });
    // 状态 entry 不出现
    expect(targets.some((t) => t.entryId === "m1" || t.entryId === "k1")).toBe(false);
  });

  // 场景：空 session。预期：空清单。
  it("returns an empty list for an empty session", () => {
    expect(listTreeTargets(makeSnapshot())).toEqual([]);
  });
});

// 场景：TreeTarget 的导航目标计算。预期：user→parentId（draft=content），其他→自身。
describe("listTreeTargets navigation leaf", () => {
  it("normalizes user targets to their parent with a draft", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, "first question"),
      userEntry("u2", 2, "u1", "second question"),
    ];
    const targets = listTreeTargets(makeSnapshot({ activeLeafId: "u2", entries }));
    const u2 = targets.find((t): t is TreeTarget => t.entryId === "u2");
    expect(u2).toMatchObject({ navigationLeafId: "u1", draft: "second question" });
    const u1 = targets.find((t) => t.entryId === "u1");
    expect(u1).toMatchObject({ navigationLeafId: null }); // 根 user 的 parent 是 null
  });

  it("keeps assistant and tool result targets at themselves without a draft", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      assistantEntry("a1", 2, "u1", { content: "answer" }),
      assistantEntry("a2", 3, "a1", { toolCalls: [{ id: tc("c"), name: "x", args: {} }] }),
      toolResultEntry("t1", 4, "a2", "c"),
    ];
    const targets = listTreeTargets(makeSnapshot({ activeLeafId: "t1", entries }));
    const a1 = targets.find((t) => t.entryId === "a1");
    const t1 = targets.find((t) => t.entryId === "t1");
    expect(a1).toMatchObject({ navigationLeafId: "a1" });
    expect(a1?.draft).toBeUndefined();
    expect(t1).toMatchObject({ navigationLeafId: "t1" });
    expect(t1?.draft).toBeUndefined();
  });
});

// 场景：直接导航。预期：成功时 leaf 更新、no-op 不写库、stale/不可导航报错。
describe("navigateDirectly", () => {
  it("navigates to a user target, moving the leaf to its parent and returning a draft", async () => {
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
            content: "a1",
            toolCalls: [],
            model: { provider: "openai", modelId: "gpt-5" },
            stopReason: "completed",
          },
        },
        { entry: { type: "user", content: "q2" } },
      ],
    });
    const loaded = await store.loadSession(snapshot.id);
    const u2 = loaded?.entries.at(-1); // q2 user
    const result = await navigateDirectly({
      store,
      sessionId: snapshot.id,
      targetEntryId: u2?.id ?? "",
    });
    expect(result).toMatchObject({
      ok: true,
      noop: false,
      newLeafId: u2?.parentId,
      draft: "q2",
    });
    const after = await store.loadSession(snapshot.id);
    expect(after?.activeLeafId).toBe(u2?.parentId);
  });

  it("navigates to an assistant target at itself without a draft", async () => {
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
            content: "a1",
            toolCalls: [],
            model: { provider: "openai", modelId: "gpt-5" },
            stopReason: "completed",
          },
        },
        { entry: { type: "user", content: "q2" } }, // leaf = q2，导航目标是 a1（不是当前 leaf）
      ],
    });
    const loaded = await store.loadSession(snapshot.id);
    const a1 = loaded?.entries[1]; // assistant a1
    const result = await navigateDirectly({
      store,
      sessionId: snapshot.id,
      targetEntryId: a1?.id ?? "",
    });
    expect(result).toMatchObject({ ok: true, noop: false, newLeafId: a1?.id });
    expect(
      (result as { ok: true }).ok ? (result as { draft?: string }).draft : undefined,
    ).toBeUndefined();
  });

  it("reports noop when navigating to the current leaf", async () => {
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
            content: "a1",
            toolCalls: [],
            model: { provider: "openai", modelId: "gpt-5" },
            stopReason: "completed",
          },
        },
      ],
    });
    const loaded = await store.loadSession(snapshot.id);
    const a1 = loaded?.entries.at(-1);
    const result = await navigateDirectly({
      store,
      sessionId: snapshot.id,
      targetEntryId: a1?.id ?? "",
    });
    expect(result).toMatchObject({ ok: true, noop: true, newLeafId: a1?.id });
  });

  it("reports noop with a draft when selecting a user whose parent is already the leaf", async () => {
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
        { entry: { type: "user", content: "q2" } },
      ],
    });
    // 先把 leaf 直接设为 q1（q2 的 parent），模拟“当前停留在 q2 的父节点”。
    const before = await store.loadSession(snapshot.id);
    const q1 = before?.entries[0];
    if (q1 === undefined) {
      throw new Error("q1 missing");
    }
    await store.updateLeaf(snapshot.id, q1.id);
    // 现在 leaf = q1；选 q2 归一化到 parent q1 = 当前 leaf → no-op，但回填 q2 内容为草稿。
    const loaded = await store.loadSession(snapshot.id);
    expect(loaded?.activeLeafId).toBe(q1.id);
    const q2 = loaded?.entries.at(-1);
    const result = await navigateDirectly({
      store,
      sessionId: snapshot.id,
      targetEntryId: q2?.id ?? "",
    });
    expect(result).toMatchObject({ ok: true, noop: true, newLeafId: q2?.parentId, draft: "q2" });
  });

  it("reports a navigation error for a stale target", async () => {
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
    const result = await navigateDirectly({
      store,
      sessionId: snapshot.id,
      targetEntryId: "ghost",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("SessionNavigationError");
    }
  });

  it("reports a navigation error for a non-selectable target", async () => {
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
            toolCalls: [{ id: tc("c1"), name: "bash", args: {} }],
            model: { provider: "openai", modelId: "gpt-5" },
            stopReason: "tool_calls",
          },
        },
      ],
    });
    const loaded = await store.loadSession(snapshot.id);
    const pureToolCall = loaded?.entries.at(-1);
    const result = await navigateDirectly({
      store,
      sessionId: snapshot.id,
      targetEntryId: pureToolCall?.id ?? "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("SessionNavigationError");
    }
  });
});
