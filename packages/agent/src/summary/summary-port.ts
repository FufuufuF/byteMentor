import type { ModelRef, ThinkingLevel, TokenUsage } from "@byte-mentor/core";

// M6.8/6.9 摘要模型端口（类型定义）：session 领域层定义"生成摘要"所需的外部边界，
// 不依赖具体 provider。agent 包实现此端口（含重试/取消语义）并注入给领域服务。
// 重试/取消的执行逻辑在 agent 包（summary-executor），不在本文件。

export interface SummaryRequest {
  historyText: string;
  // 使用哪个模型生成摘要（source leaf 恢复出的 model/thinking）。
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  signal?: AbortSignal;
}

export type SummaryError =
  | { kind: "retryable"; message: string; retryAfterMs?: number }
  | { kind: "permanent"; message: string }
  | { kind: "cancelled" };

export type SummaryResponse =
  { ok: true; text: string; usage?: TokenUsage } | { ok: false; error: SummaryError };

export interface SummaryModelPort {
  summarize(request: SummaryRequest): Promise<SummaryResponse>;
}
