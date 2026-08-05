import { describe, expect, it } from "vitest";
import { createMessageId, createToolCallId, createTurnId } from "@byte-mentor/core";
import type {
  AssistantMessage,
  Message,
  MessageId,
  RuntimeEvent,
  ToolCall,
  ToolMessage,
} from "@byte-mentor/core";
import { AgentRunner, ToolRegistry } from "@byte-mentor/agent";
import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  RuntimeCheckpoint,
  ToolResult,
} from "@byte-mentor/agent";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function settleAsyncWork(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !condition(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

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

function oneBatchProvider(toolCalls: ToolCall[], requests?: Message[][]): ModelProvider {
  return invokeProvider(async (req) => {
    requests?.push([...req.messages]);
    return req.messages.length === 1
      ? {
          message: { role: "assistant", toolCalls },
          stopReason: "tool_calls",
        }
      : {
          message: { role: "assistant", content: "done" },
          stopReason: "completed",
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

  // 工具返回预期失败时，Runner 应把完整错误 envelope 写入 ToolMessage，并继续把该消息交给模型生成最终回答。
  it("writes a serialized tool failure before the final provider response", async () => {
    const inputMessages: Message[] = [
      { id: createMessageId(), role: "user", content: "read missing file" },
    ];
    const toolCallId = createToolCallId();
    const provider = invokeProvider(async (req) =>
      req.messages.length === 1
        ? {
            message: {
              role: "assistant",
              toolCalls: [{ id: toolCallId, name: "read_file", args: { path: "missing.txt" } }],
            },
            stopReason: "tool_calls",
          }
        : {
            message: { role: "assistant", content: "The file does not exist." },
            stopReason: "completed",
          },
    );
    const tools = new ToolRegistry();
    tools.register({
      name: "read_file",
      description: "read one file",
      async execute() {
        return {
          ok: false,
          error: {
            code: "path_not_found",
            message: "missing file",
            details: { path: "missing.txt" },
          },
        };
      },
    });

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: inputMessages,
      tools,
    });

    expect(result.stopReason).toBe("completed");
    const toolMessage = result.newMessages[1] as ToolMessage;
    expect(JSON.parse(toolMessage.content)).toEqual({
      ok: false,
      error: {
        code: "path_not_found",
        message: "missing file",
        details: { path: "missing.txt" },
      },
    });
    expect(result.newMessages[2]).toMatchObject({
      role: "assistant",
      content: "The file does not exist.",
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
      toolName: "lookup",
      durationMs: expect.any(Number),
      outputCharacters: 32,
      resultPreview: '{"ok":true,"data":"result:docs"}',
      resultPreviewTruncated: false,
    });
    expect(result.events[3]).not.toHaveProperty("result");
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

  // Holds tool execution open to prove tool.started is observed before the tool promise resolves.
  it("observes tool start while execution is still pending", async () => {
    const toolCallId = createToolCallId();
    const releaseTool = deferred<void>();
    const observed: RuntimeEvent[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute() {
        await releaseTool.promise;
        return { ok: true, data: "done" };
      },
    });
    const runPromise = new AgentRunner(
      oneBatchProvider([{ id: toolCallId, name: "lookup", args: {} }]),
    ).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "find docs" }],
      tools,
      onRuntimeEvent(event) {
        observed.push(event);
      },
    });

    await settleAsyncWork(() => observed.some((event) => event.type === "tool.started"));
    try {
      expect(observed.map((event) => event.type)).toEqual([
        "model.requested",
        "model.responded",
        "tool.started",
      ]);
    } finally {
      releaseTool.resolve();
      await runPromise;
    }
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
          toolCalls: [{ id: toolCallId, name: "lookup", args: {} }],
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
      toolCalls: [{ id: toolCallId, name: "lookup", args: {} }],
    });
    expect(result.newMessages[1]).toMatchObject({
      role: "tool",
      toolCallId,
      content: '{"ok":true,"data":"still needs more"}',
    });
  });

  // Holds the provider after its first yield so the callback must prove it observes data before run resolves.
  it("forwards a content delta while the provider stream is still running", async () => {
    const releaseStream = deferred<void>();
    const providerRequestedNextEvent = deferred<void>();
    const observed: ProviderStreamEvent[] = [];
    const provider = streamProvider(async function* () {
      yield { type: "content_delta", text: "hello" };
      providerRequestedNextEvent.resolve();
      await releaseStream.promise;
      yield {
        type: "done",
        message: { role: "assistant", content: "hello" },
        stopReason: "completed",
      };
    });
    let runSettled = false;
    const runPromise = new AgentRunner(provider)
      .run({
        turnId: createTurnId(),
        messages: [{ id: createMessageId(), role: "user", content: "hello" }],
        tools: new ToolRegistry(),
        onStreamEvent(event) {
          observed.push(event);
        },
      })
      .finally(() => {
        runSettled = true;
      });

    await providerRequestedNextEvent.promise;
    try {
      expect(observed).toEqual([{ type: "content_delta", text: "hello" }]);
      expect(runSettled).toBe(false);
    } finally {
      releaseStream.resolve();
      await runPromise;
    }
  });

  // Verifies callback order exactly matches all provider yields, including the terminal done event.
  it("forwards content deltas and done in provider order", async () => {
    const observed: ProviderStreamEvent[] = [];
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
        observed.push(event);
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(observed).toEqual([
      { type: "content_delta", text: "hello " },
      { type: "content_delta", text: "world" },
      {
        type: "done",
        message: { role: "assistant", content: "hello world" },
        stopReason: "completed",
      },
    ]);
  });

  // Keeps AgentRunner's stream observer private while exposing only the declared request fields to providers.
  it("does not include the stream observer in the provider request", async () => {
    let providerRequestKeys: string[] = [];
    const provider = streamProvider(async function* (request) {
      providerRequestKeys = Object.keys(request).sort();
      yield {
        type: "done",
        message: { role: "assistant", content: "hello" },
        stopReason: "completed",
      };
    });

    await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "hello" }],
      tools: new ToolRegistry(),
      onStreamEvent() {},
    });

    expect(providerRequestKeys).toEqual(["messages", "tools"]);
  });

  // Verifies each tool-call and final iteration exposes its deltas and done boundary in yield order.
  it("forwards every event across tool-call and final stream iterations", async () => {
    const toolCallId = createToolCallId();
    const observed: ProviderStreamEvent[] = [];
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
        observed.push(event);
      },
    });

    expect(result.stopReason).toBe("completed");
    expect(observed.map((event) => event.type)).toEqual([
      "content_delta",
      "done",
      "content_delta",
      "content_delta",
      "done",
    ]);
    expect(
      observed.filter((event) => event.type === "content_delta").map((event) => event.text),
    ).toEqual(["checking tool", "final ", "answer"]);
    expect(result.newMessages[0]).toMatchObject({
      role: "assistant",
      content: "checking tool",
      toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
    });
  });

  // Verifies a partial response remains observable even when the provider throws before its done event.
  it("forwards partial content before returning a provider failure", async () => {
    const observed: ProviderStreamEvent[] = [];
    const provider = streamProvider(async function* () {
      yield { type: "content_delta", text: "partial" };
      throw new Error("provider disconnected");
    });

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "hello" }],
      tools: new ToolRegistry(),
      onStreamEvent(event) {
        observed.push(event);
      },
    });

    expect(observed).toEqual([{ type: "content_delta", text: "partial" }]);
    expect(result).toMatchObject({
      stopReason: "failed",
      error: { message: "provider disconnected" },
    });
  });

  // 非正整数并发度会让调度语义失去边界，因此 Runner 必须在构造时快速失败。
  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid maxConcurrentToolCalls value %s",
    (maxConcurrentToolCalls) => {
      const provider = oneBatchProvider([]);

      expect(() => new AgentRunner(provider, { maxConcurrentToolCalls })).toThrow(
        "maxConcurrentToolCalls must be a positive integer",
      );
    },
  );

  // 六个 safe 调用共享阻塞门；默认配置只应先启动四个，同时证明确有 I/O 重叠。
  it("bounds safe tool calls at the default concurrency of four", async () => {
    const toolCalls = Array.from({ length: 6 }, (_, index) => ({
      id: createToolCallId(),
      name: "safe_read",
      args: { index },
    }));
    const release = deferred<void>();
    const started: number[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "safe_read",
      description: "read safely",
      concurrency: "safe",
      async execute(args) {
        const { index } = args as { index: number };
        started.push(index);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await release.promise;
        inFlight -= 1;
        return { ok: true, data: index };
      },
    });
    const runPromise = new AgentRunner(oneBatchProvider(toolCalls)).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "read all" }],
      tools,
    });

    await settleAsyncWork(() => started.length >= 4);
    try {
      expect([...started]).toEqual([0, 1, 2, 3]);
      expect(peakInFlight).toBe(4);
    } finally {
      release.resolve();
      await runPromise;
    }
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peakInFlight).toBe(4);
  });

  // 显式并发度二应覆盖完整 execute 生命周期，第三个调用必须等前两个之一完成后才启动。
  it("honors a configured safe tool concurrency limit", async () => {
    const toolCalls = Array.from({ length: 5 }, (_, index) => ({
      id: createToolCallId(),
      name: "safe_search",
      args: { index },
    }));
    const release = deferred<void>();
    const started: number[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "safe_search",
      description: "search safely",
      concurrency: "safe",
      async execute(args) {
        const { index } = args as { index: number };
        started.push(index);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await release.promise;
        inFlight -= 1;
        return { ok: true, data: index };
      },
    });
    const runPromise = new AgentRunner(oneBatchProvider(toolCalls), {
      maxConcurrentToolCalls: 2,
    }).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "search all" }],
      tools,
    });

    await settleAsyncWork(() => started.length >= 2);
    try {
      expect([...started]).toEqual([0, 1]);
      expect(peakInFlight).toBe(2);
    } finally {
      release.resolve();
      await runPromise;
    }
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peakInFlight).toBe(2);
  });

  // 只要批次含未声明 safe 的工具，前一个 safe 调用阻塞时后续调用都不得提前启动。
  it("keeps mixed-concurrency tool batches serial", async () => {
    const release = deferred<void>();
    const started: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "safe_read",
      description: "read safely",
      concurrency: "safe",
      async execute(args) {
        started.push((args as { label: string }).label);
        await release.promise;
        return { ok: true, data: "safe" };
      },
    });
    tools.register({
      name: "serial_write",
      description: "write serially",
      async execute(args) {
        started.push((args as { label: string }).label);
        await release.promise;
        return { ok: true, data: "serial" };
      },
    });
    const runPromise = new AgentRunner(
      oneBatchProvider([
        { id: createToolCallId(), name: "safe_read", args: { label: "first" } },
        { id: createToolCallId(), name: "serial_write", args: { label: "second" } },
        { id: createToolCallId(), name: "safe_read", args: { label: "third" } },
      ]),
      { maxConcurrentToolCalls: 3 },
    ).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "mixed batch" }],
      tools,
    });

    await settleAsyncWork(() => started.length >= 1);
    try {
      expect(started).toEqual(["first"]);
    } finally {
      release.resolve();
      await runPromise;
    }
    expect(started).toEqual(["first", "second", "third"]);
  });

  // 未知工具默认属于 serial；它出现在批次中时，不能让同批 safe 调用绕过保守调度。
  it("keeps batches containing an unknown tool serial", async () => {
    const release = deferred<void>();
    const started: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "safe_read",
      description: "read safely",
      concurrency: "safe",
      async execute(args) {
        started.push((args as { label: string }).label);
        await release.promise;
        return { ok: true, data: "safe" };
      },
    });
    const runPromise = new AgentRunner(
      oneBatchProvider([
        { id: createToolCallId(), name: "safe_read", args: { label: "first" } },
        { id: createToolCallId(), name: "missing_tool", args: {} },
        { id: createToolCallId(), name: "safe_read", args: { label: "third" } },
      ]),
      { maxConcurrentToolCalls: 3 },
    ).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "unknown batch" }],
      tools,
    });

    await settleAsyncWork(() => started.length >= 1);
    try {
      expect(started).toEqual(["first"]);
    } finally {
      release.resolve();
      await runPromise;
    }
    expect(started).toEqual(["first", "third"]);
  });

  // 参数解析失败也使整批串行，但失败位置仍应生成 ToolMessage 且不执行对应工具。
  it("keeps batches containing an argument parse failure serial", async () => {
    const firstId = createToolCallId();
    const malformedId = createToolCallId();
    const thirdId = createToolCallId();
    const release = deferred<void>();
    const started: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "safe_read",
      description: "read safely",
      concurrency: "safe",
      async execute(args) {
        started.push((args as { label: string }).label);
        await release.promise;
        return { ok: true, data: "safe" };
      },
    });
    const runPromise = new AgentRunner(
      oneBatchProvider([
        { id: firstId, name: "safe_read", args: { label: "first" } },
        {
          id: malformedId,
          name: "safe_read",
          args: "{bad-json",
          argsParseError: "Unexpected token b in JSON",
        },
        { id: thirdId, name: "safe_read", args: { label: "third" } },
      ]),
      { maxConcurrentToolCalls: 3 },
    ).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "malformed batch" }],
      tools,
    });

    await settleAsyncWork(() => started.length >= 1);
    let result: Awaited<ReturnType<AgentRunner["run"]>>;
    try {
      expect(started).toEqual(["first"]);
    } finally {
      release.resolve();
      result = await runPromise;
    }
    expect(started).toEqual(["first", "third"]);
    expect(result.newMessages.slice(1, 4)).toMatchObject([
      { role: "tool", toolCallId: firstId },
      {
        role: "tool",
        toolCallId: malformedId,
        content: expect.stringContaining("Unexpected token b in JSON") as string,
      },
      { role: "tool", toolCallId: thirdId },
    ]);
  });

  // 两个 safe 调用反向完成且其中一个失败时，消息和 tools_completed checkpoint 仍按调用顺序组装。
  it("preserves tool call order when concurrent completion order differs", async () => {
    const firstId = createToolCallId();
    const secondId = createToolCallId();
    const completions = {
      first: deferred<ToolResult>(),
      second: deferred<ToolResult>(),
    };
    const started: string[] = [];
    const providerRequests: Message[][] = [];
    const checkpoints: RuntimeCheckpoint[] = [];
    const observed: RuntimeEvent[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "safe_read",
      description: "read safely",
      concurrency: "safe",
      async execute(args) {
        const label = (args as { label: "first" | "second" }).label;
        started.push(label);
        return completions[label].promise;
      },
    });
    const runPromise = new AgentRunner(
      oneBatchProvider(
        [
          { id: firstId, name: "safe_read", args: { label: "first" } },
          { id: secondId, name: "safe_read", args: { label: "second" } },
        ],
        providerRequests,
      ),
      { maxConcurrentToolCalls: 2 },
    ).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "ordered batch" }],
      tools,
      async checkpoint(payload) {
        checkpoints.push(payload);
      },
      onRuntimeEvent(event) {
        observed.push(event);
      },
    });

    await settleAsyncWork(() => started.length >= 2);
    let result: Awaited<ReturnType<AgentRunner["run"]>>;
    try {
      expect([...started]).toEqual(["first", "second"]);
      completions.second.resolve({
        ok: false,
        error: { code: "path_not_found", message: "second failed" },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        observed
          .filter((event) => event.type === "tool.completed" || event.type === "tool.failed")
          .map((event) => [event.type, event.toolCallId]),
      ).toEqual([["tool.failed", secondId]]);
      completions.first.resolve({ ok: true, data: "first result" });
      result = await runPromise;
    } finally {
      completions.first.resolve({ ok: true, data: "first result" });
      completions.second.resolve({
        ok: false,
        error: { code: "path_not_found", message: "second failed" },
      });
      result = await runPromise;
    }

    expect(result.newMessages.slice(1, 3)).toMatchObject([
      {
        role: "tool",
        toolCallId: firstId,
        content: '{"ok":true,"data":"first result"}',
      },
      {
        role: "tool",
        toolCallId: secondId,
        content: '{"ok":false,"error":{"code":"path_not_found","message":"second failed"}}',
      },
    ]);
    expect(providerRequests[1]?.slice(-2)).toEqual(result.newMessages.slice(1, 3));
    const toolsCompleted = checkpoints.find((checkpoint) => checkpoint.phase === "tools_completed");
    expect(toolsCompleted?.newMessages.slice(1, 3)).toEqual(result.newMessages.slice(1, 3));
    expect(result.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "tool.failed")).toHaveLength(1);
    expect(
      result.events
        .filter((event) => event.type === "tool.completed" || event.type === "tool.failed")
        .map((event) => [event.type, event.toolCallId]),
    ).toEqual([
      ["tool.failed", secondId],
      ["tool.completed", firstId],
    ]);
    expect(observed).toEqual(result.events);
  });

  // 长 emoji 结果按 Unicode code point 截取前 500 个字符，并仅在 ToolMessage 保留完整 JSON。
  it("emits a bounded Unicode result preview for successful tools", async () => {
    const toolCallId = createToolCallId();
    const tools = new ToolRegistry();
    tools.register({
      name: "safe_read",
      description: "read safely",
      concurrency: "safe",
      async execute() {
        return { ok: true, data: "😀".repeat(600) };
      },
    });

    const result = await new AgentRunner(
      oneBatchProvider([{ id: toolCallId, name: "safe_read", args: {} }]),
    ).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "preview" }],
      tools,
    });
    const toolMessage = result.newMessages[1] as ToolMessage;
    const completed = result.events.find(
      (event): event is Extract<RuntimeEvent, { type: "tool.completed" }> =>
        event.type === "tool.completed",
    );

    expect(completed).toEqual({
      type: "tool.completed",
      turnId: expect.any(String),
      ts: expect.any(Number),
      toolCallId,
      toolName: "safe_read",
      durationMs: expect.any(Number),
      outputCharacters: toolMessage.content.length,
      resultPreview: [...toolMessage.content].slice(0, 500).join(""),
      resultPreviewTruncated: true,
    });
    expect(completed).not.toHaveProperty("result");
  });

  // 预期 ToolResult 失败应生成结构化失败观测，完整失败 envelope 仍只写入 ToolMessage。
  it("emits structured observation metadata for failed tools", async () => {
    const toolCallId = createToolCallId();
    const tools = new ToolRegistry();
    tools.register({
      name: "safe_read",
      description: "read safely",
      concurrency: "safe",
      async execute() {
        return {
          ok: false,
          error: { code: "path_not_found", message: "missing file" },
        };
      },
    });

    const result = await new AgentRunner(
      oneBatchProvider([{ id: toolCallId, name: "safe_read", args: {} }]),
    ).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "missing" }],
      tools,
    });
    const failed = result.events.find(
      (event): event is Extract<RuntimeEvent, { type: "tool.failed" }> =>
        event.type === "tool.failed",
    );

    expect(failed).toEqual({
      type: "tool.failed",
      turnId: expect.any(String),
      ts: expect.any(Number),
      toolCallId,
      toolName: "safe_read",
      durationMs: expect.any(Number),
      errorCode: "path_not_found",
      message: "missing file",
    });
    expect(result.newMessages[1]).toMatchObject({
      role: "tool",
      toolCallId,
      content: '{"ok":false,"error":{"code":"path_not_found","message":"missing file"}}',
    });
  });
});

