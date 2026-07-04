import { describe, expect, it } from "vitest";
import { createMessageId, createToolCallId } from "@byte-mentor/core";
import type { Message, RuntimeEvent, SessionId, StopReason } from "@byte-mentor/core";
import { AgentLoop, AgentRunner, ContextBuilder } from "@byte-mentor/agent";
import type { ModelProvider } from "@byte-mentor/agent";
import { InMemorySessionStore } from "@byte-mentor/session";

describe("AgentLoop.runTurn", () => {
  it("creates a session and persists a completed turn", async () => {
    const agent = await import("@byte-mentor/agent");
    expect(agent).toHaveProperty("AgentLoop");
    const AgentLoop = agent.AgentLoop as new (input: {
      sessionStore: InMemorySessionStore;
      contextBuilder: ContextBuilder;
      runner: {
        run(input: {
          turnId: unknown;
          messages: Message[];
          tools: { list(): unknown[] };
        }): Promise<{
          newMessages: Message[];
          stopReason: StopReason;
          events: RuntimeEvent[];
        }>;
      };
    }) => {
      runTurn(input: { userMessage: string }): Promise<{
        sessionId: SessionId;
        finalMessage: Message;
        newMessages: Message[];
        stopReason: StopReason;
        events: RuntimeEvent[];
      }>;
    };
    const sessionStore = new InMemorySessionStore();
    const runnerInputs: { messages: Message[]; toolCount: number }[] = [];
    const assistantMessage: Message = {
      id: createMessageId(),
      role: "assistant",
      content: "done",
    };
    const runner = {
      async run(input: {
        messages: Message[];
        tools: { list(): unknown[] };
      }) {
        runnerInputs.push({
          messages: input.messages,
          toolCount: input.tools.list().length,
        });
        return {
          newMessages: [assistantMessage],
          stopReason: "completed" as StopReason,
          events: [],
        };
      },
    };

    const result = await new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner,
    }).runTurn({ userMessage: "hello" });

    const history = await sessionStore.getHistory(result.sessionId);
    expect(result.stopReason).toBe("completed");
    expect(result.finalMessage).toBe(assistantMessage);
    expect(result.newMessages).toEqual([history[0], assistantMessage]);
    expect(runnerInputs).toEqual([
      {
        messages: [history[0]],
        toolCount: 0,
      },
    ]);
    expect(history).toEqual([
      {
        id: expect.any(String),
        role: "user",
        content: "hello",
      },
      assistantMessage,
    ]);
  });

  it("passes existing session history to runner", async () => {
    const agent = await import("@byte-mentor/agent");
    const AgentLoop = agent.AgentLoop as new (input: {
      sessionStore: InMemorySessionStore;
      contextBuilder: ContextBuilder;
      runner: {
        run(input: {
          turnId: unknown;
          messages: Message[];
          tools: { list(): unknown[] };
        }): Promise<{
          newMessages: Message[];
          stopReason: StopReason;
          events: RuntimeEvent[];
        }>;
      };
    }) => {
      runTurn(input: {
        sessionId: SessionId;
        userMessage: string;
      }): Promise<{
        sessionId: SessionId;
        finalMessage: Message;
        newMessages: Message[];
        stopReason: StopReason;
        events: RuntimeEvent[];
      }>;
    };
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create();
    const previousMessages: Message[] = [
      { id: createMessageId(), role: "user", content: "previous question" },
      { id: createMessageId(), role: "assistant", content: "previous answer" },
    ];
    await sessionStore.appendMessages(session.id, previousMessages);
    const runnerMessages: Message[][] = [];
    const assistantMessage: Message = {
      id: createMessageId(),
      role: "assistant",
      content: "current answer",
    };
    const runner = {
      async run(input: { messages: Message[] }) {
        runnerMessages.push(input.messages);
        return {
          newMessages: [assistantMessage],
          stopReason: "completed" as StopReason,
          events: [],
        };
      },
    };

    const result = await new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner,
    }).runTurn({ sessionId: session.id, userMessage: "current question" });

    const history = await sessionStore.getHistory(session.id);
    expect(result.sessionId).toBe(session.id);
    expect(runnerMessages).toEqual([
      [
        ...previousMessages,
        {
          id: expect.any(String),
          role: "user",
          content: "current question",
        },
      ],
    ]);
    expect(history).toEqual([
      ...previousMessages,
      runnerMessages[0]?.at(-1),
      assistantMessage,
    ]);
  });

  it("persists tool-call trace from runner", async () => {
    const toolCallId = createToolCallId();
    const provider: ModelProvider = {
      async invoke(req) {
        if (req.messages.length === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
            },
            stopReason: "tool_calls",
          };
        }
        return {
          message: { role: "assistant", content: "found docs" },
          stopReason: "completed",
        };
      },
    };
    const sessionStore = new InMemorySessionStore();
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: new AgentRunner(provider),
    });
    loop.tools.register({
      name: "lookup",
      description: "lookup docs",
      parametersJsonSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      async execute(args: unknown) {
        const a = args as { query: string };
        return { ok: true, result: `result:${a.query}` };
      },
    });

    const result = await loop.runTurn({ userMessage: "find docs" });

    const history = await sessionStore.getHistory(result.sessionId);
    expect(result.stopReason).toBe("completed");
    expect(result.newMessages).toEqual(history);
    expect(history).toHaveLength(4);
    expect(history[0]).toMatchObject({ role: "user", content: "find docs" });
    expect(history[1]).toMatchObject({
      role: "assistant",
      content: "",
      toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
    });
    expect(history[2]).toMatchObject({
      role: "tool",
      toolCallId,
      content: "result:docs",
    });
    expect(history[3]).toMatchObject({ role: "assistant", content: "found docs" });
    expect(result.finalMessage).toBe(history[3]);
  });

  it("emits runtime event sequence for a tool turn", async () => {
    const toolCallId = createToolCallId();
    const provider: ModelProvider = {
      async invoke(req) {
        if (req.messages.length === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: toolCallId, name: "lookup", args: null }],
            },
            stopReason: "tool_calls",
          };
        }
        return {
          message: { role: "assistant", content: "done" },
          stopReason: "completed",
        };
      },
    };
    const sessionStore = new InMemorySessionStore();
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: new AgentRunner(provider),
    });
    loop.tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute() {
        return { ok: true, result: "result:docs" };
      },
    });

    const result = await loop.runTurn({ userMessage: "find docs" });

    expect(result.events.map((event) => event.type)).toEqual([
      "turn.started",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.started",
      "tool.completed",
      "model.requested",
      "model.responded",
      "turn.completed",
    ]);
    expect(result.events.every((event) => event.turnId === result.events[0]?.turnId)).toBe(true);
    expect(result.events.every((event) => typeof event.ts === "number")).toBe(true);
    expect(result.events[0]).toMatchObject({
      type: "turn.started",
      sessionId: result.sessionId,
    });
    expect(result.events[1]).toMatchObject({
      type: "context.built",
      messageCount: 1,
    });
    expect(result.events[2]).toMatchObject({
      type: "model.requested",
      messageCount: 1,
      toolCount: 1,
    });
    expect(result.events[5]).toMatchObject({
      type: "tool.completed",
      toolCallId,
      result: "result:docs",
    });
    expect(result.events[8]).toMatchObject({
      type: "turn.completed",
      sessionId: result.sessionId,
      messageId: result.finalMessage.id,
      stopReason: "completed",
    });
  });
});
