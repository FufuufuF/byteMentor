import { createMessageId, createTurnId } from "@byte-mentor/core";
import type {
  AssistantMessage,
  Message,
  MessageId,
  RuntimeEvent,
  SessionId,
  StopReason,
  TurnId,
} from "@byte-mentor/core";
import type { Session, SessionMetadata, SessionStore } from "@byte-mentor/session";
import type { AgentRunner, AgentRunnerResult } from "./agent-runner.js";
import type { ContextBuilder } from "./context-builder.js";
import type { ProviderStreamEvent } from "./provider.js";
import {
  isRuntimeCheckpoint,
  RUNTIME_CHECKPOINT_KEY,
  type RuntimeCheckpoint,
} from "./runtime-checkpoint.js";
import { ToolRegistry } from "./tool-registry.js";
import {
  AgentLoopStateError,
  nextTurnState,
  type StateTraceEntry,
  type TurnState,
  type TurnStateEvent,
} from "./turn-state.js";

const PENDING_USER_TURN_KEY = "pending_user_turn";
const INTERRUPTED_TURN_MESSAGE = "Error: Task interrupted before a response was generated.";
const INTERRUPTED_TOOL_MESSAGE = "Error: Task interrupted before this tool finished.";
const FAILED_TURN_MESSAGE = "[Assistant reply unavailable due to model error.]";

export interface HeadlessTurnInput {
  sessionId?: SessionId;
  userMessage: string;
}

export interface HeadlessTurnOptions {
  onStreamEvent?: (event: ProviderStreamEvent) => void;
}

interface HeadlessTurnResultBase {
  sessionId: SessionId;
  newMessages: Message[];
  stopReason: StopReason;
  events: RuntimeEvent[];
  trace: StateTraceEntry[];
}

export interface CompletedHeadlessTurnResult extends HeadlessTurnResultBase {
  status: "completed";
  finalMessage: AssistantMessage;
  stopReason: "completed";
}

export interface FailedHeadlessTurnResult extends HeadlessTurnResultBase {
  status: "failed";
  error: { message: string };
  stopReason: "failed";
}

export interface MaxIterationsHeadlessTurnResult extends HeadlessTurnResultBase {
  status: "max_iterations";
  error: { message: string };
  stopReason: "max_iterations";
}

export type HeadlessTurnResult =
  CompletedHeadlessTurnResult | FailedHeadlessTurnResult | MaxIterationsHeadlessTurnResult;

export interface AgentLoopInput {
  sessionStore: SessionStore;
  contextBuilder: ContextBuilder;
  runner: Pick<AgentRunner, "run">;
}

interface TurnContext {
  input: HeadlessTurnInput;
  options?: HeadlessTurnOptions;
  turnId: TurnId;
  state: TurnState;
  session?: Session;
  history: Message[];
  userMessage?: Message;
  initialMessages: Message[];
  runnerResult?: AgentRunnerResult;
  newMessages: Message[];
  events: RuntimeEvent[];
  trace: StateTraceEntry[];
  result?: HeadlessTurnResult;
}

export class AgentLoop {
  private readonly sessionStore: SessionStore;
  private readonly contextBuilder: ContextBuilder;
  private readonly runner: Pick<AgentRunner, "run">;
  readonly tools = new ToolRegistry();

  constructor(input: AgentLoopInput) {
    this.sessionStore = input.sessionStore;
    this.contextBuilder = input.contextBuilder;
    this.runner = input.runner;
  }

  async runTurn(
    input: HeadlessTurnInput,
    options?: HeadlessTurnOptions,
  ): Promise<HeadlessTurnResult> {
    const ctx: TurnContext = {
      input,
      options,
      turnId: createTurnId(),
      state: "RESTORE",
      history: [],
      initialMessages: [],
      newMessages: [],
      events: [],
      trace: [],
    };

    while (ctx.state !== "DONE") {
      const state = ctx.state;
      const startedAt = Date.now();
      let event: TurnStateEvent | undefined;
      try {
        event = await this.handleState(state, ctx);
        ctx.trace.push({
          state,
          startedAt,
          durationMs: Date.now() - startedAt,
          event,
        });
        ctx.state = nextTurnState(state, event);
      } catch (cause) {
        throw new AgentLoopStateError({
          state,
          event,
          turnId: ctx.turnId,
          sessionId: ctx.session?.id,
          trace: ctx.trace,
          cause,
        });
      }
    }

    if (ctx.result === undefined) {
      throw new Error("AgentLoop reached DONE without a result");
    }
    ctx.result.trace = [...ctx.trace];
    return ctx.result;
  }

  private async handleState(state: TurnState, ctx: TurnContext): Promise<TurnStateEvent> {
    switch (state) {
      case "RESTORE":
        return this.stateRestore(ctx);
      case "COMPACT":
        return this.stateCompact();
      case "COMMAND":
        return this.stateCommand();
      case "BUILD":
        return this.stateBuild(ctx);
      case "RUN":
        return this.stateRun(ctx);
      case "SAVE":
        return this.stateSave(ctx);
      case "RESPOND":
        return this.stateRespond(ctx);
      case "DONE":
        throw new Error("DONE does not have a state handler");
    }
  }

