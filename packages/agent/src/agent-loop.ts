import { createMessageId, createTurnId } from "@byte-mentor/core";
import type {
  AssistantMessage,
  Message,
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

export interface HeadlessTurnResult {
  sessionId: SessionId;
  finalMessage: AssistantMessage;
  newMessages: Message[];
  stopReason: StopReason;
  events: RuntimeEvent[];
}

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
    const finalMessage = result.newMessages.at(-1) as AssistantMessage;
    if (finalMessage.id === undefined) {
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
      sessionId: session.id,
      finalMessage,
      newMessages: [userMessage, ...result.newMessages],
      stopReason: result.stopReason,
      events,
    };
  }
}
