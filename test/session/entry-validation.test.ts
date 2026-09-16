import { describe, expect, it } from "vitest";
import { validateSessionEntries, type EntryValidationResult } from "@byte-mentor/session";
import type {
  AssistantEntry,
  BranchSummaryEntry,
  CompactionEntry,
  ModelChangeEntry,
  SessionEntry,
  ThinkingLevelChangeEntry,
  ToolResultEntry,
  UserEntry,
} from "@byte-mentor/session";
import type { ToolCallId } from "@byte-mentor/core";

// 测试工具：把字符串字面量提升为品牌化 ToolCallId（运行时就是普通字符串）。
function tc(id: string): ToolCallId {
  return id as ToolCallId;
}

interface EntryOverrides {
  id?: string;
  sequence?: number;
  parentId?: string | null;
  type?: SessionEntry["type"];
}

// 测试工具：构造一个默认 UserEntry，再按 overrides 覆盖公共字段，方便快速制造违规输入。
function makeEntry(overrides: EntryOverrides = {}): UserEntry {
  return {
    id: overrides.id ?? "u1",
    sequence: overrides.sequence ?? 1,
    parentId: overrides.parentId === undefined ? null : overrides.parentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "user",
    content: "hello",
  };
}

function makeUser(id: string, sequence: number, parentId: string | null): UserEntry {
  return {
    id,
    sequence,
    parentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "user",
    content: "hello",
  };
}

function makeAssistant(
  id: string,
  sequence: number,
  parentId: string | null,
  toolCalls: AssistantEntry["toolCalls"] = [],
): AssistantEntry {
  return {
    id,
    sequence,
    parentId,
    createdAt: "2026-01-01T00:00:01.000Z",
    type: "assistant",
    content: "",
    toolCalls,
    model: { provider: "openai", modelId: "gpt-5" },
    stopReason: toolCalls.length > 0 ? "tool_calls" : "completed",
  };
}

function makeToolResult(
  id: string,
  sequence: number,
  parentId: string,
  toolCallId: ToolCallId,
  toolName = "bash",
): ToolResultEntry {
  return {
    id,
    sequence,
    parentId,
    createdAt: "2026-01-01T00:00:02.000Z",
    type: "tool_result",
    toolCallId,
    toolName,
    content: "result",
    isError: false,
  };
}

function makeModelChange(id: string, sequence: number, parentId: string | null): ModelChangeEntry {
  return {
    id,
    sequence,
    parentId,
    createdAt: "2026-01-01T00:00:03.000Z",
    type: "model_change",
    model: { provider: "openai", modelId: "gpt-5" },
  };
}

function makeThinkingChange(
  id: string,
  sequence: number,
  parentId: string | null,
): ThinkingLevelChangeEntry {
  return {
    id,
    sequence,
    parentId,
    createdAt: "2026-01-01T00:00:04.000Z",
    type: "thinking_level_change",
    level: "high",
  };
}

function makeCompaction(
  id: string,
  sequence: number,
  parentId: string | null,
  firstKeptEntryId: string | null,
): CompactionEntry {
  return {
    id,
    sequence,
    parentId,
    createdAt: "2026-01-01T00:00:05.000Z",
    type: "compaction",
    summary: "compacted",
    firstKeptEntryId,
    tokensBefore: 1000,
    trigger: "manual",
    model: { provider: "openai", modelId: "gpt-5" },
  };
}

function makeBranchSummary(
  id: string,
  sequence: number,
  parentId: string | null,
  sourceLeafId: string | null,
): BranchSummaryEntry {
  return {
    id,
    sequence,
    parentId,
    createdAt: "2026-01-01T00:00:06.000Z",
    type: "branch_summary",
    sourceLeafId,
    summary: "branch summary",
    model: { provider: "openai", modelId: "gpt-5" },
  };
}

// 断言辅助：只关心 ok 与错误 code 集合，不依赖错误消息文案与报告顺序。
function expectCodes(result: EntryValidationResult, codes: string[]): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.map((e) => e.code).sort()).toEqual([...codes].sort());
  }
}

