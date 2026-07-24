import type { SessionId, TurnId } from "@byte-mentor/core";

export type TurnState =
  "RESTORE" | "COMPACT" | "COMMAND" | "BUILD" | "RUN" | "SAVE" | "RESPOND" | "DONE";

export type TurnStateEvent = "ok" | "dispatch" | "shortcut";

export interface StateTraceEntry {
  state: TurnState;
  startedAt: number;
  durationMs: number;
  event: TurnStateEvent;
}

const TURN_TRANSITIONS: Partial<Record<`${TurnState}:${TurnStateEvent}`, TurnState>> = {
  "RESTORE:ok": "COMPACT",
  "COMPACT:ok": "COMMAND",
  "COMMAND:dispatch": "BUILD",
  "COMMAND:shortcut": "DONE",
  "BUILD:ok": "RUN",
  "RUN:ok": "SAVE",
  "SAVE:ok": "RESPOND",
  "RESPOND:ok": "DONE",
};

export function nextTurnState(state: TurnState, event: TurnStateEvent): TurnState {
  const nextState = TURN_TRANSITIONS[`${state}:${event}`];
  if (nextState === undefined) {
    throw new Error(`No transition from ${state} on event "${event}"`);
  }
  return nextState;
}

interface AgentLoopStateErrorInput {
  state: TurnState;
  event?: TurnStateEvent;
  turnId: TurnId;
  sessionId?: SessionId;
  trace: readonly StateTraceEntry[];
  cause: unknown;
}

export class AgentLoopStateError extends Error {
  readonly state: TurnState;
  readonly event?: TurnStateEvent;
  readonly turnId: TurnId;
  readonly sessionId?: SessionId;
  readonly trace: readonly StateTraceEntry[];
  readonly cause: unknown;

  constructor(input: AgentLoopStateErrorInput) {
    const eventSuffix = input.event === undefined ? "" : ` on event "${input.event}"`;
    super(`AgentLoop state ${input.state} failed${eventSuffix}`);
    this.name = "AgentLoopStateError";
    this.state = input.state;
    this.event = input.event;
    this.turnId = input.turnId;
    this.sessionId = input.sessionId;
    this.trace = [...input.trace];
    this.cause = input.cause;
  }
}