  private async stateRestore(ctx: TurnContext): Promise<"ok"> {
    const session =
      ctx.input.sessionId === undefined
        ? await this.sessionStore.create()
        : await this.sessionStore.get(ctx.input.sessionId);
    if (session === undefined) {
      throw new Error(`session not found: ${ctx.input.sessionId}`);
    }
    ctx.session = session;
    const restoredRuntimeCheckpoint = await this.restoreRuntimeCheckpoint(session);
    if (!restoredRuntimeCheckpoint) {
      await this.restorePendingUserTurn(session);
    }
    ctx.events.push({
      type: "turn.started",
      turnId: ctx.turnId,
      ts: Date.now(),
      sessionId: session.id,
    });
    return "ok";
  }

  private async stateCompact(): Promise<"ok"> {
    return "ok";
  }

  private async stateCommand(): Promise<"dispatch"> {
    return "dispatch";
  }

  private async stateBuild(ctx: TurnContext): Promise<"ok"> {
    const session = requireSession(ctx);
    ctx.history = await this.sessionStore.getHistory(session.id);
    const userMessage: Message = {
      id: createMessageId(),
      role: "user",
      content: ctx.input.userMessage,
    };
    ctx.userMessage = userMessage;
    await this.sessionStore.appendMessages(session.id, [userMessage]);
    session.metadata = await this.sessionStore.updateMetadata(session.id, (metadata) => ({
      ...metadata,
      [PENDING_USER_TURN_KEY]: true,
    }));
    ctx.initialMessages = await this.contextBuilder.build({
      history: ctx.history,
      userMessage,
    });
    ctx.events.push({
      type: "context.built",
      turnId: ctx.turnId,
      ts: Date.now(),
      messageCount: ctx.initialMessages.length,
    });
    return "ok";
  }

  private async stateRun(ctx: TurnContext): Promise<"ok"> {
    const session = requireSession(ctx);
    ctx.runnerResult = await this.runner.run({
      turnId: ctx.turnId,
      messages: ctx.initialMessages,
      tools: this.tools,
      onStreamEvent: ctx.options?.onStreamEvent,
      checkpoint: async (payload) => {
        session.metadata = await this.sessionStore.updateMetadata(session.id, (metadata) => ({
          ...metadata,
          [RUNTIME_CHECKPOINT_KEY]: payload,
        }));
      },
    });
    return "ok";
  }

  private async stateSave(ctx: TurnContext): Promise<"ok"> {
    const session = requireSession(ctx);
    const userMessage = requireUserMessage(ctx);
    const runnerResult = requireRunnerResult(ctx);
    const messagesToPersist = [...runnerResult.newMessages];
    if (runnerResult.stopReason === "failed" && messagesToPersist.length === 0) {
      messagesToPersist.push({
        id: createMessageId(),
        role: "assistant",
        content: FAILED_TURN_MESSAGE,
      });
    }
    await this.sessionStore.appendMessages(session.id, messagesToPersist);
    session.metadata = await this.sessionStore.updateMetadata(session.id, removeCheckpointMetadata);
    ctx.newMessages = [userMessage, ...messagesToPersist];
    return "ok";
  }

  private async restoreRuntimeCheckpoint(session: Session): Promise<boolean> {
    if (!Object.prototype.hasOwnProperty.call(session.metadata, RUNTIME_CHECKPOINT_KEY)) {
      // 没有需要恢复的checkpoint
      return false;
    }
    const checkpoint = session.metadata[RUNTIME_CHECKPOINT_KEY];
    if (!isRuntimeCheckpoint(checkpoint)) {
      session.metadata = await this.sessionStore.updateMetadata(
        session.id,
        removeRuntimeCheckpoint,
      );
      return false;
    }

    const restoredMessages = materializeCheckpoint(checkpoint);
    const history = await this.sessionStore.getHistory(session.id);
    const overlap = checkpointTailOverlap(history, restoredMessages);
    if (overlap < restoredMessages.length) {
      await this.sessionStore.appendMessages(session.id, restoredMessages.slice(overlap));
    }
    session.metadata = await this.sessionStore.updateMetadata(session.id, removeCheckpointMetadata);
    return true;
  }

  private async restorePendingUserTurn(session: Session): Promise<void> {
    if (session.metadata[PENDING_USER_TURN_KEY] !== true) {
      return;
    }
    const history = await this.sessionStore.getHistory(session.id);
    if (history.at(-1)?.role === "user") {
      await this.sessionStore.appendMessages(session.id, [
        {
          id: createMessageId(),
          role: "assistant",
          content: INTERRUPTED_TURN_MESSAGE,
        },
      ]);
    }
    session.metadata = await this.sessionStore.updateMetadata(session.id, removePendingUserTurn);
  }

