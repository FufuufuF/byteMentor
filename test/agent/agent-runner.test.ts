import { describe, expect, it } from "vitest";
import { createMessageId, createToolCallId, createTurnId } from "@byte-mentor/core";
import type { AssistantMessage, Message, MessageId, ToolMessage } from "@byte-mentor/core";
import { AgentRunner, ToolRegistry } from "@byte-mentor/agent";
import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from "@byte-mentor/agent";

function streamProvider(
  invokeStream: (req: ProviderRequest) => AsyncIterable<ProviderStreamEvent>,
): ModelProvider {
  return {
    async invoke(req) {
      let done: Extract<ProviderStreamEvent, { type: "done" }> | undefined;
      for await (const event of invokeStream(req)) {
        if (event.type === "done") {
          done = event;
        }
      }
      if (done === undefined) {
        throw new Error("missing done event");
      }
      return {
        message: done.message,
        stopReason: done.stopReason,
      } satisfies ProviderResponse;
    },
    invokeStream,
  };
}

function invokeProvider(
  invoke: (req: ProviderRequest) => Promise<ProviderResponse>,
): ModelProvider {
  return streamProvider(async function* (req) {
    const response = await invoke(req);
    if (response.message.content !== undefined && response.message.content.length > 0) {
      yield { type: "content_delta", text: response.message.content };
    }
    yield {
      type: "done",
      message: response.message,
      stopReason: response.stopReason,
    };
  });
}

