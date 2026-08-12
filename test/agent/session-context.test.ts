import { describe, expect, it } from "vitest";
import { applyCompaction, buildProviderContext, mapEntriesToMessages } from "@byte-mentor/agent";
import type { SessionSnapshot } from "@byte-mentor/session";
import type { SessionEntry } from "@byte-mentor/session";
import type { SessionId, ToolCallId } from "@byte-mentor/core";

// 测试工具：把字符串字面量提升为品牌化 ToolCallId。
function tc(id: string): ToolCallId {
  return id as ToolCallId;
}

// 测试工具：构造最小 SessionSnapshot（基线 openai/gpt-5/medium）。
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
  opts: {
    content?: string;
    toolCalls?: { id: ToolCallId; name: string; args: unknown }[];
    stopReason?: "completed" | "tool_calls" | "failed" | "cancelled";
  } = {},
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
    stopReason:
      opts.stopReason ?? (opts.toolCalls && opts.toolCalls.length > 0 ? "tool_calls" : "completed"),
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

function modelChangeEntry(id: string, seq: number, parentId: string | null): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "model_change",
    model: { provider: "openai", modelId: "claude-opus" },
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

function compactionEntry(
  id: string,
  seq: number,
  parentId: string,
  firstKeptEntryId: string | null,
  summary = "compacted history",
): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "compaction",
    summary,
    firstKeptEntryId,
    tokensBefore: 1000,
    trigger: "manual",
    model: { provider: "openai", modelId: "gpt-5" },
  };
}

function branchSummaryEntry(
  id: string,
  seq: number,
  parentId: string,
  summary = "branch summary",
): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "branch_summary",
    sourceLeafId: null,
    summary,
    model: { provider: "openai", modelId: "gpt-5" },
  };
}

// 场景：普通 Entry 映射为统一 Message。预期：user/assistant/tool 对应消息，Entry ID 作为 Message ID。
describe("mapEntriesToMessages ordinary entries", () => {
  it("maps user, assistant, and tool result entries to messages with entry ids", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      assistantEntry("a1", 2, "u1", { content: "answer" }),
      assistantEntry("a2", 3, "a1", {
        toolCalls: [{ id: tc("call-1"), name: "bash", args: { command: "ls" } }],
      }),
      toolResultEntry("t1", 4, "a2", "call-1"),
    ];
    const messages = mapEntriesToMessages(entries);
    expect(messages).toEqual([
      { id: "u1", role: "user", content: "user u1" },
      { id: "a1", role: "assistant", content: "answer", toolCalls: [] },
      {
        id: "a2",
        role: "assistant",
        content: "",
        toolCalls: [{ id: tc("call-1"), name: "bash", args: { command: "ls" } }],
      },
      { id: "t1", role: "tool", toolCallId: tc("call-1"), content: "result t1" },
    ]);
  });

  // 场景：状态 Entry。预期：不生成任何消息。
  it("skips model change and thinking level change entries", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      modelChangeEntry("m1", 2, "u1"),
      thinkingChangeEntry("k1", 3, "m1"),
      assistantEntry("a1", 4, "k1", { content: "done" }),
    ];
    expect(mapEntriesToMessages(entries)).toEqual([
      { id: "u1", role: "user", content: "user u1" },
      { id: "a1", role: "assistant", content: "done", toolCalls: [] },
    ]);
  });
});

// 场景：Branch Summary 与 Compaction Entry 映射为固定 wrapper 的 UserMessage。
describe("mapEntriesToMessages summary wrappers", () => {
  it("maps a branch summary entry to a fixed user-message wrapper", () => {
    const entries: SessionEntry[] = [userEntry("u1", 1, null), branchSummaryEntry("b1", 2, "u1")];
    const messages = mapEntriesToMessages(entries);
    expect(messages[1]).toEqual({
      id: "b1",
      role: "user",
      content:
        "The following is a summary of a branch that this conversation returned from:\n\n<branch_summary>\nbranch summary\n</branch_summary>",
    });
  });

  it("maps a compaction entry to a fixed user-message wrapper", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      compactionEntry("c1", 2, "u1", null),
    ];
    const messages = mapEntriesToMessages(entries);
    expect(messages[1]).toEqual({
      id: "c1",
      role: "user",
      content:
        "The conversation history before this point was compacted into the following summary:\n\n<compaction_summary>\ncompacted history\n</compaction_summary>",
    });
  });
});

// 场景：路径含全部七种 Entry。预期：顺序正确、无状态消息、wrapper 就位。
describe("mapEntriesToMessages all kinds", () => {
  it("maps a path containing all seven entry kinds in order", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      assistantEntry("a1", 2, "u1", { content: "hi" }),
      modelChangeEntry("m1", 3, "a1"),
      thinkingChangeEntry("k1", 4, "m1"),
      compactionEntry("c1", 5, "k1", null),
      toolResultEntry("t1", 6, "c1", "call-x"),
      branchSummaryEntry("b1", 7, "t1"),
      userEntry("u2", 8, "b1"),
    ];
    const messages = mapEntriesToMessages(entries);
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1", "c1", "t1", "b1", "u2"]);
    const compactionContent = messages.find((m) => m.id === "c1")?.content ?? "";
    expect(compactionContent).toContain("<compaction_summary>");
    const branchContent = messages.find((m) => m.id === "b1")?.content ?? "";
    expect(branchContent).toContain("<branch_summary>");
  });
});

