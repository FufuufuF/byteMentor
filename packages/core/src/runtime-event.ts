import type { MessageId, SessionId, ToolCallId, TurnId } from "./ids.js";
import type { StopReason } from "./messages.js";

interface RuntimeEventBase {
  type: string;
  turnId: TurnId;
  ts: number;
}

export interface TurnStartedEvent extends RuntimeEventBase {
  type: "turn.started";
  sessionId: SessionId;
}

export interface ContextBuiltEvent extends RuntimeEventBase {
  type: "context.built";
  messageCount: number;
}

export interface ModelRequestedEvent extends RuntimeEventBase {
  type: "model.requested";
  messageCount: number;
  toolCount: number;
}

export interface ModelRespondedEvent extends RuntimeEventBase {
  type: "model.responded";
  messageId: MessageId;
  stopReason: StopReason;
}

export interface ToolStartedEvent extends RuntimeEventBase {
  type: "tool.started";
  toolCallId: ToolCallId;
  toolName: string;
}

export interface ToolCompletedEvent extends RuntimeEventBase {
  type: "tool.completed";
  toolCallId: ToolCallId;
  result: string;
}

export interface ToolFailedEvent extends RuntimeEventBase {
  type: "tool.failed";
  toolCallId: ToolCallId;
  message: string;
}

export interface TurnCompletedEvent extends RuntimeEventBase {
  type: "turn.completed";
  sessionId: SessionId;
  messageId: MessageId;
  stopReason: StopReason;
}

export interface TurnFailedEvent extends RuntimeEventBase {
  type: "turn.failed";
  sessionId: SessionId;
  message: string;
}

export type RuntimeEvent =
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ContextBuiltEvent
  | ModelRequestedEvent
  | ModelRespondedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent;
