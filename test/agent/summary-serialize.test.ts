import { describe, expect, it } from "vitest";
import { serializeSummaryInput, truncateToolResultForSummary } from "@byte-mentor/agent";
import type { SessionEntry } from "@byte-mentor/session";
import type { ToolCallId } from "@byte-mentor/core";

function userEntry(
  id: string,
  seq: number,
  parentId: string | null,
  content: string,
): SessionEntry {
  return { id, sequence: seq, parentId, createdAt: "", type: "user", content };
}

function assistantEntry(
  id: string,
  seq: number,
  parentId: string | null,
  opts: { content?: string; toolCalls?: { id: string; name: string; args: unknown }[] } = {},
): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "assistant",
    content: opts.content ?? "",
    toolCalls: (opts.toolCalls ?? []) as { id: ToolCallId; name: string; args: unknown }[],
    model: { provider: "openai", modelId: "gpt-5" },
    stopReason: opts.toolCalls && opts.toolCalls.length > 0 ? "tool_calls" : "completed",
  };
}

function toolResultEntry(
  id: string,
  seq: number,
  parentId: string,
  content: string,
  isError = false,
): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "tool_result",
    toolCallId: "call-1" as ToolCallId,
    toolName: "bash",
    content,
    isError,
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

function branchSummaryEntry(
  id: string,
  seq: number,
  parentId: string | null,
  summary: string,
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

function compactionEntry(id: string, seq: number, parentId: string, summary: string): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "compaction",
    summary,
    firstKeptEntryId: null,
    tokensBefore: 100,
    trigger: "manual",
    model: { provider: "openai", modelId: "gpt-5" },
  };
}

// 场景：普通 Entry 序列化。预期：带角色标签的纯文本，状态 Entry 排除。
describe("serializeSummaryInput basic", () => {
  it("serializes user, assistant, and tool result with role tags, skipping state entries", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, "hello"),
      assistantEntry("a1", 2, "u1", { content: "hi there" }),
      modelChangeEntry("m1", 3, "a1"),
      toolResultEntry("t1", 4, "a1", "tool output"),
    ];
    const text = serializeSummaryInput(entries);
    expect(text).toContain("<user>hello</user>");
    expect(text).toContain("<assistant>hi there</assistant>");
    expect(text).toContain("<tool_result>tool output</tool_result>");
    expect(text).not.toContain("model_change");
  });

  it("includes tool calls in assistant serialization", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, "q"),
      assistantEntry("a1", 2, "u1", {
        content: "",
        toolCalls: [{ id: "c1", name: "bash", args: { command: "ls" } }],
      }),
    ];
    const text = serializeSummaryInput(entries);
    expect(text).toContain("bash");
    expect(text).toContain("ls");
  });
});

// 场景：branch_summary 与 compaction 的序列化。预期：包含其 summary 文本；Compaction 按最后一次生效。
describe("serializeSummaryInput summaries", () => {
  it("includes branch summary text", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, "q"),
      branchSummaryEntry("b1", 2, "u1", "branch work summary"),
    ];
    const text = serializeSummaryInput(entries);
    expect(text).toContain("branch work summary");
  });

  it("uses the last compaction summary instead of expanding older history", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", 1, null, "old message before first compaction"),
      compactionEntry("c1", 2, "u1", "first summary"),
      userEntry("u2", 3, "c1", "newer message"),
      compactionEntry("c2", 4, "u2", "second summary"),
      userEntry("u3", 5, "c2", "latest message"),
    ];
    const text = serializeSummaryInput(entries);
    // 只有最后一个 compaction 生效：c2 的 summary 在，c1 的 summary 不在
    expect(text).toContain("second summary");
    expect(text).not.toContain("first summary");
    // c2 之后的原文保留
    expect(text).toContain("latest message");
  });
});

// 场景：ToolResult 截断。预期：2000 字符上限 + 标记原长度；不修改原始 entry。
describe("truncateToolResultForSummary", () => {
  it("keeps short results unchanged", () => {
    expect(truncateToolResultForSummary("short")).toBe("short");
  });

  it("truncates long results to 2000 chars with a marker", () => {
    const long = "x".repeat(5000);
    const result = truncateToolResultForSummary(long);
    expect(result.length).toBeLessThanOrEqual(2000 + 64);
    expect(result).toContain("[truncated: original 5000 chars]");
  });

  it("does not modify the original entry content", () => {
    const original = "x".repeat(5000);
    const entry = toolResultEntry("t1", 1, "u1", original);
    truncateToolResultForSummary(original);
    expect(entry).toMatchObject({ type: "tool_result", content: original });
  });
});