// 等待 AbortSignal 触发后以错误结束，模拟 Provider 在模型生成阶段因 signal 被中止。
function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("stream aborted"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new Error("stream aborted")), { once: true });
  });
}

describe("AgentRunner.run cancellation", () => {
  // 模型请求前 signal 已取消时不得启动新工作：不调用 Provider，返回 cancelled 且不含工具调用。
  it("returns cancelled without invoking the provider when already aborted", async () => {
    let providerInvoked = false;
    const provider = invokeProvider(async () => {
      providerInvoked = true;
      return { message: { role: "assistant", content: "done" }, stopReason: "completed" };
    });
    const controller = new AbortController();
    controller.abort();

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "hello" }],
      tools: new ToolRegistry(),
      signal: controller.signal,
    });

    expect(providerInvoked).toBe(false);
    expect(result.stopReason).toBe("cancelled");
    expect(result.error).toBeUndefined();
    expect(result.events).toEqual([]);
    expect(result.newMessages).toEqual([
      {
        id: expect.any(String),
        role: "assistant",
        content: "[Assistant reply cancelled.]",
      },
    ]);
  });

  // 模型流期间取消会中止 Provider 且不进入 Tool 阶段；signal 必须通过独立 invocation options 传递。
  it("cancels a provider stream in progress and never enters the tool phase", async () => {
    let receivedSignal: AbortSignal | undefined;
    const provider: ModelProvider = {
      async invoke() {
        throw new Error("unused");
      },
      async *invokeStream(_req, options) {
        receivedSignal = options?.signal;
        yield { type: "content_delta", text: "partial " };
        await waitForAbort(options?.signal);
      },
    };
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const pending = new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "hello" }],
      tools: new ToolRegistry(),
      signal: controller.signal,
      onRuntimeEvent: (event) => events.push(event),
    });

    await settleAsyncWork(() => receivedSignal !== undefined);
    controller.abort();
    const result = await pending;

    expect(receivedSignal).toBe(controller.signal);
    expect(result.stopReason).toBe("cancelled");
    expect(events.map((event) => event.type)).toEqual(["model.requested"]);
    expect(result.newMessages).toEqual([
      {
        id: expect.any(String),
        role: "assistant",
        content: "[Assistant reply cancelled.]",
      },
    ]);
  });

  // 最终 done 已提交后到达的迟到 abort 不得把 completed 改写为取消。
  it("keeps completed when the signal aborts after the final done", async () => {
    const controller = new AbortController();
    const provider = invokeProvider(async () => ({
      message: { role: "assistant", content: "done" },
      stopReason: "completed",
    }));

    const result = await new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "hello" }],
      tools: new ToolRegistry(),
      signal: controller.signal,
    });
    controller.abort();

    expect(result.stopReason).toBe("completed");
    expect(result.newMessages).toHaveLength(1);
    expect(result.newMessages[0]).toMatchObject({ role: "assistant", content: "done" });
  });

  // 串行批次取消时，已启动调用等待真实 I/O 收敛并保留真实结果，未启动调用获得 tool_cancelled ToolMessage。
  it("cancels unstarted serial calls while keeping the started call's real result", async () => {
    const firstToolCallId = createToolCallId();
    const secondToolCallId = createToolCallId();
    const provider = invokeProvider(async () => ({
      message: {
        role: "assistant",
        toolCalls: [
          { id: firstToolCallId, name: "slow", args: {} },
          { id: secondToolCallId, name: "never", args: {} },
        ],
      },
      stopReason: "tool_calls",
    }));
    const gate = deferred<void>();
    let neverExecuted = false;
    const tools = new ToolRegistry();
    tools.register({
      name: "slow",
      description: "slow tool",
      async execute() {
        await gate.promise;
        return { ok: true, data: "slow done" };
      },
    });
    tools.register({
      name: "never",
      description: "never runs",
      async execute() {
        neverExecuted = true;
        return { ok: true, data: "never" };
      },
    });
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const pending = new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "batch" }],
      tools,
      signal: controller.signal,
      onRuntimeEvent: (event) => events.push(event),
    });

    await settleAsyncWork(() => events.some((event) => event.type === "tool.started"));
    controller.abort();
    gate.resolve();
    const result = await pending;

    expect(neverExecuted).toBe(false);
    expect(result.stopReason).toBe("cancelled");
    expect(result.newMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: "[Assistant reply cancelled.]",
    });
    expect(events.filter((event) => event.type === "tool.completed")).toEqual([
      expect.objectContaining({ toolCallId: firstToolCallId }),
    ]);
    expect(events.filter((event) => event.type === "tool.cancelled")).toEqual([
      expect.objectContaining({
        toolCallId: secondToolCallId,
        started: false,
        durationMs: 0,
        errorCode: "tool_cancelled",
      }),
    ]);
    const toolMessages = result.newMessages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[1]).toMatchObject({ toolCallId: secondToolCallId });
    expect(JSON.parse((toolMessages[1] as ToolMessage).content)).toMatchObject({
      ok: false,
      error: { code: "tool_cancelled" },
    });
  });

  // 已启动调用只有在真实错误码为 tool_cancelled 时产生 tool.cancelled { started: true }；
  // 未启动调用始终使用 started: false 且 durationMs 为 0。
  it("maps a started tool_cancelled result to a started tool.cancelled event", async () => {
    const firstToolCallId = createToolCallId();
    const secondToolCallId = createToolCallId();
    const provider = invokeProvider(async () => ({
      message: {
        role: "assistant",
        toolCalls: [
          { id: firstToolCallId, name: "cancel_me", args: {} },
          { id: secondToolCallId, name: "never", args: {} },
        ],
      },
      stopReason: "tool_calls",
    }));
    const gate = deferred<void>();
    const tools = new ToolRegistry();
    tools.register({
      name: "cancel_me",
      description: "returns a cancellation error",
      async execute() {
        await gate.promise;
        return {
          ok: false,
          error: { code: "tool_cancelled", message: "cancelled during write" },
        };
      },
    });
    tools.register({
      name: "never",
      description: "never runs",
      async execute() {
        return { ok: true, data: "never" };
      },
    });
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const pending = new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "batch" }],
      tools,
      signal: controller.signal,
      onRuntimeEvent: (event) => events.push(event),
    });

    await settleAsyncWork(() => events.some((event) => event.type === "tool.started"));
    controller.abort();
    gate.resolve();
    const result = await pending;

    expect(result.stopReason).toBe("cancelled");
    expect(events.filter((event) => event.type === "tool.cancelled")).toEqual([
      expect.objectContaining({
        toolCallId: firstToolCallId,
        started: true,
        errorCode: "tool_cancelled",
      }),
      expect.objectContaining({
        toolCallId: secondToolCallId,
        started: false,
        durationMs: 0,
        errorCode: "tool_cancelled",
      }),
    ]);
  });

  // 并发 safe 批次取消后停止领取新任务，等待已领取调用结束，再按原始顺序组装全部 ToolMessage。
  it("stops claiming new calls in a concurrent safe batch after cancellation", async () => {
    const toolCalls = Array.from({ length: 3 }, (_, index) => ({
      id: createToolCallId(),
      name: "safe_read",
      args: { index },
    }));
    const release = deferred<void>();
    const started: number[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "safe_read",
      description: "read safely",
      concurrency: "safe",
      async execute(args) {
        const { index } = args as { index: number };
        started.push(index);
        await release.promise;
        return { ok: true, data: index };
      },
    });
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const pending = new AgentRunner(oneBatchProvider(toolCalls), {
      maxConcurrentToolCalls: 2,
    }).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "read all" }],
      tools,
      signal: controller.signal,
      onRuntimeEvent: (event) => events.push(event),
    });

    await settleAsyncWork(() => started.length >= 2);
    controller.abort();
    release.resolve();
    const result = await pending;

    expect(started).toEqual([0, 1]);
    expect(result.stopReason).toBe("cancelled");
    expect(events.filter((event) => event.type === "tool.cancelled")).toEqual([
      expect.objectContaining({ toolCallId: toolCalls[2].id, started: false }),
    ]);
    const toolMessages = result.newMessages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[2]).toMatchObject({ toolCallId: toolCalls[2].id });
  });

  // 取消终态写入 pendingToolCalls 为空的 cancelled checkpoint，
  // 合成 AssistantMessage 同时出现在 checkpoint 与最终 newMessages 中。
  it("persists a cancelled checkpoint with the synthetic assistant message", async () => {
    const firstToolCallId = createToolCallId();
    const secondToolCallId = createToolCallId();
    const provider = invokeProvider(async () => ({
      message: {
        role: "assistant",
        toolCalls: [
          { id: firstToolCallId, name: "slow", args: {} },
          { id: secondToolCallId, name: "never", args: {} },
        ],
      },
      stopReason: "tool_calls",
    }));
    const gate = deferred<void>();
    const checkpoints: RuntimeCheckpoint[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "slow",
      description: "slow tool",
      async execute() {
        await gate.promise;
        return { ok: true, data: "slow done" };
      },
    });
    tools.register({
      name: "never",
      description: "never runs",
      async execute() {
        return { ok: true, data: "never" };
      },
    });
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const pending = new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "batch" }],
      tools,
      signal: controller.signal,
      onRuntimeEvent: (event) => events.push(event),
      async checkpoint(payload) {
        checkpoints.push(payload);
      },
    });

    await settleAsyncWork(() => events.some((event) => event.type === "tool.started"));
    controller.abort();
    gate.resolve();
    const result = await pending;

    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "awaiting_tools",
      "cancelled",
    ]);
    const cancelledCheckpoint = checkpoints.at(-1) as RuntimeCheckpoint & { phase: "cancelled" };
    expect(cancelledCheckpoint.pendingToolCalls).toEqual([]);
    expect(cancelledCheckpoint.newMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: "[Assistant reply cancelled.]",
    });
    expect(result.newMessages.at(-1)).toEqual(cancelledCheckpoint.newMessages.at(-1));
  });

  // 取消并不跳过 checkpoint 持久化；cancelled checkpoint 保存失败时数据完整性优先于取消。
  it("returns failed when the cancelled checkpoint persistence fails", async () => {
    const toolCallId = createToolCallId();
    const provider = invokeProvider(async () => ({
      message: {
        role: "assistant",
        toolCalls: [{ id: toolCallId, name: "slow", args: {} }],
      },
      stopReason: "tool_calls",
    }));
    const gate = deferred<void>();
    const tools = new ToolRegistry();
    tools.register({
      name: "slow",
      description: "slow tool",
      async execute() {
        await gate.promise;
        return { ok: true, data: "slow done" };
      },
    });
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const pending = new AgentRunner(provider).run({
      turnId: createTurnId(),
      messages: [{ id: createMessageId(), role: "user", content: "batch" }],
      tools,
      signal: controller.signal,
      onRuntimeEvent: (event) => events.push(event),
      async checkpoint() {
        throw new Error("checkpoint storage unavailable");
      },
    });

    await settleAsyncWork(() => events.some((event) => event.type === "tool.started"));
    controller.abort();
    gate.resolve();
    const result = await pending;

    expect(result.stopReason).toBe("failed");
    expect(result.error?.message).toContain("checkpoint storage unavailable");
  });
});
