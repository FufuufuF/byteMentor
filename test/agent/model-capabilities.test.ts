import { describe, expect, it } from "vitest";
import { getModelCapabilities, isKnownModel } from "@byte-mentor/agent";
import type { ModelCapabilities } from "@byte-mentor/agent";

// 场景：内置表收录的常用模型精确返回 contextWindow 与（已知的）maxOutputTokens。
// 预期：openai gpt-4o 与 anthropic claude-sonnet 均命中，字段与表一致；dated/alias 显式登记。
describe("getModelCapabilities", () => {
  it("returns exact capabilities for known models", () => {
    const gpt4o = getModelCapabilities({ provider: "openai", modelId: "gpt-4o" });
    expect(gpt4o).toEqual({
      kind: "known",
      capabilities: { contextWindow: 128_000, maxOutputTokens: 16_384 },
    });
    const sonnet = getModelCapabilities({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
    expect(sonnet).toEqual({
      kind: "known",
      capabilities: { contextWindow: 200_000, maxOutputTokens: 64_000 },
    });
    // dated 显式登记：不靠前缀猜测。
    expect(getModelCapabilities({ provider: "openai", modelId: "gpt-4o-2024-08-06" })).toEqual({
      kind: "known",
      capabilities: { contextWindow: 128_000, maxOutputTokens: 16_384 },
    });
  });

  it("returns unknown for models not in the table without inventing a window", () => {
    expect(getModelCapabilities({ provider: "openai", modelId: "gpt-2027" })).toEqual({
      kind: "unknown",
    });
    expect(getModelCapabilities({ provider: "anthropic", modelId: "claude-sonnet-4-6" })).toEqual({
      kind: "unknown",
    });
  });

  it("distinguishes models by exact (provider, modelId) without prefix guessing", () => {
    expect(getModelCapabilities({ provider: "openai", modelId: "gpt-4o-mini" }).kind).toBe(
      "unknown",
    );
    expect(isKnownModel({ provider: "openai", modelId: "gpt-4o" })).toBe(true);
    expect(isKnownModel({ provider: "anthropic", modelId: "claude-opus-4-1" })).toBe(false);
  });
});

// 场景：ModelCapabilities 类型可直接构造。预期：可选 maxOutputTokens 可整体缺失。
describe("ModelCapabilities type", () => {
  it("allows construction without maxOutputTokens", () => {
    const caps: ModelCapabilities = { contextWindow: 64_000 };
    expect(caps.contextWindow).toBe(64_000);
  });
});
