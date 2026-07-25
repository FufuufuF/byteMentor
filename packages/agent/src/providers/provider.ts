import type { AssistantMessage, Message, StopReason } from "@byte-mentor/core";

export interface ToolDefinition {
  name: string;
  description: string;
  parametersJsonSchema?: unknown;
}

export interface ProviderRequest {
  messages: Message[];
  tools?: ToolDefinition[];
}

export interface ProviderResponse {
  message: AssistantMessage;
  stopReason: StopReason;
}

export type ProviderStreamEvent =
  | { type: "content_delta"; text: string }
  | { type: "done"; message: AssistantMessage; stopReason: StopReason };

export interface ModelProvider {
  invoke(req: ProviderRequest): Promise<ProviderResponse>;
  invokeStream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}
