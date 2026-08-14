import type { Message, ModelRef } from "@byte-mentor/core";
import type { ModelCapabilities, ModelCapabilitiesLookup } from "./model-capabilities.js";
import {
  estimateMessagesWithAnchor,
  estimateRequestTokens,
  type EstimationAnchor,
} from "./token-estimator.js";

// M6.3 默认预算与触发阈值：已知 context window 时使用动态默认值，内部策略不提供设置 UI。
export interface TokenBudget {
  reserveTokens: number;
  keepRecentTokens: number;
  maxSummaryOutputTokens: number;
  triggerThresholdTokens: number;
}

const RESERVE_CAP = 16_384;
const KEEP_RECENT_CAP = 20_000;
const SUMMARY_OUTPUT_CAP = 8_192;

// 由 context window 计算动态预算（M6.3）；maxOutputTokens 缺失时忽略该约束。
export function computeTokenBudget(capabilities: ModelCapabilities): TokenBudget {
  const reserveTokens = Math.min(RESERVE_CAP, Math.floor(capabilities.contextWindow * 0.25));
  const keepRecentTokens = Math.min(KEEP_RECENT_CAP, Math.floor(capabilities.contextWindow * 0.5));
  let maxSummaryOutputTokens = Math.min(SUMMARY_OUTPUT_CAP, Math.floor(reserveTokens * 0.5));
  if (capabilities.maxOutputTokens !== undefined) {
    maxSummaryOutputTokens = Math.min(maxSummaryOutputTokens, capabilities.maxOutputTokens);
  }
  return {
    reserveTokens,
    keepRecentTokens,
    maxSummaryOutputTokens,
    triggerThresholdTokens: capabilities.contextWindow - reserveTokens,
  };
}

// 压缩后仍超安全阈值：阻止 provider 请求，不降低安全余量强行发送（M6.3）。
export class CompactionUnavailableError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly safeThreshold: number,
  ) {
    super(
      `context still exceeds the safe threshold after compaction: ${estimatedTokens} > ${safeThreshold}`,
    );
    this.name = "CompactionUnavailableError";
  }
}

export interface CompactDecisionInput {
  messages: Message[];
  // 已知窗口时传 { kind: "known", capabilities }；未知模型传 { kind: "unknown" }。
  capabilities: ModelCapabilitiesLookup;
  model: ModelRef;
  // 有合法 usage 锚点时增量估算（M6.2）。
  anchor?: EstimationAnchor;
  anchorEndsAtIndex?: number;
  // 压缩后的重估结果；仍超阈值时抛 CompactionUnavailableError。
  afterCompactionEstimate?: number;
}

export type CompactDecision =
  | { shouldCompact: true; estimatedTokens: number; overflow: boolean }
  | {
      shouldCompact: false;
      estimatedTokens: number;
      overflow: boolean;
      budget: TokenBudget;
    };

// 压缩触发决策（M6.3/M6.1）：预测请求 token > contextWindow - reserveTokens 时触发；
// 未知模型不启用阈值自动压缩，但仍返回估算与手动压缩可用的预算。
export function shouldCompact(input: CompactDecisionInput): CompactDecision {
  if (input.capabilities.kind === "unknown") {
    if (input.afterCompactionEstimate !== undefined) {
      throw new CompactionUnavailableError(
        input.afterCompactionEstimate,
        // 未知模型没有已知安全阈值；此处仅为类型完整性，实际不会走到。
        0,
      );
    }
    return {
      shouldCompact: false,
      estimatedTokens: estimateTokens(input),
      overflow: false,
      budget: defaultBudget(),
    };
  }

  const { capabilities } = input.capabilities;
  const budget = computeTokenBudget(capabilities);
  const estimatedTokens = estimateTokens(input);
  const overflow = estimatedTokens > capabilities.contextWindow;
  const should = estimatedTokens > budget.triggerThresholdTokens;

  if (input.afterCompactionEstimate !== undefined) {
    if (input.afterCompactionEstimate > budget.triggerThresholdTokens) {
      throw new CompactionUnavailableError(
        input.afterCompactionEstimate,
        budget.triggerThresholdTokens,
      );
    }
    return {
      shouldCompact: false,
      estimatedTokens: input.afterCompactionEstimate,
      overflow: false,
      budget,
    };
  }

  if (should) {
    return { shouldCompact: true, estimatedTokens, overflow };
  }
  return { shouldCompact: false, estimatedTokens, overflow, budget };
}

function estimateTokens(input: CompactDecisionInput): number {
  if (input.anchor !== undefined) {
    return estimateMessagesWithAnchor({
      messages: input.messages,
      anchor: input.anchor,
      anchorEndsAtIndex: input.anchorEndsAtIndex ?? input.messages.length,
      model: input.model,
    });
  }
  return estimateRequestTokens({ messages: input.messages });
}

// 未知模型的手动压缩预算：用默认窗口 128k 计算（只影响 reserve/keepRecent 比例，
// 不虚构自动压缩窗口）。
function defaultBudget(): TokenBudget {
  return computeTokenBudget({ contextWindow: 128_000 });
}
