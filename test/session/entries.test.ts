import { describe, expect, it } from "vitest";
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

// 场景：构造一个最小 UserEntry。预期：discriminator 为 "user"、content 必填且原样保留。
describe("UserEntry", () => {
  it("carries the user discriminator and required content", () => {
    const entry: UserEntry = {
      id: "u1",
      sequence: 1,
      parentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "user",
      content: "hello",
    };
    expect(entry.type).toBe("user");
    expect(entry.content).toBe("hello");
  });
});

// 场景：构造一个最小 AssistantEntry。预期：content 与 toolCalls 为必填空值（""/[]），
// 而非可选字段，保证持久化后不区分 missing 与 empty。
describe("AssistantEntry", () => {
  it("requires empty defaults for content and toolCalls", () => {
    const entry: AssistantEntry = {
      id: "a1",
      sequence: 2,
      parentId: "u1",
      createdAt: "2026-01-01T00:00:01.000Z",
      type: "assistant",
      content: "",
      toolCalls: [],
      model: { provider: "openai", modelId: "gpt-5" },
      stopReason: "completed",
    };
    expect(entry.content).toBe("");
    expect(entry.toolCalls).toEqual([]);
    expect(entry.model.modelId).toBe("gpt-5");
    expect(entry.stopReason).toBe("completed");
  });

  // 场景：AssistantEntry 携带 usage 与带文本的 assistant 消息。预期：usage 与 content 原样保留。
  it("carries optional usage and text content", () => {
    const entry: AssistantEntry = {
      id: "a2",
      sequence: 3,
      parentId: "a1",
      createdAt: "2026-01-01T00:00:02.000Z",
      type: "assistant",
      content: "working on it",
      toolCalls: [],
      model: { provider: "openai", modelId: "gpt-5" },
      stopReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    };
    expect(entry.content).toBe("working on it");
    expect(entry.usage?.totalTokens).toBe(30);
  });
});

// 场景：一个 AssistantEntry 内嵌多个 tool call。预期：id/name/args 原样保留，tool call 不拆成独立 entry。
describe("AssistantEntry toolCalls", () => {
  it("embeds multiple tool calls with id, name, and args", () => {
    const entry: AssistantEntry = {
      id: "a3",
      sequence: 4,
      parentId: "u1",
      createdAt: "2026-01-01T00:00:03.000Z",
      type: "assistant",
      content: "",
      toolCalls: [
        { id: tc("call-1"), name: "bash", args: { command: "ls" } },
        { id: tc("call-2"), name: "read_file", args: { path: "a.ts" } },
      ],
      model: { provider: "openai", modelId: "gpt-5" },
      stopReason: "tool_calls",
    };
    expect(entry.toolCalls).toHaveLength(2);
    expect(entry.toolCalls[0].name).toBe("bash");
    expect(entry.toolCalls[1].args).toEqual({ path: "a.ts" });
  });
});

// 场景：构造一个 ToolResultEntry。预期：toolCallId/toolName/content/isError 原样保留。
describe("ToolResultEntry", () => {
  it("carries toolCallId, toolName, content, and isError", () => {
    const entry: ToolResultEntry = {
      id: "t1",
      sequence: 5,
      parentId: "a3",
      createdAt: "2026-01-01T00:00:04.000Z",
      type: "tool_result",
      toolCallId: tc("call-1"),
      toolName: "bash",
      content: "done",
      isError: false,
    };
    expect(entry.toolCallId).toBe(tc("call-1"));
    expect(entry.toolName).toBe("bash");
    expect(entry.content).toBe("done");
    expect(entry.isError).toBe(false);
  });
});

// 场景：构造 ModelChangeEntry 与 ThinkingLevelChangeEntry。预期：各自携带 model/level 字段。
describe("state entries", () => {
  it("ModelChangeEntry carries a ModelRef", () => {
    const entry: ModelChangeEntry = {
      id: "m1",
      sequence: 6,
      parentId: "u1",
      createdAt: "2026-01-01T00:00:05.000Z",
      type: "model_change",
      model: { provider: "anthropic", modelId: "claude-opus" },
    };
    expect(entry.model.provider).toBe("anthropic");
  });

  it("ThinkingLevelChangeEntry carries a ThinkingLevel", () => {
    const entry: ThinkingLevelChangeEntry = {
      id: "k1",
      sequence: 7,
      parentId: "m1",
      createdAt: "2026-01-01T00:00:06.000Z",
      type: "thinking_level_change",
      level: "high",
    };
    expect(entry.level).toBe("high");
  });
});

// 场景：构造 CompactionEntry。预期：firstKeptEntryId 可为 null、trigger 限 manual/automatic、
// tokensBefore 必填、model/usage 原样保留。
describe("CompactionEntry", () => {
  it("carries summary, nullable firstKeptEntryId, trigger, tokensBefore, model, and usage", () => {
    const entry: CompactionEntry = {
      id: "c1",
      sequence: 8,
      parentId: "u1",
      createdAt: "2026-01-01T00:00:07.000Z",
      type: "compaction",
      summary: "compressed history",
      firstKeptEntryId: "u2",
      tokensBefore: 12000,
      trigger: "manual",
      model: { provider: "openai", modelId: "gpt-5" },
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    };
    expect(entry.firstKeptEntryId).toBe("u2");
    expect(entry.tokensBefore).toBe(12000);
    expect(entry.trigger).toBe("manual");
  });

  it("allows firstKeptEntryId to be null", () => {
    const entry: CompactionEntry = {
      id: "c2",
      sequence: 9,
      parentId: "u1",
      createdAt: "2026-01-01T00:00:08.000Z",
      type: "compaction",
      summary: "no retained tail",
      firstKeptEntryId: null,
      tokensBefore: 500,
      trigger: "automatic",
      model: { provider: "openai", modelId: "gpt-5" },
    };
    expect(entry.firstKeptEntryId).toBeNull();
    expect(entry.trigger).toBe("automatic");
  });
});

