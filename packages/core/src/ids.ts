import { randomUUID } from "node:crypto";

type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, "SessionId">;
export type MessageId = Brand<string, "MessageId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type TurnId = Brand<string, "TurnId">;

export function createSessionId(): SessionId {
  return randomUUID() as SessionId;
}

export function createMessageId(): MessageId {
  return randomUUID() as MessageId;
}

export function createToolCallId(): ToolCallId {
  return randomUUID() as ToolCallId;
}

export function createTurnId(): TurnId {
  return randomUUID() as TurnId;
}
