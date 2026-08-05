import type { Message, ToolCall } from "@byte-mentor/core";

export const RUNTIME_CHECKPOINT_KEY = "runtime_checkpoint";

export type RuntimeCheckpoint =
  | {
      phase: "awaiting_tools";
      iteration: number;
      newMessages: Message[];
      pendingToolCalls: ToolCall[];
    }
  | {
      phase: "tools_completed";
      iteration: number;
      newMessages: Message[];
      pendingToolCalls: [];
    }
  | {
      phase: "final_response";
      iteration: number;
      newMessages: Message[];
      pendingToolCalls: [];
    }
  | {
      phase: "cancelled";
      iteration: number;
      newMessages: Message[];
      pendingToolCalls: [];
    };

export function isRuntimeCheckpoint(value: unknown): value is RuntimeCheckpoint {
  if (!isRecord(value) || !Number.isInteger(value.iteration)) {
    return false;
  }
  if (!Array.isArray(value.newMessages) || !value.newMessages.every(isCheckpointMessage)) {
    return false;
  }
  if (!Array.isArray(value.pendingToolCalls) || !value.pendingToolCalls.every(isToolCall)) {
    return false;
  }
  if (value.phase === "awaiting_tools") {
    return value.pendingToolCalls.length > 0;
  }
  return (
    (value.phase === "tools_completed" ||
      value.phase === "final_response" ||
      value.phase === "cancelled") &&
    value.pendingToolCalls.length === 0
  );
}

function isCheckpointMessage(value: unknown): value is Message {
  if (!isRecord(value) || typeof value.id !== "string") {
    return false;
  }
  if (value.role === "assistant") {
    return (
      (value.content === undefined || typeof value.content === "string") &&
      (value.toolCalls === undefined ||
        (Array.isArray(value.toolCalls) && value.toolCalls.every(isToolCall)))
    );
  }
  return (
    value.role === "tool" &&
    typeof value.toolCallId === "string" &&
    typeof value.content === "string"
  );
}

function isToolCall(value: unknown): value is ToolCall {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.argsParseError === undefined || typeof value.argsParseError === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