// 场景：一棵包含多根、多分支和全部七种 Entry 的合法树。预期：校验通过，不产生任何错误。
describe("validateSessionEntries valid trees", () => {
  it("accepts a tree containing all seven entry kinds and multiple branches", () => {
    const entries: SessionEntry[] = [
      makeUser("u1", 1, null),
      makeAssistant("a1", 2, "u1", [{ id: tc("call-1"), name: "bash", args: {} }]),
      makeToolResult("t1", 3, "a1", tc("call-1")),
      makeModelChange("m1", 4, "u1"),
      makeThinkingChange("k1", 5, "m1"),
      makeCompaction("c1", 6, "a1", "t1"),
      makeBranchSummary("b1", 7, "u1", "a1"),
      makeUser("u2", 8, "c1"),
      makeUser("u3", 9, null),
    ];
    expect(validateSessionEntries(entries)).toEqual({ ok: true });
  });

  // 场景：parentId 为 null 的根可以出现多次（多根分支），且空 parentId 数组合法。
  it("accepts multiple roots and an empty input", () => {
    expect(validateSessionEntries([makeUser("u1", 1, null), makeUser("u2", 2, null)])).toEqual({
      ok: true,
    });
    expect(validateSessionEntries([])).toEqual({ ok: true });
  });
});

// 场景：两个 entry 使用相同 id。预期：返回 duplicate-id 错误并定位到后出现的 entry。
describe("validateSessionEntries id integrity", () => {
  it("reports duplicate entry ids", () => {
    const result = validateSessionEntries([makeUser("u1", 1, null), makeUser("u1", 2, null)]);
    expectCodes(result, ["duplicate-id"]);
    if (!result.ok) {
      expect(result.errors.find((e) => e.code === "duplicate-id")?.entryId).toBe("u1");
    }
  });
});

// 场景：两个 entry 使用相同 sequence。预期：返回 duplicate-sequence 错误。
describe("validateSessionEntries sequence integrity", () => {
  it("reports duplicate sequences", () => {
    const result = validateSessionEntries([makeUser("u1", 1, null), makeUser("u2", 1, null)]);
    expectCodes(result, ["duplicate-sequence"]);
  });

  // 场景：sequence 为 0 或负数（违反 schema 的 entry_seq > 0）。预期：返回 non-positive-sequence。
  it("reports non-positive sequences", () => {
    const result = validateSessionEntries([makeEntry({ id: "u1", sequence: 0 })]);
    expectCodes(result, ["non-positive-sequence"]);
  });
});

// 场景：entry 的 parentId 指向自身。预期：返回 self-parent 错误。
describe("validateSessionEntries parent integrity", () => {
  it("reports self-parent references", () => {
    const result = validateSessionEntries([makeUser("u1", 1, "u1")]);
    expectCodes(result, ["self-parent"]);
  });

  // 场景：entry 的 parentId 指向树中不存在的 entry。预期：返回 missing-parent 错误。
  it("reports parents that do not exist in the tree", () => {
    const result = validateSessionEntries([makeUser("u1", 1, "ghost")]);
    expectCodes(result, ["missing-parent"]);
  });

  // 场景：parent 的 sequence 等于 child 时必然同时触发 duplicate-sequence；大于 child 时只触发
  // parent-after-child。两种情况都验证父必须严格早于子。
  it("reports parents whose sequence is not strictly earlier than the child", () => {
    const equalSeq = validateSessionEntries([makeUser("u1", 2, null), makeUser("u2", 2, "u1")]);
    expectCodes(equalSeq, ["parent-after-child", "duplicate-sequence"]);

    const laterSeq = validateSessionEntries([makeUser("u1", 2, null), makeUser("u2", 1, "u1")]);
    expectCodes(laterSeq, ["parent-after-child"]);
  });
});

