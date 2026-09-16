import { describe, expect, it } from "vitest";
import type { ModelRef, ToolCallId } from "@byte-mentor/core";
import { buildCompactionSummaryPrompt, planCompaction } from "@byte-mentor/agent";
import type { SessionEntry } from "@byte-mentor/session";

const MODEL: ModelRef = { provider: "openai", modelId: "gpt-5" };

function text(length: number, character = "x"): string {
  return character.repeat(length);
}

function userEntry(
  id: string,
  sequence: number,
  parentId: string | null,
  content: string,
): SessionEntry {
  return { id, sequence, parentId, createdAt: "", type: "user", content };
}

function assistantEntry(
  id: string,
  sequence: number,
  parentId: string,
  content: string,
  toolCalls: { id: string; name: string; args: unknown }[] = [],
): SessionEntry {
  return {
    id,
    sequence,
    parentId,
    createdAt: "",
    type: "assistant",
    content,
    toolCalls: toolCalls as { id: ToolCallId; name: string; args: unknown }[],
    model: MODEL,
    stopReason: toolCalls.length > 0 ? "tool_calls" : "completed",
  };
}

function toolResultEntry(
  id: string,
  sequence: number,
  parentId: string,
  toolCallId: string,
  content: string,
): SessionEntry {
  return {
    id,
    sequence,
    parentId,
    createdAt: "",
    type: "tool_result",
    toolCallId: toolCallId as ToolCallId,
    toolName: "bash",
    content,
    isError: false,
  };
}

function modelChangeEntry(id: string, sequence: number, parentId: string): SessionEntry {
  return {
    id,
    sequence,
    parentId,
    createdAt: "",
    type: "model_change",
    model: MODEL,
  };
}

function compactionEntry(
  id: string,
  sequence: number,
  parentId: string,
  summary: string,
): SessionEntry {
  return {
    id,
    sequence,
    parentId,
    createdAt: "",
    type: "compaction",
    summary,
    firstKeptEntryId: null,
    tokensBefore: 100,
    trigger: "manual",
    model: MODEL,
  };
}

// 场景：预算在旧交互段与新交互段之间。预期：从 UserEntry 开始保留完整的最新交互段。
describe("planCompaction cut points", () => {
  // 场景：预算在旧交互段与新交互段之间。预期：从 UserEntry 开始保留完整的最新交互段。
  it("keeps a complete interaction segment from UserEntry", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, text(80, "a")),
      assistantEntry("a1", 2, "u1", text(80, "b")),
      userEntry("u2", 3, "a1", text(20, "c")),
      assistantEntry("a2", 4, "u2", text(20, "d")),
    ];

    const result = planCompaction({ path: entries, keepRecentTokens: 15 });

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode === "noop") return;
    expect(result.plan.firstKeptEntryId).toBe("u2");
    expect(result.plan.summarizedEntries.map((entry) => entry.id)).toEqual(["u1", "a1"]);
    expect(result.plan.retainedEntries.map((entry) => entry.id)).toEqual(["u2", "a2"]);
  });

  // 场景：预算落在同一批多个 ToolResult 中。预期：切点回退到产生该批的 AssistantEntry，保留整批工具协议。
  it("backs up from a ToolResult to its AssistantEntry and keeps the complete tool batch", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, text(80, "a")),
      assistantEntry("a1", 2, "u1", "", [
        { id: "call-1", name: "bash", args: { command: "one" } },
        { id: "call-2", name: "bash", args: { command: "two" } },
      ]),
      toolResultEntry("t1", 3, "a1", "call-1", text(20, "b")),
      toolResultEntry("t2", 4, "a1", "call-2", text(20, "c")),
    ];

    const result = planCompaction({ path: entries, keepRecentTokens: 15 });

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode === "noop") return;
    expect(result.plan.firstKeptEntryId).toBe("a1");
    expect(result.plan.retainedEntries.map((entry) => entry.id)).toEqual(["a1", "t1", "t2"]);
    expect(result.plan.retainedEntries.some((entry) => entry.type === "tool_result")).toBe(true);
    expect(result.plan.retainedEntries[0]?.type).toBe("assistant");
  });

  // 场景：一条 Runtime Turn 形成多个 UserEntry。预期：Compaction 仍按 UserEntry 划分交互段，不把整轮事务当作一个段。
  it("splits multiple user interactions independently of Runtime Turn grouping", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, "first"),
      assistantEntry("a1", 2, "u1", "first reply"),
      userEntry("u2", 3, "a1", "second"),
      assistantEntry("a2", 4, "u2", "second reply"),
      userEntry("u3", 5, "a2", "third"),
      assistantEntry("a3", 6, "u3", "third reply"),
    ];

    const result = planCompaction({ path: entries, keepRecentTokens: 21 });

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode === "noop") return;
    expect(result.plan.firstKeptEntryId).toBe("u2");
    expect(result.plan.retainedEntries.map((entry) => entry.id)).toEqual(["u2", "a2", "u3", "a3"]);
  });

  // 场景：最新交互段的尾部本身已达到预算。预期：允许从 AssistantEntry 切分，并生成交互前缀摘要输入。
  it("creates an Interaction Prefix Summary when the cut falls inside an interaction", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, text(80, "a")),
      assistantEntry("a1", 2, "u1", text(80, "b")),
      userEntry("u2", 3, "a1", "please preserve this request"),
      assistantEntry("a2", 4, "u2", text(80, "c")),
    ];

    const result = planCompaction({ path: entries, keepRecentTokens: 20 });

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode === "noop") return;
    expect(result.plan.firstKeptEntryId).toBe("a2");
    expect(result.plan.summaryInput).toContain("<interaction_prefix>");
    expect(result.plan.summaryInput).toContain("please preserve this request");
  });

  // 场景：状态 Entry 位于被压缩内容中。预期：它不成为切点，运行时状态仍由完整活动路径回放。
  it("never chooses a model or thinking state entry as the cut point", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, text(80, "a")),
      modelChangeEntry("m1", 2, "u1"),
      assistantEntry("a1", 3, "m1", text(80, "b")),
    ];

    const result = planCompaction({ path: entries, keepRecentTokens: 20 });

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode === "noop") return;
    expect(result.plan.firstKeptEntryId).toBe("a1");
    expect(result.plan.firstKeptEntryId).not.toBe("m1");
    expect(result.plan.summarizedEntries.map((entry) => entry.id)).toEqual(["u1", "m1"]);
  });
});

