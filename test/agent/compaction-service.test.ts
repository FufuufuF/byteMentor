import { describe, expect, it } from "vitest";
import type { ModelRef, SessionId } from "@byte-mentor/core";
import {
  CompactionError,
  compactSession,
  prepareCompaction,
  type CompactionPathEntry,
  type PreparedCompaction,
  type RuntimeEnvironment,
  type SummaryModelPort,
  type SummaryRequest,
  type SummaryResponse,
} from "@byte-mentor/agent";
import type {
  PendingSessionEntry,
  SessionEntry,
  SessionSnapshot,
  SessionStore,
} from "@byte-mentor/session";
import {
  InMemorySessionStore,
  SessionLeafConflictError,
  SessionStoreError,
} from "@byte-mentor/session";

const MODEL: ModelRef = { provider: "openai", modelId: "gpt-5" };
const ALT_MODEL: ModelRef = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

function longText(character: string): string {
  return character.repeat(80);
}

function makePendingPath(withModelChange = false): PendingSessionEntry[] {
  const user = {
    id: "u1",
    parentId: null,
    createdAt: "2026-01-01T00:00:00.001Z",
    type: "user" as const,
    content: longText("u"),
  };
  if (!withModelChange) {
    return [
      user,
      {
        id: "a1",
        parentId: "u1",
        createdAt: "2026-01-01T00:00:00.002Z",
        type: "assistant",
        content: longText("a"),
        toolCalls: [],
        model: MODEL,
        stopReason: "completed",
      },
      {
        id: "u2",
        parentId: "a1",
        createdAt: "2026-01-01T00:00:00.003Z",
        type: "user",
        content: "recent request",
      },
      {
        id: "a2",
        parentId: "u2",
        createdAt: "2026-01-01T00:00:00.004Z",
        type: "assistant",
        content: "recent answer",
        toolCalls: [],
        model: MODEL,
        stopReason: "completed",
      },
    ];
  }
  return [
    user,
    {
      id: "m1",
      parentId: "u1",
      createdAt: "2026-01-01T00:00:00.002Z",
      type: "model_change",
      model: ALT_MODEL,
    },
    {
      id: "a1",
      parentId: "m1",
      createdAt: "2026-01-01T00:00:00.003Z",
      type: "assistant",
      content: longText("a"),
      toolCalls: [],
      model: ALT_MODEL,
      stopReason: "completed",
    },
    {
      id: "u2",
      parentId: "a1",
      createdAt: "2026-01-01T00:00:00.004Z",
      type: "user",
      content: "recent request",
    },
    {
      id: "a2",
      parentId: "u2",
      createdAt: "2026-01-01T00:00:00.005Z",
      type: "assistant",
      content: "recent answer",
      toolCalls: [],
      model: ALT_MODEL,
      stopReason: "completed",
    },
  ];
}

function materializePath(entries: PendingSessionEntry[]): SessionEntry[] {
  return entries.map((entry, index) => ({ ...entry, sequence: index + 1 }) as SessionEntry);
}

function makeSnapshot(entries: SessionEntry[]): SessionSnapshot {
  const leaf = entries.at(-1)?.id ?? null;
  return {
    id: "00000000-0000-4000-8000-000000000001" as SessionId,
    workspaceRoot: "/workspace",
    initialProvider: MODEL.provider,
    initialModelId: MODEL.modelId,
    initialThinkingLevel: "medium",
    activeLeafId: leaf,
    nextEntrySeq: entries.length + 1,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries,
  };
}

async function seedStore(entries = materializePath(makePendingPath())): Promise<{
  store: InMemorySessionStore;
  sessionId: SessionId;
}> {
  const store = new InMemorySessionStore();
  const snapshot = makeSnapshot(entries);
  const created = await store.createSessionWithEntries({
    workspaceRoot: snapshot.workspaceRoot,
    initialProvider: snapshot.initialProvider,
    initialModelId: snapshot.initialModelId,
    initialThinkingLevel: snapshot.initialThinkingLevel,
    entries,
  });
  return { store, sessionId: created.id };
}

function makePort(
  behavior: (request: SummaryRequest) => SummaryResponse | Promise<SummaryResponse> = () => ({
    ok: true,
    text: "compaction summary",
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  }),
): { port: SummaryModelPort; calls: () => number; requests: SummaryRequest[] } {
  let callCount = 0;
  const requests: SummaryRequest[] = [];
  return {
    requests,
    calls: () => callCount,
    port: {
      async summarize(request) {
        callCount += 1;
        requests.push(request);
        return behavior(request);
      },
    },
  };
}

function makePrepareInput(
  path: readonly CompactionPathEntry[],
  summarize: SummaryModelPort,
  overrides: Partial<Parameters<typeof prepareCompaction>[0]> = {},
): Parameters<typeof prepareCompaction>[0] {
  return {
    path,
    model: MODEL,
    thinkingLevel: "medium",
    trigger: "automatic",
    summarize,
    keepRecentTokens: 8,
    maxSummaryOutputTokens: 512,
    ...overrides,
  };
}

