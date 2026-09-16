import type { AssistantMessage, Message, StopReason, TokenUsage } from "@byte-mentor/core";

export interface ToolDefinition {
  name: string;
  description: string;
  parametersJsonSchema?: unknown;
}

export interface ProviderRequest {
  messages: Message[];
  tools?: ToolDefinition[];
}

// 单次模型调用的动态控制信息；signal 是只读单向通知，不进入静态 ProviderRequest。
export interface ProviderInvocationOptions {
  signal?: AbortSignal;
}

// Provider adapter 对厂商结构化错误的 provider-neutral 归一化结果。
// 首版只冻结 context overflow；其他错误保留厂商/运行时原错误语义。
export type ProviderInvocationErrorKind = "context-overflow";

export class ProviderInvocationError extends Error {
  readonly kind: ProviderInvocationErrorKind;
  readonly cause?: unknown;

  constructor(
    kind: ProviderInvocationErrorKind,
    message = `provider invocation failed: ${kind}`,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ProviderInvocationError";
    this.kind = kind;
    this.cause = options.cause;
  }
}

export interface ProviderResponse {
  message: AssistantMessage;
  stopReason: StopReason;
  // 该次调用的 token 用量（已归一化）；provider 未上报时为 undefined。
  usage?: TokenUsage;
}

export type ProviderStreamEvent =
  | { type: "content_delta"; text: string }
  | { type: "done"; message: AssistantMessage; stopReason: StopReason; usage?: TokenUsage };

export interface ModelProvider {
  invoke(req: ProviderRequest, options?: ProviderInvocationOptions): Promise<ProviderResponse>;
  invokeStream(
    req: ProviderRequest,
    options?: ProviderInvocationOptions,
  ): AsyncIterable<ProviderStreamEvent>;
}