// 场景：ToolResultEntry.toolCallId 在整棵树中找不到对应 AssistantEntry 的 tool call。
// 预期：返回 dangling-tool-call。B1 只校验树级存在性；活动祖先路径校验属于 B4。
describe("validateSessionEntries tool-call references", () => {
  it("reports tool results whose toolCallId has no matching tool call in the tree", () => {
    const result = validateSessionEntries([
      makeUser("u1", 1, null),
      makeToolResult("t1", 2, "u1", tc("call-ghost")),
    ]);
    expectCodes(result, ["dangling-tool-call"]);
    if (!result.ok) {
      expect(result.errors.find((e) => e.code === "dangling-tool-call")?.entryId).toBe("t1");
    }
  });

  // 场景：toolCallId 匹配到树中某个 AssistantEntry 的 tool call。预期：通过。
  it("accepts tool results whose toolCallId matches an assistant tool call", () => {
    const entries: SessionEntry[] = [
      makeUser("u1", 1, null),
      makeAssistant("a1", 2, "u1", [{ id: tc("call-1"), name: "bash", args: {} }]),
      makeToolResult("t1", 3, "a1", tc("call-1")),
    ];
    expect(validateSessionEntries(entries)).toEqual({ ok: true });
  });
});

// 场景：BranchSummaryEntry.sourceLeafId 指向树中不存在的 entry。预期：返回 dangling-source-leaf；
// 指向树内节点或为 null 时通过。
describe("validateSessionEntries branch summary references", () => {
  it("reports sourceLeafId pointing outside the tree", () => {
    const result = validateSessionEntries([
      makeUser("u1", 1, null),
      makeBranchSummary("b1", 2, "u1", "ghost-leaf"),
    ]);
    expectCodes(result, ["dangling-source-leaf"]);
  });

  it("accepts null or in-tree sourceLeafId", () => {
    const entries: SessionEntry[] = [
      makeUser("u1", 1, null),
      makeUser("u2", 2, "u1"),
      makeBranchSummary("b1", 3, "u1", "u2"),
      makeBranchSummary("b2", 4, "u1", null),
    ];
    expect(validateSessionEntries(entries)).toEqual({ ok: true });
  });
});

// 场景：CompactionEntry.firstKeptEntryId 指向树中不存在的 entry。预期：返回 dangling-first-kept；
// 指向树内节点或为 null 时通过。
describe("validateSessionEntries compaction references", () => {
  it("reports firstKeptEntryId pointing outside the tree", () => {
    const result = validateSessionEntries([
      makeUser("u1", 1, null),
      makeCompaction("c1", 2, "u1", "ghost-kept"),
    ]);
    expectCodes(result, ["dangling-first-kept"]);
  });

  it("accepts null or in-tree firstKeptEntryId", () => {
    const entries: SessionEntry[] = [
      makeUser("u1", 1, null),
      makeUser("u2", 2, "u1"),
      makeCompaction("c1", 3, "u1", "u2"),
      makeCompaction("c2", 4, "u1", null),
    ];
    expect(validateSessionEntries(entries)).toEqual({ ok: true });
  });
});

// 场景：同一输入同时存在多种违规。预期：一次返回全部错误，不因首个错误截断。
describe("validateSessionEntries multi-error reporting", () => {
  it("reports all violations in a single pass", () => {
    const result = validateSessionEntries([
      makeUser("u1", 1, "ghost"), // missing-parent
      makeUser("u2", 1, null), // duplicate-sequence
      makeToolResult("t1", 3, "u1", tc("call-ghost")), // dangling-tool-call
      makeBranchSummary("b1", 4, "u1", "ghost-leaf"), // dangling-source-leaf
    ]);
    expectCodes(result, [
      "missing-parent",
      "duplicate-sequence",
      "dangling-tool-call",
      "dangling-source-leaf",
    ]);
  });

  // 场景：非法输入调用校验函数。预期：不抛异常，返回结构化 { ok: false, errors }。
  it("never throws and always returns a structured result", () => {
    const result = validateSessionEntries([makeEntry({ id: "u1", sequence: 0, parentId: "u1" })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      for (const error of result.errors) {
        expect(error).toHaveProperty("code");
        expect(error).toHaveProperty("entryId");
        expect(error).toHaveProperty("message");
      }
    }
  });
});