function makeUnavailableEnvironment(): RuntimeEnvironment {
  return { canExecute: () => ({ ok: false, reason: "model unavailable" }) };
}

// 场景 16：Turn 内 Compaction 成功准备 pending Entry。预期：身份、parent、摘要元数据和请求契约完整，且准备阶段没有 Store 输入。
describe("prepareCompaction", () => {
  it("returns a stable pending compaction without touching a session store", async () => {
    const { port, requests } = makePort();
    const controller = new AbortController();
    const result = await prepareCompaction(
      makePrepareInput(makePendingPath(), port, {
        trigger: "automatic",
        signal: controller.signal,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode === "noop") throw new Error("expected prepared compaction");
    expect(result.prepared.entry).toMatchObject({
      type: "compaction",
      parentId: "a2",
      firstKeptEntryId: "a2",
      summary: "compaction summary",
      trigger: "automatic",
      model: MODEL,
      tokensBefore: expect.any(Number),
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    expect(result.prepared.entry.id).toEqual(expect.any(String));
    expect(result.prepared.entry.createdAt).toEqual(expect.any(String));
    expect("sequence" in result.prepared.entry).toBe(false);
    expect(result.prepared.workingMessages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("<compaction_summary>"),
    });
    expect(requests[0]).toMatchObject({
      instructions: expect.stringContaining("Only summarize"),
      historyText: expect.stringContaining("<history>"),
      model: MODEL,
      thinkingLevel: "medium",
      maxOutputTokens: 512,
    });
    expect(requests[0].signal).toBe(controller.signal);
  });

  // 场景 17：pending Compaction 的 firstKeptEntryId 指向同一 Turn 更早的 pending Entry。
  // 预期：准备结果保持该引用，并返回应用新压缩节点后的 working messages。
  it("can reference an earlier pending entry and returns the compacted working context", async () => {
    const path = makePendingPath();
    const { port } = makePort();
    const result = await prepareCompaction(makePrepareInput(path, port));

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode === "noop") throw new Error("expected prepared compaction");
    expect(path.some((entry) => entry.id === result.prepared.entry.firstKeptEntryId)).toBe(true);
    expect(result.prepared.workingMessages.map((message) => message.id)).toEqual([
      result.prepared.entry.id,
      "a2",
    ]);
  });

  // 场景 18：摘要失败或取消。预期：不返回 pending Compaction，不修改原 pending 链。
  it("does not produce an entry when summary generation fails or is cancelled", async () => {
    for (const response of [
      { ok: false as const, error: { kind: "permanent" as const, message: "summary unavailable" } },
      { ok: false as const, error: { kind: "cancelled" as const } },
    ]) {
      const path = makePendingPath();
      const original = structuredClone(path);
      const { port } = makePort(() => response);
      const result = await prepareCompaction(makePrepareInput(path, port));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected generation failure");
      expect(result.error).toBeInstanceOf(CompactionError);
      expect((result.error as CompactionError).kind).toBe("generation-failed");
      expect(path).toEqual(original);
    }
  });

  // 场景 19：摘要为空。预期：返回 empty-summary，不形成 durable/pending 结果。
  it("rejects an empty summary as a non-durable result", async () => {
    const { port } = makePort(() => ({ ok: true as const, text: " \n " }));
    const result = await prepareCompaction(makePrepareInput(makePendingPath(), port));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected empty summary failure");
    expect(result.error).toBeInstanceOf(CompactionError);
    expect((result.error as CompactionError).kind).toBe("empty-summary");
  });
});

// 场景 20/26：空闲期手动 Compaction 在事务外生成摘要，提交后重建 active path、messages、状态和 token 估算。
describe("compactSession", () => {
  it("generates outside the commit boundary and rebuilds the compacted context", async () => {
    const { store: inner, sessionId } = await seedStore(materializePath(makePendingPath(true)));
    const order: string[] = [];
    const { port, requests } = makePort(() => {
      order.push("summary");
      return { ok: true as const, text: "manual summary" };
    });
    const store = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === "commitCompaction") {
          return async (input: Parameters<SessionStore["commitCompaction"]>[0]) => {
            order.push("commit");
            return target.commitCompaction(input);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as SessionStore;

    const result = await compactSession({
      store,
      sessionId,
      summarize: port,
      trigger: "manual",
      keepRecentTokens: 8,
      maxSummaryOutputTokens: 512,
    });

    expect(order).toEqual(["summary", "commit"]);
    expect(requests[0].model).toEqual(ALT_MODEL);
    expect(result.ok).toBe(true);
    if (!result.ok || result.mode === "noop") throw new Error("expected committed compaction");
    expect(result.entryId).toEqual(expect.any(String));
    expect(result.path.at(-1)).toMatchObject({
      type: "compaction",
      summary: "manual summary",
      parentId: "a2",
      trigger: "manual",
      model: ALT_MODEL,
    });
    expect(result.messages[0]).toMatchObject({
      id: result.entryId,
      role: "user",
      content: expect.stringContaining("<compaction_summary>"),
    });
    expect(result.modelState).toEqual({ model: ALT_MODEL, thinkingLevel: "medium" });
    expect(result.execution).toEqual({ ok: true });
    expect(result.estimatedTokens).toEqual(expect.any(Number));
    const loaded = (await inner.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe(result.entryId);
    expect(loaded.entries.at(-1)).toMatchObject({ summary: "manual summary" });
  });

  // 场景 21：没有可压缩内容。预期：友好 no-op，不调用摘要模型、不写 Entry。
  it("returns a no-op without a model call when there is no compressible content", async () => {
    const statusEntry = materializePath([
      {
        id: "m1",
        parentId: null,
        createdAt: "2026-01-01T00:00:00.001Z",
        type: "model_change",
        model: MODEL,
      },
    ]);
    const { store, sessionId } = await seedStore(statusEntry);
    const { port, calls } = makePort();

    const result = await compactSession({
      store,
      sessionId,
      summarize: port,
      trigger: "manual",
      keepRecentTokens: 8,
    });

    expect(result).toEqual({ ok: true, mode: "noop", reason: "no-compressible-content" });
    expect(calls()).toBe(0);
    const loaded = (await store.loadSession(sessionId))!;
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.activeLeafId).toBe("m1");
  });

  // 场景 22：恢复出的模型当前不可执行。预期：model-unavailable，摘要模型调用次数为零。
  it("does not call the summary model when the current model is unavailable", async () => {
    const { store, sessionId } = await seedStore();
    const { port, calls } = makePort();

    const result = await compactSession({
      store,
      sessionId,
      summarize: port,
      environment: makeUnavailableEnvironment(),
      trigger: "manual",
      keepRecentTokens: 8,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unavailable model");
    expect(result.error).toBeInstanceOf(CompactionError);
    expect((result.error as CompactionError).kind).toBe("model-unavailable");
    expect(calls()).toBe(0);
  });

  // 场景 23：摘要生成失败或取消。预期：generation-failed，不写 Compaction、不移动 leaf。
  it("does not commit when summary generation fails", async () => {
    const { store, sessionId } = await seedStore();
    const { port } = makePort(() => ({
      ok: false as const,
      error: { kind: "permanent" as const, message: "provider failed" },
    }));

    const result = await compactSession({
      store,
      sessionId,
      summarize: port,
      trigger: "manual",
      keepRecentTokens: 8,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected generation failure");
    expect((result.error as CompactionError).kind).toBe("generation-failed");
    const loaded = (await store.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe("a2");
    expect(loaded.entries.some((entry) => entry.type === "compaction")).toBe(false);
  });

  // 场景 24：摘要成功后 source leaf 变化。预期：SessionLeafConflictError，不写 Compaction。
  it("rejects a stale source leaf after summary generation", async () => {
    const { store, sessionId } = await seedStore();
    const { port } = makePort(async () => {
      await store.updateLeaf(sessionId, "u2");
      return { ok: true as const, text: "stale summary" };
    });

    const result = await compactSession({
      store,
      sessionId,
      summarize: port,
      trigger: "automatic",
      keepRecentTokens: 8,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected stale leaf failure");
    expect(result.error).toBeInstanceOf(SessionLeafConflictError);
    const loaded = (await store.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe("u2");
    expect(loaded.entries.some((entry) => entry.type === "compaction")).toBe(false);
  });

  // 场景 25：提交失败后复用 PreparedCompaction。预期：摘要和 Entry ID 保持不变，模型不重复调用。
  it("returns a prepared result on commit failure and reuses it on retry", async () => {
    const { store: inner, sessionId } = await seedStore();
    let commitCalls = 0;
    const failingStore = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === "commitCompaction") {
          return async (input: Parameters<SessionStore["commitCompaction"]>[0]) => {
            commitCalls += 1;
            if (commitCalls === 1) throw new SessionStoreError("busy", "simulated busy");
            return target.commitCompaction(input);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as SessionStore;
    const { port, calls } = makePort();

    const first = await compactSession({
      store: failingStore,
      sessionId,
      summarize: port,
      trigger: "manual",
      keepRecentTokens: 8,
    });
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected commit failure");
    expect(first.error).toBeInstanceOf(CompactionError);
    const prepared = (first.error as CompactionError).prepared as PreparedCompaction;
    expect(prepared.entry.id).toEqual(expect.any(String));
    expect(prepared.entry.summary).toBe("compaction summary");
    expect(calls()).toBe(1);

    const second = await compactSession({
      store: failingStore,
      sessionId,
      summarize: port,
      trigger: "manual",
      keepRecentTokens: 8,
      preparedCompaction: prepared,
    });
    expect(second.ok).toBe(true);
    if (!second.ok || second.mode === "noop") throw new Error("expected retry success");
    expect(second.entryId).toBe(prepared.entry.id);
    expect(calls()).toBe(1);
    expect(commitCalls).toBe(2);
    const loaded = (await inner.loadSession(sessionId))!;
    expect(loaded.activeLeafId).toBe(prepared.entry.id);
  });
});
