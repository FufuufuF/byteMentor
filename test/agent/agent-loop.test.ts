import { describe, expect, it } from "vitest";
import { createMessageId, createToolCallId } from "@byte-mentor/core";
import type { Message, RuntimeEvent, SessionId, StopReason } from "@byte-mentor/core";
import { AgentLoop, AgentRunner, ContextBuilder, ToolRegistry } from "@byte-mentor/agent";
import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  RuntimeCheckpoint,
} from "@byte-mentor/agent";
import { InMemorySessionStore } from "@byte-mentor/session";

interface ExpectedStateTraceEntry {
  state: string;
  startedAt: number;
  durationMs: number;
  event: string;
}

function invokeProvider(
  invoke: (req: ProviderRequest) => Promise<ProviderResponse>,
): ModelProvider {
  return {
    async invoke(req) {
      return invoke(req);
    },
    async *invokeStream(req) {
      const response = await invoke(req);
      if (response.message.content !== undefined && response.message.content.length > 0) {
        yield { type: "content_delta", text: response.message.content };
      }
      yield {
        type: "done",
        message: response.message,
        stopReason: response.stopReason,
      };
    },
  };
}

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
        trace: ExpectedStateTraceEntry[];
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
      async run(input: { messages: Message[]; tools: { list(): unknown[] } }) {
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
    expect(result.trace).toHaveLength(7);
    expect(result.trace.map((entry) => entry.state)).toEqual([
      "RESTORE",
      "COMPACT",
      "COMMAND",
      "BUILD",
      "RUN",
      "SAVE",
      "RESPOND",
    ]);
    expect(result.trace.find((entry) => entry.state === "COMMAND")?.event).toBe("dispatch");
    for (const entry of result.trace) {
      expect(entry.state).not.toBe("");
      expect(entry.event).not.toBe("");
      expect(entry.startedAt).toEqual(expect.any(Number));
      expect(entry.durationMs).toEqual(expect.any(Number));
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    }
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

  // 应用组装层传入的 Registry 必须以同一实例进入 Runner，避免丢失已注册工具和执行上下文。
  it("preserves an injected ToolRegistry instance", async () => {
    const sessionStore = new InMemorySessionStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute() {
        return { ok: true, data: "docs" };
      },
    });
    let receivedTools: ToolRegistry | undefined;
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      tools,
      runner: {
        async run(input) {
          receivedTools = input.tools;
          return {
            newMessages: [
              {
                id: createMessageId(),
                role: "assistant" as const,
                content: "done",
              },
            ],
            stopReason: "completed" as const,
            events: [],
          };
        },
      },
    });

    await loop.runTurn({ userMessage: "hello" });

    expect(loop.tools).toBe(tools);
    expect(receivedTools).toBe(tools);
    expect(receivedTools?.list().map((tool) => tool.name)).toEqual(["lookup"]);
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
      runTurn(input: { sessionId: SessionId; userMessage: string }): Promise<{
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
    expect(history).toEqual([...previousMessages, runnerMessages[0]?.at(-1), assistantMessage]);
  });

  it("establishes a pending user turn boundary before RUN", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create();
    await sessionStore.updateMetadata(session.id, () => ({ project: "byte-mentor" }));
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: {
        async run() {
          throw new Error("stop at RUN boundary");
        },
      },
    });

    await expect(
      loop.runTurn({ sessionId: session.id, userMessage: "current question" }),
    ).rejects.toMatchObject({ state: "RUN" });

    expect(await sessionStore.getHistory(session.id)).toEqual([
      {
        id: expect.any(String),
        role: "user",
        content: "current question",
      },
    ]);
    expect((await sessionStore.get(session.id))?.metadata).toEqual({
      project: "byte-mentor",
      pending_user_turn: true,
    });
  });

  it("clears pending user turn metadata after completed SAVE", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create();
    await sessionStore.updateMetadata(session.id, () => ({
      project: "byte-mentor",
      pending_user_turn: false,
    }));
    const assistantMessage: Message = {
      id: createMessageId(),
      role: "assistant",
      content: "current answer",
    };
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: {
        async run() {
          return {
            newMessages: [assistantMessage],
            stopReason: "completed" as StopReason,
            events: [],
          };
        },
      },
    });

    await loop.runTurn({ sessionId: session.id, userMessage: "current question" });

    expect((await sessionStore.get(session.id))?.metadata).toEqual({
      project: "byte-mentor",
    });
  });

  it("repairs a pending user turn before building the current turn", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create();
    const interruptedUserMessage: Message = {
      id: createMessageId(),
      role: "user",
      content: "interrupted question",
    };
    await sessionStore.appendMessages(session.id, [interruptedUserMessage]);
    await sessionStore.updateMetadata(session.id, () => ({ pending_user_turn: true }));
    const runnerMessages: Message[][] = [];
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: {
        async run(input: { messages: Message[] }) {
          runnerMessages.push(input.messages);
          return {
            newMessages: [
              {
                id: createMessageId(),
                role: "assistant" as const,
                content: "current answer",
              },
            ],
            stopReason: "completed" as StopReason,
            events: [],
          };
        },
      },
    });

    await loop.runTurn({ sessionId: session.id, userMessage: "current question" });

    expect(runnerMessages).toEqual([
      [
        interruptedUserMessage,
        {
          id: expect.any(String),
          role: "assistant",
          content: "Error: Task interrupted before a response was generated.",
        },
        {
          id: expect.any(String),
          role: "user",
          content: "current question",
        },
      ],
    ]);
    expect(await sessionStore.getHistory(session.id)).toEqual([
      interruptedUserMessage,
      {
        id: expect.any(String),
        role: "assistant",
        content: "Error: Task interrupted before a response was generated.",
      },
      runnerMessages[0]?.at(-1),
      {
        id: expect.any(String),
        role: "assistant",
        content: "current answer",
      },
    ]);
  });

  it("clears a stale pending flag without adding an interrupted placeholder", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create();
    const previousMessages: Message[] = [
      { id: createMessageId(), role: "user", content: "previous question" },
      { id: createMessageId(), role: "assistant", content: "previous answer" },
    ];
    await sessionStore.appendMessages(session.id, previousMessages);
    await sessionStore.updateMetadata(session.id, () => ({
      project: "byte-mentor",
      pending_user_turn: true,
    }));
    const runnerMessages: Message[][] = [];
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: {
        async run(input: { messages: Message[] }) {
          runnerMessages.push(input.messages);
          return {
            newMessages: [
              {
                id: createMessageId(),
                role: "assistant" as const,
                content: "current answer",
              },
            ],
            stopReason: "completed" as StopReason,
            events: [],
          };
        },
      },
    });

    await loop.runTurn({ sessionId: session.id, userMessage: "current question" });

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
    expect((await sessionStore.get(session.id))?.metadata).toEqual({
      project: "byte-mentor",
    });
  });

  it("persists runner checkpoints until SAVE completes", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create();
    await sessionStore.updateMetadata(session.id, () => ({ project: "byte-mentor" }));
    const assistantMessage = {
      id: createMessageId(),
      role: "assistant" as const,
      content: "current answer",
    };
    const checkpoint: RuntimeCheckpoint = {
      phase: "final_response",
      iteration: 0,
      newMessages: [assistantMessage],
      pendingToolCalls: [],
    };
    let metadataDuringRun: Record<string, unknown> | undefined;
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: {
        async run(input: { checkpoint?: (payload: RuntimeCheckpoint) => Promise<void> }) {
          await input.checkpoint?.(checkpoint);
          metadataDuringRun = (await sessionStore.get(session.id))?.metadata;
          return {
            newMessages: [assistantMessage],
            stopReason: "completed" as StopReason,
            events: [],
          };
        },
      },
    });

    await loop.runTurn({ sessionId: session.id, userMessage: "current question" });

    expect(metadataDuringRun).toEqual({
      project: "byte-mentor",
      pending_user_turn: true,
      runtime_checkpoint: checkpoint,
    });
    expect((await sessionStore.get(session.id))?.metadata).toEqual({
      project: "byte-mentor",
    });
  });

  it("restores cumulative tool iterations before the current turn", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create();
    const previousUserMessage: Message = {
      id: createMessageId(),
      role: "user",
      content: "previous question",
    };
    const firstToolCallId = createToolCallId();
    const secondToolCallId = createToolCallId();
    const firstCheckpointAssistant = {
      id: createMessageId(),
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: firstToolCallId, name: "lookup", args: { query: "first" } }],
    };
    const firstCompletedToolResult = {
      id: createMessageId(),
      role: "tool" as const,
      toolCallId: firstToolCallId,
      content: "result:first",
    };
    const secondCheckpointAssistant = {
      id: createMessageId(),
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: secondToolCallId, name: "lookup", args: { query: "second" } }],
    };
    const secondCompletedToolResult = {
      id: createMessageId(),
      role: "tool" as const,
      toolCallId: secondToolCallId,
      content: "result:second",
    };
    await sessionStore.appendMessages(session.id, [previousUserMessage]);
    await sessionStore.updateMetadata(session.id, () => ({
      project: "byte-mentor",
      pending_user_turn: true,
      runtime_checkpoint: {
        phase: "tools_completed",
        iteration: 1,
        newMessages: [
          firstCheckpointAssistant,
          firstCompletedToolResult,
          secondCheckpointAssistant,
          secondCompletedToolResult,
        ],
        pendingToolCalls: [],
      } satisfies RuntimeCheckpoint,
    }));
    const runnerMessages: Message[][] = [];
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: {
        async run(input: { messages: Message[] }) {
          runnerMessages.push(input.messages);
          return {
            newMessages: [
              {
                id: createMessageId(),
                role: "assistant" as const,
                content: "current answer",
              },
            ],
            stopReason: "completed" as StopReason,
            events: [],
          };
        },
      },
    });

    await loop.runTurn({ sessionId: session.id, userMessage: "current question" });

    expect(runnerMessages).toEqual([
      [
        previousUserMessage,
        firstCheckpointAssistant,
        firstCompletedToolResult,
        secondCheckpointAssistant,
        secondCompletedToolResult,
        {
          id: expect.any(String),
          role: "user",
          content: "current question",
        },
      ],
    ]);
    expect((await sessionStore.get(session.id))?.metadata).toEqual({
      project: "byte-mentor",
    });
  });

  it("synthesizes interrupted results for pending checkpoint tool calls", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create();
    const previousUserMessage: Message = {
      id: createMessageId(),
      role: "user",
      content: "previous question",
    };
    const toolCallId = createToolCallId();
    const checkpointAssistant = {
      id: createMessageId(),
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
    };
    await sessionStore.appendMessages(session.id, [previousUserMessage]);
    await sessionStore.updateMetadata(session.id, () => ({
      runtime_checkpoint: {
        phase: "awaiting_tools",
        iteration: 0,
        newMessages: [checkpointAssistant],
        pendingToolCalls: checkpointAssistant.toolCalls,
      } satisfies RuntimeCheckpoint,
    }));
    const runnerMessages: Message[][] = [];
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: {
        async run(input: { messages: Message[] }) {
          runnerMessages.push(input.messages);
          return {
            newMessages: [
              {
                id: createMessageId(),
                role: "assistant" as const,
                content: "current answer",
              },
            ],
            stopReason: "completed" as StopReason,
            events: [],
          };
        },
      },
    });

    await loop.runTurn({ sessionId: session.id, userMessage: "current question" });

    expect(runnerMessages).toEqual([
      [
        previousUserMessage,
        checkpointAssistant,
        {
          id: expect.any(String),
          role: "tool",
          toolCallId,
          content: "Error: Task interrupted before this tool finished.",
        },
        {
          id: expect.any(String),
          role: "user",
          content: "current question",
        },
      ],
    ]);
  });

  it("deduplicates checkpoint messages already present at the session tail", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create();
    const toolCallId = createToolCallId();
    const previousUserMessage: Message = {
      id: createMessageId(),
      role: "user",
      content: "previous question",
    };
    const storedAssistant: Message = {
      id: createMessageId(),
      role: "assistant",
      content: "",
      toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
    };
    const checkpointAssistant = {
      id: createMessageId(),
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
    };
    const completedToolResult = {
      id: createMessageId(),
      role: "tool" as const,
      toolCallId,
      content: '{"ok":true,"data":"result:docs"}',
    };
    await sessionStore.appendMessages(session.id, [previousUserMessage, storedAssistant]);
    await sessionStore.updateMetadata(session.id, () => ({
      runtime_checkpoint: {
        phase: "tools_completed",
        iteration: 0,
        newMessages: [checkpointAssistant, completedToolResult],
        pendingToolCalls: [],
      } satisfies RuntimeCheckpoint,
    }));
    const runnerMessages: Message[][] = [];
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: {
        async run(input: { messages: Message[] }) {
          runnerMessages.push(input.messages);
          return {
            newMessages: [
              {
                id: createMessageId(),
                role: "assistant" as const,
                content: "current answer",
              },
            ],
            stopReason: "completed" as StopReason,
            events: [],
          };
        },
      },
    });

    await loop.runTurn({ sessionId: session.id, userMessage: "current question" });

    expect(runnerMessages).toEqual([
      [
        previousUserMessage,
        storedAssistant,
        completedToolResult,
        {
          id: expect.any(String),
          role: "user",
          content: "current question",
        },
      ],
    ]);
  });

  it("clears invalid runtime checkpoint metadata without blocking the turn", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create();
    await sessionStore.updateMetadata(session.id, () => ({
      project: "byte-mentor",
      runtime_checkpoint: "invalid checkpoint",
    }));
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: {
        async run() {
          return {
            newMessages: [
              {
                id: createMessageId(),
                role: "assistant" as const,
                content: "current answer",
              },
            ],
            stopReason: "completed" as StopReason,
            events: [],
          };
        },
      },
    });

    const result = await loop.runTurn({
      sessionId: session.id,
      userMessage: "current question",
    });

    expect(result.status).toBe("completed");
    expect((await sessionStore.get(session.id))?.metadata).toEqual({
      project: "byte-mentor",
    });
  });

  // 验证 Loop 保存 Runner 产生的 assistant 调用、JSON 工具结果和最终回答完整轨迹。
  it("persists tool-call trace from runner", async () => {
    const toolCallId = createToolCallId();
    const provider = invokeProvider(async (req) => {
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
    });
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
        return { ok: true, data: `result:${a.query}` };
      },
    });

    const result = await loop.runTurn({ userMessage: "find docs" });

    const history = await sessionStore.getHistory(result.sessionId);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      throw new Error(`expected completed result, got ${result.status}`);
    }
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
      content: '{"ok":true,"data":"result:docs"}',
    });
    expect(history[3]).toMatchObject({ role: "assistant", content: "found docs" });
    expect(result.finalMessage).toBe(history[3]);
  });

  // 验证一次工具 turn 的 Loop 事件包含上下文、模型和工具阶段，并保持发生顺序。
  it("emits runtime event sequence for a tool turn", async () => {
    const toolCallId = createToolCallId();
    const provider = invokeProvider(async (req) => {
      if (req.messages.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: toolCallId, name: "lookup", args: {} }],
          },
          stopReason: "tool_calls",
        };
      }
      return {
        message: { role: "assistant", content: "done" },
        stopReason: "completed",
      };
    });
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
        return { ok: true, data: "result:docs" };
      },
    });

    const result = await loop.runTurn({ userMessage: "find docs" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      throw new Error(`expected completed result, got ${result.status}`);
    }
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
      toolName: "lookup",
      durationMs: expect.any(Number),
      outputCharacters: 32,
      resultPreview: '{"ok":true,"data":"result:docs"}',
      resultPreviewTruncated: false,
    });
    expect(result.events[5]).not.toHaveProperty("result");
    expect(result.events[8]).toMatchObject({
      type: "turn.completed",
      sessionId: result.sessionId,
      messageId: result.finalMessage.id,
      stopReason: "completed",
    });
  });

  it("returns structured failed result when provider throws", async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create();
    await sessionStore.updateMetadata(session.id, () => ({
      project: "byte-mentor",
      pending_user_turn: false,
    }));
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: new AgentRunner(
        invokeProvider(async () => {
          throw new Error("provider unavailable");
        }),
      ),
    });

    const result = await loop.runTurn({ sessionId: session.id, userMessage: "hello" });

    const history = await sessionStore.getHistory(result.sessionId);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error(`expected failed result, got ${result.status}`);
    }
    expect(result.stopReason).toBe("failed");
    expect("finalMessage" in result).toBe(false);
    expect(result.error.message).toContain("provider unavailable");
    const trace = (result as typeof result & { trace: ExpectedStateTraceEntry[] }).trace;
    expect(trace).toBeDefined();
    expect(trace.map((entry) => entry.state)).toEqual([
      "RESTORE",
      "COMPACT",
      "COMMAND",
      "BUILD",
      "RUN",
      "SAVE",
      "RESPOND",
    ]);
    expect(result.newMessages).toEqual(history);
    expect(history).toEqual([
      {
        id: expect.any(String),
        role: "user",
        content: "hello",
      },
      {
        id: expect.any(String),
        role: "assistant",
        content: "[Assistant reply unavailable due to model error.]",
      },
    ]);
    expect((await sessionStore.get(session.id))?.metadata).toEqual({
      project: "byte-mentor",
    });
    expect(result.events.map((event) => event.type)).toEqual([
      "turn.started",
      "context.built",
      "model.requested",
      "turn.failed",
    ]);
    expect(result.events.at(-1)).toMatchObject({
      type: "turn.failed",
      sessionId: result.sessionId,
      message: expect.stringContaining("provider unavailable"),
    });
  });

  it("exports AgentLoopStateError for callers that inspect state failures", async () => {
    const agent = await import("@byte-mentor/agent");

    expect(agent).toHaveProperty("AgentLoopStateError");
    expect(Reflect.get(agent, "AgentLoopStateError")).toBeTypeOf("function");
  });

  it("wraps handler errors with the failed state, cause, and partial trace", async () => {
    const cause = new Error("context build failed");
    const sessionStore = new InMemorySessionStore();
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: {
        async build() {
          throw cause;
        },
      },
      runner: {
        async run() {
          throw new Error("runner should not be called");
        },
      },
    });

    const thrown = await loop.runTurn({ userMessage: "hello" }).catch((error: unknown) => error);

    expect(thrown).toMatchObject({
      name: "AgentLoopStateError",
      state: "BUILD",
      turnId: expect.any(String),
      sessionId: expect.any(String),
      trace: expect.any(Array),
    });
    expect(Reflect.get(thrown as object, "cause")).toBe(cause);
    const trace = Reflect.get(thrown as object, "trace") as ExpectedStateTraceEntry[];
    expect(trace.map((entry) => entry.state)).toEqual(["RESTORE", "COMPACT", "COMMAND"]);
    expect(trace.some((entry) => entry.state === "BUILD")).toBe(false);
  });

  it("returns structured max_iterations result without treating a tool message as final", async () => {
    const sessionStore = new InMemorySessionStore();
    const toolCallId = createToolCallId();
    const assistantMessage: Message = {
      id: createMessageId(),
      role: "assistant",
      content: "",
      toolCalls: [{ id: toolCallId, name: "lookup", args: null }],
    };
    const toolMessage: Message = {
      id: createMessageId(),
      role: "tool",
      toolCallId,
      content: "still needs more",
    };
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: {
        async run() {
          return {
            newMessages: [assistantMessage, toolMessage],
            stopReason: "max_iterations" as StopReason,
            events: [],
          };
        },
      },
    });

    const result = await loop.runTurn({ userMessage: "find docs" });

    const history = await sessionStore.getHistory(result.sessionId);
    expect(result.status).toBe("max_iterations");
    if (result.status !== "max_iterations") {
      throw new Error(`expected max_iterations result, got ${result.status}`);
    }
    expect(result.stopReason).toBe("max_iterations");
    expect("finalMessage" in result).toBe(false);
    expect(result.error.message).toContain("max iterations");
    expect(result.newMessages).toEqual(history);
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(result.events.map((event) => event.type)).toEqual([
      "turn.started",
      "context.built",
      "turn.failed",
    ]);
    expect(result.events.at(-1)).toMatchObject({
      type: "turn.failed",
      sessionId: result.sessionId,
      message: expect.stringContaining("max iterations"),
    });
  });

  it("passes stream event callback option to runner", async () => {
    const sessionStore = new InMemorySessionStore();
    const assistantMessage: Message = {
      id: createMessageId(),
      role: "assistant",
      content: "hello world",
    };
    const deltas: string[] = [];
    const receivedCallbacks: Array<((event: ProviderStreamEvent) => void) | undefined> = [];
    const runner = {
      async run(input: {
        messages: Message[];
        onStreamEvent?: (event: ProviderStreamEvent) => void;
      }) {
        receivedCallbacks.push(input.onStreamEvent);
        input.onStreamEvent?.({ type: "content_delta", text: "hello " });
        input.onStreamEvent?.({ type: "content_delta", text: "world" });
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
    }).runTurn(
      { userMessage: "hello" },
      {
        onStreamEvent(event) {
          if (event.type === "content_delta") {
            deltas.push(event.text);
          }
        },
      },
    );

    expect(result.status).toBe("completed");
    expect(receivedCallbacks).toHaveLength(1);
    expect(receivedCallbacks[0]).toBeTypeOf("function");
    expect(deltas).toEqual(["hello ", "world"]);
  });

  it("passes the turn signal option to runner", async () => {
    const sessionStore = new InMemorySessionStore();
    const controller = new AbortController();
    const assistantMessage: Message = {
      id: createMessageId(),
      role: "assistant",
      content: "done",
    };
    const receivedSignals: Array<AbortSignal | undefined> = [];
    const runner = {
      async run(input: { messages: Message[]; signal?: AbortSignal }) {
        receivedSignals.push(input.signal);
        return {
          newMessages: [assistantMessage],
          stopReason: "completed" as StopReason,
          events: [],
        };
      },
    };

    await new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner,
    }).runTurn({ userMessage: "hello" }, { signal: controller.signal });

    expect(receivedSignals).toEqual([controller.signal]);
  });

  // 取消终态返回 status/stopReason cancelled，不携带 error，并把合成 AssistantMessage
  // 持久化到 session，同时发出指向该消息的 turn.cancelled 事件。
  it("returns structured cancelled result with the synthetic assistant message", async () => {
    const sessionStore = new InMemorySessionStore();
    const cancelledMessage: Message = {
      id: createMessageId(),
      role: "assistant",
      content: "[Assistant reply cancelled.]",
    };
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: {
        async run() {
          return {
            newMessages: [cancelledMessage],
            stopReason: "cancelled" as StopReason,
            events: [],
          };
        },
      },
    });

    const result = await loop.runTurn({ userMessage: "stop this" });

    const history = await sessionStore.getHistory(result.sessionId);
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") {
      throw new Error(`expected cancelled result, got ${result.status}`);
    }
    expect(result.stopReason).toBe("cancelled");
    expect("finalMessage" in result).toBe(false);
    expect("error" in result).toBe(false);
    expect(result.newMessages).toEqual(history);
    expect(history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(history.at(-1)).toEqual(cancelledMessage);
    expect(result.events.map((event) => event.type)).toEqual([
      "turn.started",
      "context.built",
      "turn.cancelled",
    ]);
    expect(result.events.at(-1)).toMatchObject({
      type: "turn.cancelled",
      sessionId: result.sessionId,
      messageId: cancelledMessage.id,
      stopReason: "cancelled",
    });
  });
});
