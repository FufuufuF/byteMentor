import type { AssistantMessage, Message, StopReason } from "@byte-mentor/core";

export type ToolErrorKind = "unknown_tool" | "invalid_args" | "execution_failed";

export interface ToolError {
  kind: ToolErrorKind;
  message: string;
}

export type ToolResult =
  | { ok: true; result: string }
  | { ok: false; error: ToolError };

export interface ToolDefinition {
  name: string;
  description: string;
  parametersJsonSchema?: unknown;
}

export interface AgentTool extends ToolDefinition {
  execute(args: unknown): Promise<ToolResult>;
}

export interface ProviderRequest {
  messages: Message[];
  tools?: ToolDefinition[];
}

export interface ProviderResponse {
  message: AssistantMessage;
  stopReason: StopReason;
}

export interface ModelProvider {
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}
