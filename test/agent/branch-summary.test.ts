import { describe, expect, it } from "vitest";
import {
  InMemorySessionStore,
  SessionLeafConflictError,
  SessionNavigationError,
  SessionNotFoundError,
  SessionStoreError,
  SqliteSessionStore,
  type SessionEntry,
  type SessionSnapshot,
  type SessionStore,
} from "@byte-mentor/session";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "@byte-mentor/core";
import {
  BranchSummaryError,
  navigateWithBranchSummary,
  type PreparedBranchSummary,
  type SummaryModelPort,
  type SummaryRequest,
  type SummaryResponse,
  type RuntimeEnvironment,
} from "@byte-mentor/agent";

// 分支树（与 B7 interval 测试同构）：
// u1(根)
// ├─ a1 → u2 → a2        （分支 A）
// └─ a3 → u3 → a4        （分支 B）
// 会话初始基线 model = gpt-5 / thinking = medium；leaf 默认 a2。
function makeBranchTree(): SessionSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001" as SessionId,
    workspaceRoot: "/w",
    initialProvider: "openai",
    initialModelId: "gpt-5",
    initialThinkingLevel: "medium",
    activeLeafId: "a2",
    nextEntrySeq: 8,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries: [
      {
        id: "u1",
        sequence: 1,
        parentId: null,
        createdAt: "",
        type: "user",
        content: "root q",
      },
      {
        id: "a1",
        sequence: 2,
        parentId: "u1",
        createdAt: "",
        type: "assistant",
        content: "branch a",
        toolCalls: [],
        model: { provider: "openai", modelId: "gpt-5" },
        stopReason: "completed",
      },
      {
        id: "u2",
        sequence: 3,
        parentId: "a1",
        createdAt: "",
        type: "user",
        content: "q2",
      },
      {
        id: "a2",
        sequence: 4,
        parentId: "u2",
        createdAt: "",
        type: "assistant",
        content: "branch a end",
        toolCalls: [],
        model: { provider: "openai", modelId: "gpt-5" },
        stopReason: "completed",
      },
      {
        id: "a3",
        sequence: 5,
        parentId: "u1",
        createdAt: "",
        type: "assistant",
        content: "branch b",
        toolCalls: [],
        model: { provider: "openai", modelId: "gpt-5" },
        stopReason: "completed",
      },
      {
        id: "u3",
        sequence: 6,
        parentId: "a3",
        createdAt: "",
        type: "user",
        content: "q3",
      },
      {
        id: "a4",
        sequence: 7,
        parentId: "u3",
        createdAt: "",
        type: "assistant",
        content: "branch b end",
        toolCalls: [],
        model: { provider: "openai", modelId: "gpt-5" },
        stopReason: "completed",
      },
    ],
  };
}

// 把内存快照灌入 InMemory store；返回 store 与 store 实际生成的 sessionId
// （createSessionWithEntries 生成新随机 ID，不能沿用快照中的 id 字段）。
async function seedStore(snapshot: SessionSnapshot): Promise<{
  store: InMemorySessionStore;
  sessionId: SessionId;
}> {
  const store = new InMemorySessionStore();
  const created = await store.createSessionWithEntries({
    workspaceRoot: snapshot.workspaceRoot,
    initialProvider: snapshot.initialProvider,
    initialModelId: snapshot.initialModelId,
    initialThinkingLevel: snapshot.initialThinkingLevel,
    entries: snapshot.entries,
  });
  // createSessionWithEntries 把 leaf 设为最后一条 entry；恢复快照声明的 active leaf。
  await store.updateLeaf(created.id, snapshot.activeLeafId);
  return { store, sessionId: created.id };
}

// 记录调用次数并可注入行为的摘要端口；默认成功返回固定摘要。
function makePort(behavior?: (request: SummaryRequest) => SummaryResponse): {
  port: SummaryModelPort;
  calls: () => number;
  requests: SummaryRequest[];
} {
  let calls = 0;
  const requests: SummaryRequest[] = [];
  const port: SummaryModelPort = {
    async summarize(request: SummaryRequest) {
      calls += 1;
      requests.push(request);
      return behavior === undefined
        ? { ok: true as const, text: "left branch summary" }
        : behavior(request);
    },
  };
  return { port, calls: () => calls, requests };
}