  private async stateRespond(ctx: TurnContext): Promise<"ok"> {
    const session = requireSession(ctx);
    const runnerResult = requireRunnerResult(ctx);
    if (runnerResult.stopReason === "failed") {
      const message = runnerResult.error?.message ?? failureMessageFor(runnerResult.stopReason);
      ctx.events.push(...runnerResult.events, {
        type: "turn.failed",
        turnId: ctx.turnId,
        ts: Date.now(),
        sessionId: session.id,
        message,
      });
      ctx.result = {
        status: runnerResult.stopReason,
        sessionId: session.id,
        error: { message },
        newMessages: ctx.newMessages,
        stopReason: runnerResult.stopReason,
        events: ctx.events,
        trace: [],
      };
      return "ok";
    }
    if (runnerResult.stopReason === "max_iterations") {
      const message = failureMessageFor(runnerResult.stopReason);
      ctx.events.push(...runnerResult.events, {
        type: "turn.failed",
        turnId: ctx.turnId,
        ts: Date.now(),
        sessionId: session.id,
        message,
      });
      ctx.result = {
        status: "max_iterations",
        sessionId: session.id,
        error: { message },
        newMessages: ctx.newMessages,
        stopReason: "max_iterations",
        events: ctx.events,
        trace: [],
      };
      return "ok";
    }
    if (runnerResult.stopReason !== "completed") {
      throw new Error(`runner returned non-terminal stopReason: ${runnerResult.stopReason}`);
    }
    const finalMessage = runnerResult.newMessages.at(-1);
    if (!isAssistantMessageWithId(finalMessage)) {
      throw new Error("runner final message missing id");
    }
    ctx.events.push(...runnerResult.events, {
      type: "turn.completed",
      turnId: ctx.turnId,
      ts: Date.now(),
      sessionId: session.id,
      messageId: finalMessage.id,
      stopReason: runnerResult.stopReason,
    });
    ctx.result = {
      status: "completed",
      sessionId: session.id,
      finalMessage,
      newMessages: ctx.newMessages,
      stopReason: runnerResult.stopReason,
      events: ctx.events,
      trace: [],
    };
    return "ok";
  }
}

function requireSession(ctx: TurnContext): Session {
  if (ctx.session === undefined) {
    throw new Error("AgentLoop session is not initialized");
  }
  return ctx.session;
}

function removePendingUserTurn(metadata: SessionMetadata): SessionMetadata {
  const nextMetadata = { ...metadata };
  delete nextMetadata[PENDING_USER_TURN_KEY];
  return nextMetadata;
}

function removeRuntimeCheckpoint(metadata: SessionMetadata): SessionMetadata {
  const nextMetadata = { ...metadata };
  delete nextMetadata[RUNTIME_CHECKPOINT_KEY];
  return nextMetadata;
}

function removeCheckpointMetadata(metadata: SessionMetadata): SessionMetadata {
  return removeRuntimeCheckpoint(removePendingUserTurn(metadata));
}

function materializeCheckpoint(checkpoint: RuntimeCheckpoint): Message[] {
  return [
    ...checkpoint.newMessages,
    ...checkpoint.pendingToolCalls.map((toolCall): Message => ({
      id: createMessageId(),
      role: "tool",
      toolCallId: toolCall.id,
      content: INTERRUPTED_TOOL_MESSAGE,
    })),
  ];
}

function checkpointTailOverlap(history: Message[], restoredMessages: Message[]): number {
  const maxOverlap = Math.min(history.length, restoredMessages.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const existingTail = history.slice(-size);
    const restoredHead = restoredMessages.slice(0, size);
    if (
      existingTail.every(
        (message, index) =>
          checkpointMessageKey(message) === checkpointMessageKey(restoredHead[index] as Message),
      )
    ) {
      return size;
    }
  }
  return 0;
}

function checkpointMessageKey(message: Message): string {
  return JSON.stringify([
    message.role,
    message.content,
    message.role === "tool" ? message.toolCallId : undefined,
    message.role === "assistant" ? message.toolCalls : undefined,
  ]);
}

function requireUserMessage(ctx: TurnContext): Message {
  if (ctx.userMessage === undefined) {
    throw new Error("AgentLoop user message is not initialized");
  }
  return ctx.userMessage;
}

function requireRunnerResult(ctx: TurnContext): AgentRunnerResult {
  if (ctx.runnerResult === undefined) {
    throw new Error("AgentLoop runner result is not initialized");
  }
  return ctx.runnerResult;
}

function failureMessageFor(stopReason: "failed" | "max_iterations"): string {
  return stopReason === "failed"
    ? "agent turn failed before final assistant message"
    : "reached max iterations before final assistant message";
}

function isAssistantMessageWithId(
  message: Message | undefined,
): message is AssistantMessage & { id: MessageId } {
  return message?.role === "assistant" && message.id !== undefined;
}
