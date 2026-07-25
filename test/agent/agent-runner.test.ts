import { describe, expect, it } from "vitest";
import { createMessageId, createToolCallId, createTurnId } from "@byte-mentor/core";
import type { AssistantMessage, Message, MessageId, ToolMessage } from "@byte-mentor/core";
import { AgentRunner, ToolRegistry } from "@byte-mentor/agent";
import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  RuntimeCheckpoint,
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

// 构造 awaiting_tools checkpoint 持久化失败场景，并返回工具是否被执行及 Runner 的失败结果。
async function runAwaitingToolsCheckpointFailure() {
  const firstToolCallId = createToolCallId();
  const secondToolCallId = createToolCallId();
  const provider = invokeProvider(async () => ({
    message: {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: firstToolCallId, name: "lookup", args: { query: "docs" } },
        { id: secondToolCallId, name: "summarize", args: { source: "docs" } },
      ],
    },
    stopReason: "tool_calls",
  }));
  const toolExecutions: string[] = [];
  const tools = new ToolRegistry();
  tools.register({
    name: "lookup",
    description: "lookup docs",
    async execute() {
      toolExecutions.push("lookup");
      return { ok: true, data: "lookup result" };
    },
  });
  tools.register({
    name: "summarize",
    description: "summarize docs",
    async execute() {
      toolExecutions.push("summarize");
      return { ok: true, data: "summary" };
    },
  });

  const result = await new AgentRunner(provider).run({
    turnId: createTurnId(),
    messages: [{ id: createMessageId(), role: "user", content: "hello" }],
    tools,
    async checkpoint() {
      throw new Error("checkpoint storage unavailable");
    },
  });

  return { firstToolCallId, secondToolCallId, result, toolExecutions };
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

  it("checkpoints a final assistant response", async () => {
    const checkpoints: RuntimeCheckpoint[] = [];
    const provider = invokeProvider(async () => ({
      message: { role: "assistant", content: "done" },
      stopReason: "completed",
    }));

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "hello" }],
      tools: new ToolRegistry(),
      async checkpoint(payload) {
        checkpoints.push(payload);
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(checkpoints).toEqual([
      {
        phase: "final_response",
        iteration: 0,
        newMessages: [
          {
            id: expect.any(String),
            role: "assistant",
            content: "done",
          },
        ],
        pendingToolCalls: [],
      },
    ]);
    const serialized = JSON.stringify(checkpoints[0]);
    expect(JSON.parse(serialized)).toEqual(checkpoints[0]);
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

  it("closes every pending tool call when awaiting-tools checkpoint persistence fails", async () => {
    const { firstToolCallId, secondToolCallId, result } = await runAwaitingToolsCheckpointFailure();

    expect(result.newMessages).toHaveLength(3);
    expect(result.newMessages).toMatchObject([
      {
        role: "assistant",
        toolCalls: [{ id: firstToolCallId }, { id: secondToolCallId }],
      },
      {
        role: "tool",
        toolCallId: firstToolCallId,
        content: "Error: Tool execution skipped because checkpoint persistence failed.",
      },
      {
        role: "tool",
        toolCallId: secondToolCallId,
        content: "Error: Tool execution skipped because checkpoint persistence failed.",
      },
    ]);
  });

  it("skips pending tools when awaiting-tools checkpoint persistence fails", async () => {
    const { toolExecutions } = await runAwaitingToolsCheckpointFailure();

    expect(toolExecutions).toEqual([]);
  });

  it("returns the original awaiting-tools checkpoint failure", async () => {
    const { result } = await runAwaitingToolsCheckpointFailure();

    expect(result.stopReason).toBe("failed");
    expect(result.error?.message).toContain("checkpoint storage unavailable");
  });

  // 验证模型请求工具后，Runner 把工具的 JSON 结果加入消息，再请求并返回最终回答。
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
        return { ok: true, data: `result:${a.query}` };
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
      content: '{"ok":true,"data":"result:docs"}',
    });
    expect(finalMessage).toMatchObject({
      role: "assistant",
      content: "found docs",
    });
  });

  // 验证工具执行前后的 checkpoint 分别记录待执行调用和已经序列化的工具结果。
  it("checkpoints tool calls before and after execution", async () => {
    const toolCallId = createToolCallId();
    const checkpoints: RuntimeCheckpoint[] = [];
    const provider = invokeProvider(async (req) =>
      req.messages.length === 1
        ? {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
            },
            stopReason: "tool_calls",
          }
        : {
            message: { role: "assistant", content: "found docs" },
            stopReason: "completed",
          },
    );
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute() {
        return { ok: true, data: "result:docs" };
      },
    });

    await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "find docs" }],
      tools,
      async checkpoint(payload) {
        checkpoints.push(payload);
      },
    });

    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "awaiting_tools",
      "tools_completed",
      "final_response",
    ]);
    expect(checkpoints[0]).toMatchObject({
      phase: "awaiting_tools",
      iteration: 0,
      newMessages: [
        {
          id: expect.any(String),
          role: "assistant",
          toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
        },
      ],
      pendingToolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
    });
    expect(checkpoints[1]).toMatchObject({
      phase: "tools_completed",
      iteration: 0,
      newMessages: [
        checkpoints[0]?.newMessages[0],
        {
          id: expect.any(String),
          role: "tool",
          toolCallId,
          content: '{"ok":true,"data":"result:docs"}',
        },
      ],
      pendingToolCalls: [],
    });
    expect(checkpoints[2]).toMatchObject({
      phase: "final_response",
      iteration: 1,
      newMessages: [
        checkpoints[0]?.newMessages[0],
        checkpoints[1]?.newMessages[1],
        {
          id: expect.any(String),
          role: "assistant",
          content: "found docs",
        },
      ],
      pendingToolCalls: [],
    });
    expect(checkpoints[0]?.newMessages).not.toBe(checkpoints[1]?.newMessages);
    expect(checkpoints[1]?.newMessages).not.toBe(checkpoints[2]?.newMessages);
    for (const checkpoint of checkpoints) {
      expect(JSON.parse(JSON.stringify(checkpoint))).toEqual(checkpoint);
    }
  });

  // 验证多轮工具调用的 checkpoint 累积完整消息轨迹，不覆盖前一轮结果。
  it("accumulates checkpoint messages across tool iterations", async () => {
    const firstToolCallId = createToolCallId();
    const secondToolCallId = createToolCallId();
    const checkpoints: RuntimeCheckpoint[] = [];
    const provider = invokeProvider(async (req) => {
      if (req.messages.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: firstToolCallId, name: "lookup", args: { query: "first" } }],
          },
          stopReason: "tool_calls",
        };
      }
      if (req.messages.length === 3) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: secondToolCallId, name: "lookup", args: { query: "second" } }],
          },
          stopReason: "tool_calls",
        };
      }
      return {
        message: { role: "assistant", content: "done" },
        stopReason: "completed",
      };
    });
    let execution = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute() {
        execution += 1;
        return { ok: true, data: `result:${execution}` };
      },
    });

    await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "find docs" }],
      tools,
      async checkpoint(payload) {
        checkpoints.push(payload);
      },
    });

    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "awaiting_tools",
      "tools_completed",
      "awaiting_tools",
      "tools_completed",
      "final_response",
    ]);
    expect(
      checkpoints.map((checkpoint) => checkpoint.newMessages.map((message) => message.role)),
    ).toEqual([
      ["assistant"],
      ["assistant", "tool"],
      ["assistant", "tool", "assistant"],
      ["assistant", "tool", "assistant", "tool"],
      ["assistant", "tool", "assistant", "tool", "assistant"],
    ]);
    expect(checkpoints[2]?.newMessages.slice(0, 2)).toEqual(checkpoints[1]?.newMessages);
    expect(checkpoints[3]?.newMessages).toMatchObject([
      checkpoints[0]?.newMessages[0],
      {
        role: "tool",
        toolCallId: firstToolCallId,
        content: '{"ok":true,"data":"result:1"}',
      },
      { role: "assistant", toolCalls: [{ id: secondToolCallId }] },
      {
        role: "tool",
        toolCallId: secondToolCallId,
        content: '{"ok":true,"data":"result:2"}',
      },
    ]);
  });

  // 验证 Provider 参数解析失败时生成修复提示，并且不会执行对应工具。
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
        return { ok: true, data: "should not run" };
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

  it("checkpoints synthesized results for tool argument parse errors", async () => {
    const toolCallId = createToolCallId();
    const checkpoints: RuntimeCheckpoint[] = [];
    const provider = invokeProvider(async (req) =>
      req.messages.length === 1
        ? {
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
          }
        : {
            message: { role: "assistant", content: "recovered" },
            stopReason: "completed",
          },
    );

    await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "find docs" }],
      tools: new ToolRegistry(),
      async checkpoint(payload) {
        checkpoints.push(payload);
      },
    });

    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "awaiting_tools",
      "tools_completed",
      "final_response",
    ]);
    expect(checkpoints[1]).toMatchObject({
      phase: "tools_completed",
      newMessages: [
        {
          role: "assistant",
          toolCalls: [{ id: toolCallId }],
        },
        {
          role: "tool",
          toolCallId,
          content: expect.stringContaining("Unexpected token b in JSON") as string,
        },
      ],
      pendingToolCalls: [],
    });
  });

  // 验证模型看到参数修复提示后可以重试，且合法参数只执行一次并产生 JSON 工具结果。
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
        return { ok: true, data: "result:docs" };
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
      content: '{"ok":true,"data":"result:docs"}',
    });
  });

  // 验证一次工具轮次按顺序记录模型请求、模型响应、工具开始和工具完成事件。
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
        return { ok: true, data: "result:docs" };
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
      result: '{"ok":true,"data":"result:docs"}',
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

  // 验证模型持续请求工具时，Runner 达到迭代上限便停止，同时保留已经产生的工具消息。
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
        return { ok: true, data: "still needs more" };
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
      content: '{"ok":true,"data":"still needs more"}',
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

  // 验证中间工具调用响应的文本增量不会展示给用户，只有最终回答的增量会被转发。
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
        return { ok: true, data: "result:docs" };
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