// 场景：活动路径已有 Compaction。预期：新摘要携带旧 summary，只增量纳入旧保留尾部中本次被压掉的内容。
describe("planCompaction incremental summaries", () => {
  // 场景：活动路径已有 Compaction。预期：新摘要携带旧 summary，只增量纳入旧保留尾部中本次被压掉的内容。
  it("merges the previous compaction summary without re-expanding older history", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, "history that the old compaction already replaced"),
      compactionEntry("c1", 2, "u1", "previous goal and completed work"),
      userEntry("u2", 3, "c1", "new constraints"),
      assistantEntry("a2", 4, "u2", text(80, "b")),
      userEntry("u3", 5, "a2", "latest request"),
      assistantEntry("a3", 6, "u3", "latest answer"),
    ];

    const result = planCompaction({ path: entries, keepRecentTokens: 15 });

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode === "noop") return;
    expect(result.plan.previousSummary).toBe("previous goal and completed work");
    expect(result.plan.firstKeptEntryId).toBe("u3");
    expect(result.plan.summaryInput).toContain("previous goal and completed work");
    expect(result.plan.summaryInput).toContain("new constraints");
    expect(result.plan.summaryInput).not.toContain(
      "history that the old compaction already replaced",
    );
  });
});

// 场景：摘要提示词需要固定结构。预期：包含所有首版摘要章节，并明确历史内容只可总结不可继续执行。
describe("compaction summary prompt", () => {
  // 场景：摘要提示词需要固定结构。预期：包含所有首版摘要章节，并明确历史内容只可总结不可继续执行。
  it("contains the fixed summary structure and non-execution instruction", () => {
    const prompt = buildCompactionSummaryPrompt();

    expect(prompt).toContain("Goal");
    expect(prompt).toContain("Constraints & Preferences");
    expect(prompt).toContain("Progress");
    expect(prompt).toContain("Key Decisions");
    expect(prompt).toContain("Files and External State");
    expect(prompt).toContain("Errors and Failed Attempts");
    expect(prompt).toContain("Next Steps");
    expect(prompt).toContain("Critical Context");
    expect(prompt).toMatch(/only summarize|do not continue/i);
  });
});

// 场景：被压缩区间含超长 ToolResult。预期：摘要输入截断单条结果但不修改 Session Entry 原文。
describe("planCompaction summary input", () => {
  // 场景：被压缩区间含超长 ToolResult。预期：摘要输入截断单条结果但不修改 Session Entry 原文。
  it("truncates a long ToolResult in summary input while preserving the source entry", () => {
    const toolOutput = text(5_000, "z");
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, "inspect the workspace"),
      assistantEntry("a1", 2, "u1", "", [{ id: "call-1", name: "bash", args: { command: "pwd" } }]),
      toolResultEntry("t1", 3, "a1", "call-1", toolOutput),
      userEntry("u2", 4, "t1", "continue"),
      assistantEntry("a2", 5, "u2", "done"),
    ];

    const result = planCompaction({ path: entries, keepRecentTokens: 5 });

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode === "noop") return;
    expect(result.plan.summaryInput).toContain("[truncated: original 5000 chars]");
    expect(result.plan.summaryInput).not.toContain(toolOutput);
    expect(entries[2]).toMatchObject({ type: "tool_result", content: toolOutput });
  });

  // 场景：ToolResult 截断后摘要输入仍超过预算。预期：返回明确的 summary-input-overflow，不静默丢弃普通历史。
  it("fails explicitly when the serialized summary input still exceeds its budget", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, text(300, "a")),
      assistantEntry("a1", 2, "u1", text(300, "b")),
      userEntry("u2", 3, "a1", "latest"),
      assistantEntry("a2", 4, "u2", "answer"),
    ];

    const result = planCompaction({
      path: entries,
      keepRecentTokens: 15,
      summaryInputBudget: 10,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "summary-input-overflow" },
    });
  });
});

// 场景：完整活动上下文未超过保留预算。预期：返回 no-op，不生成切点或摘要输入。
describe("planCompaction no-op", () => {
  // 场景：完整活动上下文未超过保留预算。预期：返回 no-op，不生成切点或摘要输入。
  it("returns no-op when there is no compressible historical content", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, "hello"),
      assistantEntry("a1", 2, "u1", "hi"),
    ];

    expect(planCompaction({ path: entries, keepRecentTokens: 10_000 })).toEqual({
      ok: true,
      mode: "noop",
      reason: "no-compressible-content",
    });
  });
});
