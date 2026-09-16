import { describe, expect, it } from "vitest";
import type { Message } from "@byte-mentor/core";
import type { TokenUsage } from "@byte-mentor/core";
import {
  CompactionUnavailableError,
  computeTokenBudget,
  estimateMessagesWithAnchor,
  estimateRequestTokens,
  shouldCompact,
  type ModelCapabilities,
} from "@byte-mentor/agent";

const KNOWN_CAPS: ModelCapabilities = { contextWindow: 128_000, maxOutputTokens: 16_384 };

function makeMessages(totalChars: number): Message[] {
  const content = "a".repeat(totalChars);
  return [{ role: "user", content }];
}

// 场景：已知 context window 时使用动态默认预算（M6.3）。
// 预期：reserve/keepRecent 按比例并封顶；maxSummaryOutputTokens 取 8192、reserve 一半、模型
// maxOutputTokens 三者最小值；模型没有已知输出上限时忽略该项约束。
describe("computeTokenBudget", () => {
  it("computes dynamic defaults capped by fixed upper bounds", () => {
    const budget = computeTokenBudget(KNOWN_CAPS);
    expect(budget.reserveTokens).toBe(16_384);
    expect(budget.keepRecentTokens).toBe(20_000);
    expect(budget.maxSummaryOutputTokens).toBe(8_192);
    expect(budget.triggerThresholdTokens).toBe(128_000 - 16_384);
  });

  it("caps reserve by the context window for small windows", () => {
    const budget = computeTokenBudget({ contextWindow: 8_000 });
    expect(budget.reserveTokens).toBe(2_000);
    expect(budget.maxSummaryOutputTokens).toBe(1_000);
  });

  it("ignores the model maxOutputTokens constraint when it is unknown", () => {
    const budget = computeTokenBudget({ contextWindow: 128_000 });
    expect(budget.maxSummaryOutputTokens).toBe(8_192);
  });
});

// 场景：预测请求 token 与安全阈值比较（M6.3）。
// 预期：超过 contextWindow - reserveTokens 触发自动压缩；未超过不触发。
describe("shouldCompact", () => {
  it("triggers when the estimated request exceeds the safe threshold", () => {
    const messages = makeMessages(128_000 * 4);
    const result = shouldCompact({
      messages,
      capabilities: { kind: "known", capabilities: KNOWN_CAPS },
      model: { provider: "openai", modelId: "gpt-4o" },
    });
    expect(result).toEqual({
      shouldCompact: true,
      estimatedTokens: expect.any(Number),
      overflow: true,
    });
    expect(result.estimatedTokens).toBeGreaterThan(128_000 - 16_384);
  });

  it("does not trigger below the safe threshold", () => {
    const messages = makeMessages(1_000);
    const result = shouldCompact({
      messages,
      capabilities: { kind: "known", capabilities: KNOWN_CAPS },
      model: { provider: "openai", modelId: "gpt-4o" },
    });
    expect(result.shouldCompact).toBe(false);
  });

  it("reports overflow when the estimate exceeds the context window", () => {
    const result = shouldCompact({
      messages: makeMessages(128_000 * 4),
      capabilities: { kind: "known", capabilities: KNOWN_CAPS },
      model: { provider: "openai", modelId: "gpt-4o" },
    });
    expect(result.overflow).toBe(true);
  });

  it("uses the anchor estimate when a valid anchor is provided", () => {
    const anchor = {
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      model: { provider: "openai", modelId: "gpt-4o" },
    };
    const result = shouldCompact({
      messages: makeMessages(1_000),
      capabilities: { kind: "known", capabilities: KNOWN_CAPS },
      model: { provider: "openai", modelId: "gpt-4o" },
      anchor,
      anchorEndsAtIndex: 0,
    });
    // 锚点 150 + 其后一条消息 → 远低于阈值 → 不触发。
    expect(result.shouldCompact).toBe(false);
  });
});

// 场景：未知模型（M6.1）。
// 预期：不启用基于阈值的自动压缩、不假定默认窗口；手动压缩仍可尽力执行（返回估算与预算）。
describe("shouldCompact unknown model", () => {
  it("does not enable automatic compaction for unknown models", () => {
    const result = shouldCompact({
      messages: makeMessages(1_000_000),
      capabilities: { kind: "unknown" },
      model: { provider: "openai", modelId: "gpt-2027" },
    });
    expect(result).toMatchObject({ shouldCompact: false, estimatedTokens: expect.any(Number) });
  });

  it("still reports the estimate and budget for manual compaction", () => {
    const result = shouldCompact({
      messages: makeMessages(1_000),
      capabilities: { kind: "unknown" },
      model: { provider: "openai", modelId: "gpt-2027" },
    });
    expect(result.estimatedTokens).toBeGreaterThan(0);
    if (result.shouldCompact) throw new Error("unreachable");
    expect(result.budget).toBeDefined();
  });

  it("throws CompactionUnavailableError when the post-compaction estimate still exceeds a known safe threshold", () => {
    expect(() => {
      shouldCompact({
        messages: makeMessages(128_000 * 4),
        capabilities: { kind: "known", capabilities: KNOWN_CAPS },
        model: { provider: "openai", modelId: "gpt-4o" },
        afterCompactionEstimate: 120_000,
      });
    }).toThrow(CompactionUnavailableError);
  });
});

// 场景：TokenUsage 归一化后的锚点 total 参与估算（cached 不重复计入）。
describe("anchor usage normalization", () => {
  it("uses normalized totalTokens when the anchor includes cached input tokens", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const withCached = estimateMessagesWithAnchor({
      messages,
      anchor: {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cachedInputTokens: 80,
        } satisfies TokenUsage,
        model: { provider: "openai", modelId: "gpt-4o" },
      },
      anchorEndsAtIndex: 0,
    });
    const fresh = estimateRequestTokens({ messages });
    // 归一化后 total = 70，远小于未归一化的 150 + fresh；同时不小于 70。
    expect(withCached).toBeLessThan(150 + fresh);
    expect(withCached).toBeGreaterThanOrEqual(70);
  });
});