function makeEnvironment(ok: boolean): RuntimeEnvironment {
  return {
    canExecute: () =>
      ok ? { ok: true as const } : { ok: false as const, reason: "model unavailable" },
  };
}

function summaryEntryOf(snapshot: SessionSnapshot): SessionEntry & { type: "branch_summary" } {
  const entry = snapshot.entries.find((e) => e.type === "branch_summary");
  if (entry === undefined) {
    throw new Error("branch_summary entry not found");
  }
  return entry as SessionEntry & { type: "branch_summary" };
}

// 场景：leaf 在分支 A（a2），带摘要选择分支 B 的 a4（LCA=u1，区间=[a1,u2,a2]）。
// 预期：模型端口被调用（historyText 含区间内容），summary entry 落库
// （parentId=a4、sourceLeafId=a2、model=source 恢复模型、usage 透传），leaf 推进到 summary，
// 重建出的活动路径以 summary 结尾、transcript 以 summary wrapper 结尾、modelState 恢复目标分支状态。
describe("navigateWithBranchSummary success", () => {
  it("commits the summary entry, rebuilds path/transcript/state, and returns the draft for user targets", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    const { port, calls, requests } = makePort();
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("summary");
    expect(calls()).toBe(1);
    expect(requests[0].model).toEqual({ provider: "openai", modelId: "gpt-5" });
    expect(requests[0].thinkingLevel).toBe("medium");
    expect(requests[0].historyText).toContain("branch a");
    expect(requests[0].historyText).toContain("q2");
    expect(requests[0].historyText).toContain("branch a end");
    expect(result.draft).toBeUndefined();
    const loaded = (await store.loadSession(sessionId))!;
    const entry = summaryEntryOf(loaded);
    expect(entry).toMatchObject({
      type: "branch_summary",
      parentId: "a4",
      sourceLeafId: "a2",
      summary: "left branch summary",
      model: { provider: "openai", modelId: "gpt-5" },
    });
    expect(entry.sequence).toBe(8);
    expect(loaded.activeLeafId).toBe(entry.id);
    expect(loaded.nextEntrySeq).toBe(9);
    expect(result.newLeafId).toBe(entry.id);
    if (result.mode !== "summary") throw new Error("unreachable");
    expect(result.path.map((e) => e.id)).toEqual(["u1", "a3", "u3", "a4", entry.id]);
    expect(result.messages[result.messages.length - 1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("<branch_summary>"),
    });
    expect(result.modelState).toEqual({
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "medium",
    });
    expect(result.execution).toEqual({ ok: true });
  });

  it("records usage from the summary response", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    const { port } = makePort(() => ({
      ok: true as const,
      text: "left branch summary",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    }));
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loaded = (await store.loadSession(sessionId))!;
    expect(summaryEntryOf(loaded).usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
  });

  // 场景：leaf 在分支 A，带摘要选择分支 B 的 user u3（目标归一化为 u3.parentId=a3）。
  // 预期：summary entry 的 parentId=a3、成为 leaf；draft=u3 原文；重建路径 = 分支 B + summary。
  it("selecting a user entry makes the summary the leaf and returns the user content as draft", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    const { port } = makePort();
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "u3",
      summarize: port,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("summary");
    expect(result.draft).toBe("q3");
    const loaded = (await store.loadSession(sessionId))!;
    const entry = summaryEntryOf(loaded);
    expect(entry.parentId).toBe("a3");
    expect(entry.sourceLeafId).toBe("a2");
    expect(loaded.activeLeafId).toBe(entry.id);
    if (result.mode !== "summary") throw new Error("unreachable");
    expect(result.path[result.path.length - 1].id).toBe(entry.id);
    // 目标归一化为 u3.parentId=a3：summary 替代 u3 的位置，u3/a4 成为旁支。
    expect(result.path.map((e) => e.id)).toEqual(["u1", "a3", entry.id]);
  });

  // 场景：source 分支（leaf=a2 的祖先链）上 model_change 到 claude，目标分支最后状态仍是 gpt-5。
  // 预期：摘要用 source 恢复出的模型（claude）生成；导航后 modelState 恢复目标分支状态（gpt-5）。
  it("uses the source branch model for generation and restores the target branch state after navigation", async () => {
    const tree = makeBranchTree();
    // 在 u2 与 a2 之间插入 model_change（mc），使 source leaf a2 沿祖先链恢复出 claude-4；
    // 目标分支（a4 的祖先链）无状态 Entry，回落到初始基线 gpt-5。
    tree.entries = [
      tree.entries[0]!,
      tree.entries[1]!,
      tree.entries[2]!,
      {
        id: "mc",
        sequence: 4,
        parentId: "u2",
        createdAt: "",
        type: "model_change",
        model: { provider: "anthropic", modelId: "claude-4" },
      },
      { ...tree.entries[3]!, sequence: 5, parentId: "mc" },
      ...tree.entries.slice(4).map((entry, index) => ({ ...entry, sequence: 6 + index })),
    ];
    tree.nextEntrySeq = 9;
    const { store, sessionId } = await seedStore(tree);
    const { port, requests } = makePort();
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(requests[0].model).toEqual({ provider: "anthropic", modelId: "claude-4" });
    if (result.mode !== "summary") throw new Error("unreachable");
    expect(result.modelState).toEqual({
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "medium",
    });
    const loaded = (await store.loadSession(sessionId))!;
    expect(summaryEntryOf(loaded).model).toEqual({ provider: "anthropic", modelId: "claude-4" });
  });
});

