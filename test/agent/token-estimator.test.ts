import { describe, expect, it } from "vitest";
import type { Message } from "@byte-mentor/core";
import type { ToolDefinition } from "@byte-mentor/agent";
import {
  estimateRequestTokens,
  estimateMessagesWithAnchor,
  type EstimationAnchor,
} from "@byte-mentor/agent";

// 固定 ASCII 文本的估算基准：ASCII 按 chars/4，因此 40 字符 ≈ 10 tokens，
// 加每条消息的固定协议开销。
describe("estimateRequestTokens local estimation", () => {
  it("estimates ASCII text as chars / 4 plus a per-message protocol overhead", () => {
    const messages: Message[] = [
      { role: "user", content: "0123456789012345678901234567890123456789" },
    ];
    const total = estimateRequestTokens({ messages });
    expect(total).toBeGreaterThanOrEqual(10);
    // 两条同内容消息应比一条多出恰好一条消息的协议开销。
    const two = estimateRequestTokens({
      messages: [messages[0]!, messages[0]!],
    });
    expect(two).toBeGreaterThan(total);
    expect(two - total).toBeGreaterThanOrEqual(1);
  });

  it("counts each non-ASCII character as roughly one token", () => {
    // 40 个中文字符：非 ASCII 按 ~1 token → 明显大于 ASCII 同长度的 10。
    const nonAscii: Message[] = [{ role: "user", content: "中文".repeat(20) }];
    const ascii: Message[] = [{ role: "user", content: "a".repeat(40) }];
    const nonAsciiTokens = estimateRequestTokens({ messages: nonAscii });
    const asciiTokens = estimateRequestTokens({ messages: ascii });
    expect(nonAsciiTokens).toBeGreaterThan(asciiTokens);
    expect(nonAsciiTokens).toBeGreaterThanOrEqual(40);
  });

  it("adds tool definitions and schema to the estimate", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const withoutTools = estimateRequestTokens({ messages });
    const tools: ToolDefinition[] = [
      {
        name: "search",
        description: "Search the workspace",
        parametersJsonSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ];
    const withTools = estimateRequestTokens({ messages, tools });
    expect(withTools).toBeGreaterThan(withoutTools);
  });

  it("adds the system prompt to the estimate", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const withoutSystem = estimateRequestTokens({ messages });
    const withSystem = estimateRequestTokens({
      messages,
      systemPrompt: "You are an expert coding assistant.",
    });
    expect(withSystem).toBeGreaterThan(withoutSystem);
  });

  it("estimates tool-call arguments with stable JSON serialization", () => {
    const stableArgs: Message[] = [
      {
        role: "assistant",
        content: "calling",
        toolCalls: [{ id: "c1" as never, name: "search", args: { b: 1, a: 2 } }],
      },
      { role: "tool", toolCallId: "c1" as never, content: "result" },
    ];
    const a = estimateRequestTokens({ messages: stableArgs });
    const reordered: Message[] = [
      {
        role: "assistant",
        content: "calling",
        toolCalls: [{ id: "c1" as never, name: "search", args: { a: 2, b: 1 } }],
      },
      { role: "tool", toolCallId: "c1" as never, content: "result" },
    ];
    expect(estimateRequestTokens({ messages: reordered })).toBe(a);
  });
});

// 场景：存在合法 usage 锚点（最近一次位于当前有效上下文、同模型成功生成）。
// 预期：估算 = 锚点 total + 其后新增消息的本地估算，不再全量重算。
describe("estimateMessagesWithAnchor", () => {
  it("estimates from the anchor total plus messages after the anchor", () => {
    // 锚点 total 显著小于全量估算：锚点覆盖 user 消息，只有 assistant 是新增。
    const anchor: EstimationAnchor = {
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
      model: { provider: "openai", modelId: "gpt-4o" },
    };
    const messages: Message[] = [
      { role: "user", content: "a".repeat(40) },
      { role: "assistant", content: "b".repeat(40) },
    ];
    const estimated = estimateMessagesWithAnchor({
      messages,
      anchor,
      anchorEndsAtIndex: 1,
    });
    const fresh = estimateRequestTokens({ messages });
    // 10 + assistant 新增 ≈ 24 < 全量 28：证明只估算锚点之后的消息。
    expect(estimated).toBeGreaterThan(10);
    expect(estimated).toBeLessThan(fresh);
    expect(estimated).toBeLessThanOrEqual(10 + estimateRequestTokens({ messages: [messages[1]!] }));
  });

  it("ignores the anchor when the model changed", () => {
    const anchor: EstimationAnchor = {
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      model: { provider: "openai", modelId: "gpt-4o" },
    };
    const messages: Message[] = [{ role: "user", content: "hi" }];
    expect(
      estimateMessagesWithAnchor({
        messages,
        anchor,
        anchorEndsAtIndex: 0,
        model: { provider: "openai", modelId: "gpt-5" },
      }),
    ).toBe(estimateRequestTokens({ messages }));
  });
});