// 场景：无 Compaction。预期：裁剪返回全部路径 Entry。
describe("applyCompaction without compaction", () => {
  it("returns the full path when there is no compaction entry", () => {
    const entries = [userEntry("u1", 1, null), assistantEntry("a1", 2, "u1", { content: "x" })];
    expect(applyCompaction(entries)).toEqual({ ok: true, entries });
  });
});

// 场景：有 Compaction 且 firstKeptEntryId 指向路径中。预期：[C] + [K..C) + (C..leaf]。
describe("applyCompaction with compaction", () => {
  it("keeps [C] + [K..C) + (C..leaf]", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null), // 被压掉（K 之前）
      assistantEntry("a1", 2, "u1", { content: "old" }), // 被压掉
      userEntry("u2", 3, "a1"), // K = firstKeptEntryId
      assistantEntry("a2", 4, "u2", { content: "kept tail" }),
      compactionEntry("c1", 5, "a2", "u2"),
      userEntry("u3", 6, "c1"), // C 之后
      assistantEntry("a3", 7, "u3", { content: "new" }),
    ];
    const result = applyCompaction(entries);
    expect(result).toEqual({
      ok: true,
      entries: [
        entries[4], // C
        entries[2], // K
        entries[3], // K..C
        entries[5], // C 之后
        entries[6],
      ],
    });
  });

  // 场景：firstKeptEntryId = null。预期：只保留 [C] + (C..leaf]，无尾部。
  it("drops the retained tail when firstKeptEntryId is null", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      assistantEntry("a1", 2, "u1", { content: "old" }),
      compactionEntry("c1", 3, "a1", null),
      userEntry("u2", 4, "c1"),
    ];
    const result = applyCompaction(entries);
    expect(result).toEqual({ ok: true, entries: [entries[2], entries[3]] });
  });

  // 场景：多个 Compaction。预期：只有最后一个生效（旧的被新摘要替代）。
  it("only the last compaction controls the context", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      compactionEntry("c1", 2, "u1", null, "first summary"),
      userEntry("u2", 3, "c1"),
      compactionEntry("c2", 4, "u2", null, "second summary"),
      userEntry("u3", 5, "c2"),
    ];
    const result = applyCompaction(entries);
    expect(result).toEqual({ ok: true, entries: [entries[3], entries[4]] });
  });

  // 场景：firstKeptEntryId 不在路径中或晚于 C。预期：SessionCorruptedError。
  it("reports corruption when firstKeptEntryId is outside the path", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      compactionEntry("c1", 2, "u1", "ghost-kept"),
    ];
    const result = applyCompaction(entries);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("SessionCorruptedError");
    }
  });

  it("reports corruption when firstKeptEntryId is not strictly before the compaction", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      userEntry("u2", 2, "u1"),
      compactionEntry("c1", 3, "u2", "u3"), // firstKept 指向 C 之后的 u3（非法）
      userEntry("u3", 4, "c1"),
    ];
    const result = applyCompaction(entries);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("SessionCorruptedError");
    }
  });
});

// 场景：非活动分支上的 Compaction（不在 path 里）。预期：不生效（applyCompaction 只处理传入的路径）。
describe("applyCompaction branch isolation", () => {
  it("ignores compaction entries not on the provided path", () => {
    const path = [userEntry("u1", 1, null), assistantEntry("a1", 2, "u1", { content: "x" })];
    // 分支 A 上的 compaction 不在 path 中，自然不生效
    expect(applyCompaction(path)).toEqual({ ok: true, entries: path });
  });
});

// 场景：完整流水线。预期：路径→状态→裁剪→映射，返回 Message[]、ModelState 与执行判定。
describe("buildProviderContext pipeline", () => {
  it("rebuilds messages, model state, and execution verdict from snapshot and path", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      modelChangeEntry("m1", 2, "u1"),
      assistantEntry("a1", 3, "m1", { content: "answer" }),
    ];
    const snapshot = makeSnapshot({ activeLeafId: "a1", entries });
    const result = buildProviderContext(snapshot, entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages).toEqual([
        { id: "u1", role: "user", content: "user u1" },
        { id: "a1", role: "assistant", content: "answer", toolCalls: [] },
      ]);
      expect(result.modelState).toEqual({
        model: { provider: "openai", modelId: "claude-opus" },
        thinkingLevel: "medium",
      });
      expect(result.execution).toEqual({ ok: true });
    }
  });

  // 场景：环境判定不可用。预期：流水线返回阻塞原因（Session 不判定损坏）。
  it("reports a blocking execution verdict when the environment cannot run the state", () => {
    const entries: SessionEntry[] = [userEntry("u1", 1, null), modelChangeEntry("m1", 2, "u1")];
    const snapshot = makeSnapshot({ activeLeafId: "m1", entries });
    const environment = {
      canExecute: () => ({ ok: false as const, reason: "model unavailable" }),
    };
    const result = buildProviderContext(snapshot, entries, environment);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.execution).toEqual({ ok: false, reason: "model unavailable" });
    }
  });

  // 场景：路径损坏（firstKept 非法）。预期：流水线返回 SessionCorruptedError。
  it("fails with corruption when the path is not compactable", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null),
      compactionEntry("c1", 2, "u1", "ghost"),
    ];
    const snapshot = makeSnapshot({ activeLeafId: "c1", entries });
    const result = buildProviderContext(snapshot, entries);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("SessionCorruptedError");
    }
  });
});
