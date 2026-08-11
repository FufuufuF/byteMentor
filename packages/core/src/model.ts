// provider-neutral 共用值对象：模型引用、thinking level 与 token 用量。
// 供 Session Entry、Context/Summary/Compaction 与 provider adapter 共同消费，不依赖任何 provider 包。

// 标识一次模型选择：provider 与模型 ID 的精确组合。
export interface ModelRef {
  provider: string;
  modelId: string;
}

// 会话支持的 thinking level 变体；随 ThinkingLevelChangeEntry 持久化并按活动路径回放。
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// 一次模型调用的 token 用量。真实 usage 优先于本地估算；cachedInputTokens 是 input 的子集，
// 不计入 total。缺失字段由 provider adapter 归一化处理，不在值对象上放宽必填约束。
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
