import type { MessageId, ToolCallId } from "./ids.js";

export type StopReason = "completed" | "failed" | "max_iterations" | "tool_calls";

export interface ToolCall {
  id: ToolCallId;
  name: string;
  args: unknown;
  argsParseError?: string;
}

interface BaseMessage {
  id?: MessageId;
}

export interface UserMessage extends BaseMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  content?: string;
  toolCalls?: ToolCall[];
}

export interface ToolMessage extends BaseMessage {
  role: "tool";
  toolCallId: ToolCallId;
  content: string;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;
