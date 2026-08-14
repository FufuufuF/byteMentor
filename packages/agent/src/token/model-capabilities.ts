import type { ModelRef } from "@byte-mentor/core";

// M6.1 内置模型能力表：以 (provider, modelId) 精确匹配 contextWindow 与已知输出上限。
// 只收录经过可靠资料确认的常用模型；dated/alias 显式登记，不做模糊前缀猜测。
// context window 属于当前运行环境能力，不持久化到 Session。

export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens?: number;
}

export type ModelCapabilitiesLookup =
  | { kind: "known"; capabilities: ModelCapabilities }
  // 未知模型：不启用基于阈值的自动压缩，不假定默认窗口大小；手动 /compact 仍可尽力执行。
  | { kind: "unknown" };

// (provider, modelId) → 能力。键为 `${provider}\u0000${modelId}`，避免 provider/modelId 含
// 分隔符时碰撞。
type CapabilityEntry = readonly [
  provider: string,
  modelId: string,
  capabilities: ModelCapabilities,
];

const KNOWN_MODELS: CapabilityEntry[] = [
  // OpenAI
  ["openai", "gpt-4o", { contextWindow: 128_000, maxOutputTokens: 16_384 }],
  ["openai", "gpt-4o-2024-08-06", { contextWindow: 128_000, maxOutputTokens: 16_384 }],
  ["openai", "gpt-4o-2024-05-13", { contextWindow: 128_000, maxOutputTokens: 16_384 }],
  // Anthropic
  ["anthropic", "claude-sonnet-4-5", { contextWindow: 200_000, maxOutputTokens: 64_000 }],
  ["anthropic", "claude-sonnet-4-5-20250929", { contextWindow: 200_000, maxOutputTokens: 64_000 }],
];

const CAPABILITY_BY_MODEL: ReadonlyMap<string, ModelCapabilities> = new Map(
  KNOWN_MODELS.map(([provider, modelId, capabilities]) => [
    `${provider}\u0000${modelId}`,
    capabilities,
  ]),
);

// 精确查询模型能力；不在表中返回 unknown，不虚构窗口。
export function getModelCapabilities(model: ModelRef): ModelCapabilitiesLookup {
  const capabilities = CAPABILITY_BY_MODEL.get(`${model.provider}\u0000${model.modelId}`);
  return capabilities === undefined ? { kind: "unknown" } : { kind: "known", capabilities };
}

// 判断模型是否在能力表中（未知模型不启用阈值自动压缩）。
export function isKnownModel(model: ModelRef): boolean {
  return CAPABILITY_BY_MODEL.has(`${model.provider}\u0000${model.modelId}`);
}
