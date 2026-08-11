import { describe, expect, it } from "vitest";
import type { ModelRef, ThinkingLevel, TokenUsage } from "@byte-mentor/core";

// 场景：构造一个 ModelRef 值对象。预期：provider 与 modelId 字段原样保留，可整体断言。
describe("ModelRef", () => {
  it("carries provider and modelId fields", () => {
    const model: ModelRef = { provider: "openai", modelId: "gpt-5" };
    expect(model).toEqual({ provider: "openai", modelId: "gpt-5" });
  });
});

// 场景：将全部七个声明变体依次赋给 ThinkingLevel。预期：七值均可通过类型检查且可比较。
describe("ThinkingLevel", () => {
  it("accepts every declared variant", () => {
    const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    expect(levels).toContain("off");
    expect(levels).toContain("minimal");
    expect(levels).toContain("low");
    expect(levels).toContain("medium");
    expect(levels).toContain("high");
    expect(levels).toContain("xhigh");
    expect(levels).toContain("max");
  });
});

// 场景：TokenUsage 只带必填的三个计数。预期：可选字段可以整体缺失，total 与子项一致。
describe("TokenUsage", () => {
  it("allows minimal construction with only required counts", () => {
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(20);
    expect(usage.totalTokens).toBe(30);
  });

  // 场景：TokenUsage 携带全部可选字段。预期：可选字段原样保留。
  it("carries optional cached and reasoning fields when present", () => {
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 80,
      cacheWriteTokens: 20,
      reasoningTokens: 30,
    };
    expect(usage.cachedInputTokens).toBe(80);
    expect(usage.cacheWriteTokens).toBe(20);
    expect(usage.reasoningTokens).toBe(30);
  });

  // 场景：在编译期把非法字符串字面量赋给 ThinkingLevel。预期：类型检查拒绝，证明类型足够严格。
  it("rejects invalid ThinkingLevel at compile time", () => {
    // @ts-expect-error "ultra" is not a valid thinking level
    const level: ThinkingLevel = "ultra";
    expect(level as string).toBe("ultra");
  });

  // 场景：在编译期构造缺失必填计数的 TokenUsage。预期：类型检查拒绝。
  it("rejects TokenUsage missing required counts at compile time", () => {
    // @ts-expect-error totalTokens is required
    const usage: TokenUsage = { inputTokens: 1, outputTokens: 2 };
    expect(usage as object).toBeDefined();
  });
});