// 场景：模型调用成功后、提交事务开始前 leaf 被并发修改（port 内直接改 leaf 模拟）。
// 预期：SessionLeafConflictError，不写任何 entry、leaf 保持被并发改后的值。
describe("navigateWithBranchSummary stale source", () => {
  it("rejects when the active leaf changed during summary generation", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    const { port } = makePort(() => {
      void store.updateLeaf(sessionId, "u3");
      return { ok: true as const, text: "left branch summary" };
    });
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(SessionLeafConflictError);
    const loaded = (await store.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe("u3");
    expect(loaded.entries.some((e) => e.type === "branch_summary")).toBe(false);
    expect(loaded.nextEntrySeq).toBe(8);
  });
});

// 场景：包装 store 让 commitBranchSummary 第一次抛 busy 存储错误。
// 预期：第一次返回 commit-failed 且携带 prepared（含摘要与目标），模型只调用一次；
// 第二次以 preparedSummary 复用同一摘要重试成功，模型仍只调用一次。
describe("navigateWithBranchSummary commit retry", () => {
  it("reuses the generated summary on retry without calling the model again", async () => {
    const { store: inner, sessionId } = await seedStore(makeBranchTree());
    let commitCalls = 0;
    const failingStore: SessionStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "commitBranchSummary") {
          return async (input: Parameters<SessionStore["commitBranchSummary"]>[0]) => {
            commitCalls += 1;
            if (commitCalls === 1) {
              throw new SessionStoreError("busy", "simulated busy");
            }
            return target.commitBranchSummary(input);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const { port, calls } = makePort();
    const first = await navigateWithBranchSummary({
      store: failingStore,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
    });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toBeInstanceOf(BranchSummaryError);
    const firstError = first.error as BranchSummaryError;
    expect(firstError.kind).toBe("commit-failed");
    expect(firstError.cause).toBeInstanceOf(SessionStoreError);
    expect(firstError.prepared).toEqual({
      summary: "left branch summary",
      model: { provider: "openai", modelId: "gpt-5" },
    });
    expect(calls()).toBe(1);
    const second = await navigateWithBranchSummary({
      store: failingStore,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
      preparedSummary: firstError.prepared as PreparedBranchSummary,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.mode).toBe("summary");
    expect(calls()).toBe(1);
    const loaded = (await inner.loadSession(sessionId))!;
    expect(summaryEntryOf(loaded).summary).toBe("left branch summary");
    expect(loaded.activeLeafId).toBe(summaryEntryOf(loaded).id);
  });

  // 场景：SQLite store 下，模型端口被调用期间打开查询句柄断言 db.inTransaction 为 false。
  // 预期：摘要生成期间没有持有 SQLite 写事务；提交成功后 entry 落库。
  it("does not hold a SQLite transaction while the summary model is running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "byte-mentor-branch-summary-"));
    try {
      const store = new SqliteSessionStore({ dbPath: join(dir, "session.sqlite") });
      const created = await store.createSessionWithEntries({
        workspaceRoot: makeBranchTree().workspaceRoot,
        initialProvider: makeBranchTree().initialProvider,
        initialModelId: makeBranchTree().initialModelId,
        initialThinkingLevel: makeBranchTree().initialThinkingLevel,
        entries: makeBranchTree().entries,
      });
      await store.updateLeaf(created.id, "a2");
      const sessionId = created.id;
      let inTransactionDuringModelCall: boolean | null = null;
      const { port } = makePort(() => {
        inTransactionDuringModelCall = store.dbForTest().inTransaction;
        return { ok: true as const, text: "left branch summary" };
      });
      const result = await navigateWithBranchSummary({
        store,
        sessionId,
        targetEntryId: "a4",
        summarize: port,
      });
      expect(inTransactionDuringModelCall).toBe(false);
      expect(result.ok).toBe(true);
      await store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves the leaf unchanged when the commit fails", async () => {
    const { store: inner, sessionId } = await seedStore(makeBranchTree());
    const failingStore: SessionStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "commitBranchSummary") {
          return async () => {
            throw new SessionStoreError("busy", "simulated busy");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const { port } = makePort();
    const result = await navigateWithBranchSummary({
      store: failingStore,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
    });
    expect(result.ok).toBe(false);
    const loaded = (await inner.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe("a2");
    expect(loaded.entries.some((e) => e.type === "branch_summary")).toBe(false);
    expect(loaded.nextEntrySeq).toBe(8);
  });
});

// 场景：模型端口返回 permanent 错误 / retryable 两次失败 / cancelled。
// 预期：全部映射为 generation-failed，不写 entry、不移动 leaf。
describe("navigateWithBranchSummary generation failures", () => {
  it("does not commit on permanent model errors", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    const { port } = makePort(() => ({
      ok: false as const,
      error: { kind: "permanent", message: "invalid model" },
    }));
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(BranchSummaryError);
    expect((result.error as BranchSummaryError).kind).toBe("generation-failed");
    expect((result.error as BranchSummaryError).cause).toEqual({
      kind: "permanent",
      message: "invalid model",
    });
    const loaded = (await store.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe("a2");
    expect(loaded.entries.some((e) => e.type === "branch_summary")).toBe(false);
  });

  it("does not commit when the retry also fails", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    const { port, calls } = makePort(() => ({
      ok: false as const,
      error: { kind: "retryable", message: "429", retryAfterMs: 0 },
    }));
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as BranchSummaryError).kind).toBe("generation-failed");
    expect((result.error as BranchSummaryError).cause).toMatchObject({ kind: "retryable" });
    expect(calls()).toBe(2);
    const loaded = (await store.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe("a2");
  });

  it("does not commit when the model call is cancelled", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    const { port } = makePort(() => ({ ok: false as const, error: { kind: "cancelled" } }));
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as BranchSummaryError).kind).toBe("generation-failed");
    expect((result.error as BranchSummaryError).cause).toEqual({ kind: "cancelled" });
    const loaded = (await store.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe("a2");
  });

  // 场景：模型返回空白文本。预期：empty-summary，不写 entry、不移动 leaf，也不自动降级为直接导航。
  it("rejects an empty summary without committing or degrading to direct navigation", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    const { port } = makePort(() => ({ ok: true as const, text: "   \n " }));
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as BranchSummaryError).kind).toBe("empty-summary");
    const loaded = (await store.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe("a2");
    expect(loaded.entries.some((e) => e.type === "branch_summary")).toBe(false);
  });

  // 场景：source 恢复出的模型当前不可执行（M5.5）。
  // 预期：model-unavailable，模型端口 0 次调用，leaf 不动。
  it("fails without calling the model when the source model is unavailable", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    const { port, calls } = makePort();
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "a4",
      summarize: port,
      environment: makeEnvironment(false),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as BranchSummaryError).kind).toBe("model-unavailable");
    expect(calls()).toBe(0);
    const loaded = (await store.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe("a2");
  });
});

