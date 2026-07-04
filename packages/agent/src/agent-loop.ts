import { createMessageId, createTurnId } from "@byte-mentor/core";
import type {
  AssistantMessage,
  Message,
  MessageId,
  RuntimeEvent,
  SessionId,
  StopReason,
} from "@byte-mentor/core";
import type { SessionStore } from "@byte-mentor/session";
import type { AgentRunner } from "./agent-runner.js";
import type { ContextBuilder } from "./context-builder.js";
import { ToolRegistry } from "./tool-registry.js";

export interface HeadlessTurnInput {
  sessionId?: SessionId;
  userMessage: string;
}

interface HeadlessTurnResultBase {
  sessionId: SessionId;
  newMessages: Message[];
  stopReason: StopReason;
  events: RuntimeEvent[];
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
  | CompletedHeadlessTurnResult
  | FailedHeadlessTurnResult
  | MaxIterationsHeadlessTurnResult;

export interface AgentLoopInput {
  sessionStore: SessionStore;
  contextBuilder: ContextBuilder;
  runner: Pick<AgentRunner, "run">;
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

  async runTurn(input: HeadlessTurnInput): Promise<HeadlessTurnResult> {
    const turnId = createTurnId();
    const session =
      input.sessionId === undefined
        ? await this.sessionStore.create()
        : await this.sessionStore.get(input.sessionId);
    if (session === undefined) {
      throw new Error(`session not found: ${input.sessionId}`);
    }
    const events: RuntimeEvent[] = [
      {
        type: "turn.started",
        turnId,
        ts: Date.now(),
        sessionId: session.id,
      },
    ];
    const history = await this.sessionStore.getHistory(session.id);
    const userMessage: Message = {
      id: createMessageId(),
      role: "user",
      content: input.userMessage,
    };
    await this.sessionStore.appendMessages(session.id, [userMessage]);

    const messages = await this.contextBuilder.build({
      history,
      userMessage,
    });
    events.push({
      type: "context.built",
      turnId,
      ts: Date.now(),
      messageCount: messages.length,
    });
    const result = await this.runner.run({
      turnId,
      messages,
      tools: this.tools,
    });
    await this.sessionStore.appendMessages(session.id, result.newMessages);
    const newMessages = [userMessage, ...result.newMessages];
    if (result.stopReason === "failed") {
      const message = result.error?.message ?? failureMessageFor(result.stopReason);
      events.push(...result.events, {
        type: "turn.failed",
        turnId,
        ts: Date.now(),
        sessionId: session.id,
        message,
      });
      return {
        status: result.stopReason,
        sessionId: session.id,
        error: { message },
        newMessages,
        stopReason: result.stopReason,
        events,
      };
    }
    if (result.stopReason === "max_iterations") {
      const message = failureMessageFor(result.stopReason);
      events.push(...result.events, {
        type: "turn.failed",
        turnId,
        ts: Date.now(),
        sessionId: session.id,
        message,
      });
      return {
        status: "max_iterations",
        sessionId: session.id,
        error: { message },
        newMessages,
        stopReason: "max_iterations",
        events,
      };
    }
    if (result.stopReason !== "completed") {
      throw new Error(`runner returned non-terminal stopReason: ${result.stopReason}`);
    }
    const finalMessage = result.newMessages.at(-1);
    if (!isAssistantMessageWithId(finalMessage)) {
      throw new Error("runner final message missing id");
    }
    events.push(...result.events, {
      type: "turn.completed",
      turnId,
      ts: Date.now(),
      sessionId: session.id,
      messageId: finalMessage.id,
      stopReason: result.stopReason,
    });

    return {
      status: "completed",
      sessionId: session.id,
      finalMessage,
      newMessages,
      stopReason: result.stopReason,
      events,
    };
  }
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
