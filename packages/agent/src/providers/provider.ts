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