describe("AgentRunner.run", () => {
  it("returns final assistant message when provider completes", async () => {
    const inputMessages: Message[] = [{ id: createMessageId(), role: "user", content: "hello" }];
    const providerRequests: Message[][] = [];
    const provider = invokeProvider(async (req) => {
      providerRequests.push(req.messages);
      return {
        message: { role: "assistant", content: "done" },
        stopReason: "completed",
      };
    });

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: inputMessages,
      tools: new ToolRegistry(),
    });

    expect(providerRequests).toEqual([inputMessages]);
    expect(result.stopReason).toBe("completed");
    expect("finalMessage" in result).toBe(false);
    expect(result.newMessages.length).toBe(1);
    const [finalMessage] = result.newMessages as [AssistantMessage];
    expect(finalMessage.role).toBe("assistant");
    expect(finalMessage.content).toBe("done");
    expect(finalMessage.id).toEqual(expect.any(String) as MessageId);
    expect(Array.isArray(result.events)).toBe(true);
  });

  it("returns failed result when provider throws", async () => {
    const turnId = createTurnId();
    const provider = invokeProvider(async () => {
      throw new Error("provider unavailable");
    });

    const result = await new AgentRunner(provider).run({
      turnId,
      messages: [{ id: createMessageId(), role: "user", content: "hello" }],
      tools: new ToolRegistry(),
    });

    expect(result.stopReason).toBe("failed");
    expect(result.newMessages).toEqual([]);
    expect(result.events.map((event) => event.type)).toEqual(["model.requested"]);
  });

  it("executes one tool call before final provider response", async () => {
    const inputMessages: Message[] = [
      { id: createMessageId(), role: "user", content: "find docs" },
    ];
    const toolCallId = createToolCallId();
    const providerRequests: Message[][] = [];
    const provider = invokeProvider(async (req) => {
      providerRequests.push([...req.messages]);
      if (providerRequests.length === 1) {
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
    const tools = new ToolRegistry();
    tools.register({
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

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: inputMessages,
      tools,
    });

    expect(providerRequests.length).toBe(2);
    expect(providerRequests[1]).toEqual([
      inputMessages[0],
      result.newMessages[0],
      result.newMessages[1],
    ]);
    expect(result.stopReason).toBe("completed");
    expect(result.newMessages.length).toBe(3);
    const [toolCallMessage, toolResultMessage, finalMessage] = result.newMessages as [
      AssistantMessage,
      ToolMessage,
      AssistantMessage,
    ];
    expect(toolCallMessage.toolCalls).toEqual([
      { id: toolCallId, name: "lookup", args: { query: "docs" } },
    ]);
    expect(toolResultMessage).toMatchObject({
      role: "tool",
      toolCallId,
      content: "result:docs",
    });
    expect(finalMessage).toMatchObject({
      role: "assistant",
      content: "found docs",
    });
  });

  it("synthesizes a tool message for provider argument parse errors", async () => {
    const inputMessages: Message[] = [
      { id: createMessageId(), role: "user", content: "find docs" },
    ];
    const toolCallId = createToolCallId();
    const providerRequests: Message[][] = [];
    const provider = invokeProvider(async (req) => {
      providerRequests.push([...req.messages]);
      if (providerRequests.length === 1) {
        return {
          message: {
            role: "assistant",
            toolCalls: [
              {
                id: toolCallId,
                name: "lookup",
                args: "{bad-json",
                argsParseError: "Unexpected token b in JSON",
              },
            ],
          },
          stopReason: "tool_calls",
        };
      }
      return {
        message: { role: "assistant", content: "recovered" },
        stopReason: "completed",
      };
    });
    let toolExecuted = false;
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute() {
        toolExecuted = true;
        return { ok: true, result: "should not run" };
      },
    });

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: inputMessages,
      tools,
    });

    expect(toolExecuted).toBe(false);
    expect(result.stopReason).toBe("completed");
    expect(providerRequests.length).toBe(2);
    const [assistantMessage, toolMessage, finalMessage] = result.newMessages as [
      AssistantMessage,
      ToolMessage,
      AssistantMessage,
    ];
    expect(assistantMessage.toolCalls).toEqual([
      {
        id: toolCallId,
        name: "lookup",
        args: "{bad-json",
        argsParseError: "Unexpected token b in JSON",
      },
    ]);
    expect(toolMessage).toMatchObject({
      role: "tool",
      toolCallId,
      content: expect.stringContaining("Unexpected token b in JSON") as string,
    });
    expect(toolMessage.content).toContain("{bad-json");
    expect(finalMessage).toMatchObject({ role: "assistant", content: "recovered" });
    expect(providerRequests[1]).toEqual([inputMessages[0], assistantMessage, toolMessage]);
  });

  it("executes a valid retry after a parse error repair message", async () => {
    const inputMessages: Message[] = [
      { id: createMessageId(), role: "user", content: "find docs" },
    ];
    const malformedToolCallId = createToolCallId();
    const validToolCallId = createToolCallId();
    const provider = invokeProvider(async (req) => {
      if (req.messages.length === 1) {
        return {
          message: {
            role: "assistant",
            toolCalls: [
              {
                id: malformedToolCallId,
                name: "lookup",
                args: "{bad-json",
                argsParseError: "Unexpected token b in JSON",
              },
            ],
          },
          stopReason: "tool_calls",
        };
      }
      if (req.messages.length === 3) {
        return {
          message: {
            role: "assistant",
            toolCalls: [
              {
                id: validToolCallId,
                name: "lookup",
                args: { query: "docs" },
              },
            ],
          },
          stopReason: "tool_calls",
        };
      }
      return {
        message: { role: "assistant", content: "found docs" },
        stopReason: "completed",
      };
    });
    const executedArgs: unknown[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute(args) {
        executedArgs.push(args);
        return { ok: true, result: "result:docs" };
      },
    });

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: inputMessages,
      tools,
    });

    expect(result.stopReason).toBe("completed");
    expect(executedArgs).toEqual([{ query: "docs" }]);
    expect(result.newMessages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(result.newMessages[1]).toMatchObject({
      role: "tool",
      toolCallId: malformedToolCallId,
      content: expect.stringContaining("Unexpected token b in JSON") as string,
    });
    expect(result.newMessages[3]).toMatchObject({
      role: "tool",
      toolCallId: validToolCallId,
      content: "result:docs",
    });
  });

  it("records model and tool runtime events", async () => {
    const turnId = createTurnId();
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
        message: { role: "assistant", content: "done" },
        stopReason: "completed",
      };
    });
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute() {
        return { ok: true, result: "result:docs" };
      },
    });

    const result = await new AgentRunner(provider).run({
      turnId,
      messages: [{ id: createMessageId(), role: "user", content: "find docs" }],
      tools,
    });

    expect(result.events.map((event) => event.type)).toEqual([
      "model.requested",
      "model.responded",
      "tool.started",
      "tool.completed",
      "model.requested",
      "model.responded",
    ]);
    expect(result.events.every((event) => event.turnId === turnId)).toBe(true);
    expect(result.events.every((event) => typeof event.ts === "number")).toBe(true);
    expect(result.events[0]).toMatchObject({
      type: "model.requested",
      messageCount: 1,
      toolCount: 1,
    });
    expect(result.events[1]).toMatchObject({
      type: "model.responded",
      messageId: result.newMessages[0]?.id,
      stopReason: "tool_calls",
    });
    expect(result.events[2]).toMatchObject({
      type: "tool.started",
      toolCallId,
      toolName: "lookup",
    });
    expect(result.events[3]).toMatchObject({
      type: "tool.completed",
      toolCallId,
      result: "result:docs",
    });
    expect(result.events[4]).toMatchObject({
      type: "model.requested",
      messageCount: 3,
      toolCount: 1,
    });
    expect(result.events[5]).toMatchObject({
      type: "model.responded",
      messageId: result.newMessages[2]?.id,
      stopReason: "completed",
    });
  });

  it("stops with max_iterations when provider keeps requesting tools", async () => {
    const toolCallId = createToolCallId();
    let providerCallCount = 0;
    const provider = invokeProvider(async () => {
      providerCallCount += 1;
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: toolCallId, name: "lookup", args: null }],
        },
        stopReason: "tool_calls",
      };
    });
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute() {
        return { ok: true, result: "still needs more" };
      },
    });

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "find docs" }],
      tools,
      maxIterations: 1,
    });

    expect(providerCallCount).toBe(1);
    expect(result.stopReason).toBe("max_iterations");
    expect(result.newMessages.length).toBe(2);
    expect(result.newMessages[0]).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: toolCallId, name: "lookup", args: null }],
    });
    expect(result.newMessages[1]).toMatchObject({
      role: "tool",
      toolCallId,
      content: "still needs more",
    });
  });

  it("forwards content deltas for a final completed stream", async () => {
    const deltas: string[] = [];
    const provider = streamProvider(async function* () {
      yield { type: "content_delta", text: "hello " };
      yield { type: "content_delta", text: "world" };
      yield {
        type: "done",
        message: { role: "assistant", content: "hello world" },
        stopReason: "completed",
      };
    });

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "hello" }],
      tools: new ToolRegistry(),
      onStreamEvent(event) {
        if (event.type === "content_delta") {
          deltas.push(event.text);
        }
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(deltas).toEqual(["hello ", "world"]);
  });

  it("does not forward content deltas from intermediate tool-call streams", async () => {
    const toolCallId = createToolCallId();
    const deltas: string[] = [];
    const provider = streamProvider(async function* (req) {
      if (req.messages.length === 1) {
        yield { type: "content_delta", text: "checking tool" };
        yield {
          type: "done",
          message: {
            role: "assistant",
            content: "checking tool",
            toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
          },
          stopReason: "tool_calls",
        };
        return;
      }
      yield { type: "content_delta", text: "final " };
      yield { type: "content_delta", text: "answer" };
      yield {
        type: "done",
        message: { role: "assistant", content: "final answer" },
        stopReason: "completed",
      };
    });
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute() {
        return { ok: true, result: "result:docs" };
      },
    });

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "find docs" }],
      tools,
      onStreamEvent(event) {
        if (event.type === "content_delta") {
          deltas.push(event.text);
        }
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(deltas).toEqual(["final ", "answer"]);
    expect(result.newMessages[0]).toMatchObject({
      role: "assistant",
      content: "checking tool",
      toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
    });
  });
});