// 场景：构造 BranchSummaryEntry。预期：sourceLeafId 可为 null、summary 必填、model/usage 原样保留。
describe("BranchSummaryEntry", () => {
  it("carries summary, nullable sourceLeafId, model, and usage", () => {
    const entry: BranchSummaryEntry = {
      id: "b1",
      sequence: 10,
      parentId: "u2",
      createdAt: "2026-01-01T00:00:09.000Z",
      type: "branch_summary",
      sourceLeafId: "a5",
      summary: "branch work summarized",
      model: { provider: "openai", modelId: "gpt-5" },
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
    };
    expect(entry.sourceLeafId).toBe("a5");
    expect(entry.summary).toBe("branch work summarized");
  });

  it("allows sourceLeafId to be null", () => {
    const entry: BranchSummaryEntry = {
      id: "b2",
      sequence: 11,
      parentId: "u2",
      createdAt: "2026-01-01T00:00:10.000Z",
      type: "branch_summary",
      sourceLeafId: null,
      summary: "forked summary",
      model: { provider: "openai", modelId: "gpt-5" },
    };
    expect(entry.sourceLeafId).toBeNull();
  });
});

// 场景：以字面量缺失 content 的 UserEntry 赋给 UserEntry。预期：编译期拒绝，证明必填字段约束生效。
describe("entry type strictness", () => {
  it("rejects UserEntry missing content at compile time", () => {
    // @ts-expect-error content is required on UserEntry
    const entry: UserEntry = {
      id: "u-x",
      sequence: 1,
      parentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "user",
    };
    expect(entry as object).toBeDefined();
  });

  // 场景：把非法的 discriminator 字面量赋给 SessionEntry。预期：编译期拒绝，证明 union 是封闭的。
  it("rejects an unknown discriminator at compile time", () => {
    const entry: SessionEntry = {
      id: "x",
      sequence: 1,
      parentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      // @ts-expect-error "unknown_type" is not a SessionEntry discriminator
      type: "unknown_type",
      content: "x",
    };
    expect(entry as object).toBeDefined();
  });
});

// 场景：把七种 entry 放入同一个 SessionEntry 数组并按 type 收窄。预期：union 按 discriminator
// 正确收窄，各成员字段可访问（仿 core messages.test.ts 的收窄模式）。
describe("SessionEntry union narrowing", () => {
  it("narrows by type discriminator across all seven kinds", () => {
    const entries: SessionEntry[] = [
      {
        id: "e1",
        sequence: 1,
        parentId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "user",
        content: "q",
      },
      {
        id: "e2",
        sequence: 2,
        parentId: "e1",
        createdAt: "2026-01-01T00:00:01.000Z",
        type: "assistant",
        content: "",
        toolCalls: [],
        model: { provider: "openai", modelId: "gpt-5" },
        stopReason: "completed",
      },
      {
        id: "e3",
        sequence: 3,
        parentId: "e1",
        createdAt: "2026-01-01T00:00:02.000Z",
        type: "model_change",
        model: { provider: "openai", modelId: "gpt-5" },
      },
      {
        id: "e4",
        sequence: 4,
        parentId: "e1",
        createdAt: "2026-01-01T00:00:03.000Z",
        type: "thinking_level_change",
        level: "low",
      },
      {
        id: "e5",
        sequence: 5,
        parentId: "e1",
        createdAt: "2026-01-01T00:00:04.000Z",
        type: "tool_result",
        toolCallId: tc("call-9"),
        toolName: "bash",
        content: "ok",
        isError: false,
      },
      {
        id: "e6",
        sequence: 6,
        parentId: "e1",
        createdAt: "2026-01-01T00:00:05.000Z",
        type: "compaction",
        summary: "s",
        firstKeptEntryId: null,
        tokensBefore: 10,
        trigger: "manual",
        model: { provider: "openai", modelId: "gpt-5" },
      },
      {
        id: "e7",
        sequence: 7,
        parentId: "e1",
        createdAt: "2026-01-01T00:00:06.000Z",
        type: "branch_summary",
        sourceLeafId: null,
        summary: "s",
        model: { provider: "openai", modelId: "gpt-5" },
      },
    ];
    const user = entries.find((e): e is UserEntry => e.type === "user");
    const assistant = entries.find((e): e is AssistantEntry => e.type === "assistant");
    const modelChange = entries.find((e): e is ModelChangeEntry => e.type === "model_change");
    const thinking = entries.find(
      (e): e is ThinkingLevelChangeEntry => e.type === "thinking_level_change",
    );
    const toolResult = entries.find((e): e is ToolResultEntry => e.type === "tool_result");
    const compaction = entries.find((e): e is CompactionEntry => e.type === "compaction");
    const branchSummary = entries.find((e): e is BranchSummaryEntry => e.type === "branch_summary");
    expect(user?.content).toBe("q");
    expect(assistant?.stopReason).toBe("completed");
    expect(modelChange?.model.provider).toBe("openai");
    expect(thinking?.level).toBe("low");
    expect(toolResult?.toolName).toBe("bash");
    expect(compaction?.trigger).toBe("manual");
    expect(branchSummary?.summary).toBe("s");
  });
});