// 场景：无离开旧分支的情形（M5.3/M5.8）：选当前 leaf；选 user 且其 parent 已是 leaf。
// 预期：mode=noop，不调用模型、不写库；user 时返回草稿。
describe("navigateWithBranchSummary no-op", () => {
  it("selecting the current leaf is a no-op without calling the model", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    const { port, calls } = makePort();
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "a2",
      summarize: port,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("noop");
    expect(result.newLeafId).toBe("a2");
    expect(calls()).toBe(0);
    const loaded = (await store.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe("a2");
    expect(loaded.entries).toHaveLength(7);
  });

  it("selecting a user whose parent is the current leaf only returns the draft", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    await store.updateLeaf(sessionId, "a1");
    const { port, calls } = makePort();
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "u2",
      summarize: port,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("noop");
    expect(result.draft).toBe("q2");
    expect(result.newLeafId).toBe("a1");
    expect(calls()).toBe(0);
  });
});

// 场景：S 是 T 的祖先（沿原分支向下导航，没有离开旧分支，M5.3）。
// 预期：不调用模型，退化为直接导航，leaf 移到 T，重建结果返回。
describe("navigateWithBranchSummary direct fallback", () => {
  it("navigates directly without summarizing when the source is an ancestor of the target", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    await store.updateLeaf(sessionId, "a1");
    const { port, calls } = makePort();
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "a2",
      summarize: port,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("direct");
    expect(result.newLeafId).toBe("a2");
    expect(result.draft).toBeUndefined();
    expect(calls()).toBe(0);
    const loaded = (await store.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe("a2");
    expect(loaded.entries.some((e) => e.type === "branch_summary")).toBe(false);
    if (result.mode !== "direct") throw new Error("unreachable");
    expect(result.path.map((e) => e.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  // 场景：leaf 在 u1，选择 user u2（T=u2.parentId=a1，S=u1 是 T 的祖先）→ 直接导航并回填草稿。
  it("navigates directly and returns the draft for a user target whose parent is an ancestor", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    await store.updateLeaf(sessionId, "u1");
    const { port, calls } = makePort();
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "u2",
      summarize: port,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("direct");
    expect(result.draft).toBe("q2");
    expect(result.newLeafId).toBe("a1");
    expect(calls()).toBe(0);
  });
});

// 场景：输入非法：session 不存在、目标不存在、目标不可选（compaction 可见但不可选）。
// 预期：对应领域错误，模型端口 0 次调用，不写库。
describe("navigateWithBranchSummary invalid input", () => {
  it("fails when the session does not exist", async () => {
    const store = new InMemorySessionStore();
    const { port, calls } = makePort();
    const result = await navigateWithBranchSummary({
      store,
      sessionId: "00000000-0000-4000-8000-000000000099" as SessionId,
      targetEntryId: "a4",
      summarize: port,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(SessionNotFoundError);
    expect(calls()).toBe(0);
  });

  it("fails when the target does not exist", async () => {
    const { store, sessionId } = await seedStore(makeBranchTree());
    const { port, calls } = makePort();
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "missing",
      summarize: port,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(SessionNavigationError);
    expect(calls()).toBe(0);
  });

  it("fails when the target is visible but not selectable", async () => {
    const tree = makeBranchTree();
    tree.entries = [
      ...tree.entries,
      {
        id: "bs1",
        sequence: 8,
        parentId: "a4",
        createdAt: "",
        type: "branch_summary",
        sourceLeafId: "a2",
        summary: "old branch",
        model: { provider: "openai", modelId: "gpt-5" },
      },
    ];
    const { store, sessionId } = await seedStore(tree);
    const { port, calls } = makePort();
    const result = await navigateWithBranchSummary({
      store,
      sessionId,
      targetEntryId: "bs1",
      summarize: port,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(SessionNavigationError);
    expect(calls()).toBe(0);
  });
});
