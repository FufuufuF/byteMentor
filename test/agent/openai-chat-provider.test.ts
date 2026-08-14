import { describe, expect, it } from "vitest";
import { OpenAIChatProvider } from "@byte-mentor/agent";
import type { ToolDefinition } from "@byte-mentor/agent";
import type { Message, ToolCallId } from "@byte-mentor/core";

interface FakeOpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface FakeOpenAIMessage {
  role?: "assistant";
  content?: string | null;
  tool_calls?: FakeOpenAIToolCall[];
}

interface FakeOpenAICompletion {
  choices: [
    {
      message: FakeOpenAIMessage;
      finish_reason: string | null;
    },
  ];
}

interface FakeOpenAIChunk {
  choices: [
    {
      delta: FakeOpenAIMessage & { tool_calls?: Array<FakeOpenAIToolCall & { index: number }> };
      finish_reason: string | null;
    },
  ];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens: number };
  };
}

interface FakeCreateRequest {
  model: string;
  messages: unknown[];
  stream?: true;
  tools?: unknown[];
}

interface FakeOpenAIClient {
  chat: {
    completions: {
      create(req: FakeCreateRequest): AsyncIterable<FakeOpenAIChunk>;
    };
  };
}

function createFakeClient(responses: Array<FakeOpenAICompletion | Error>): {
  client: FakeOpenAIClient;
  requests: FakeCreateRequest[];
} {
  const requests: FakeCreateRequest[] = [];
  return {
    requests,
    client: {
      chat: {
        completions: {
          async *create(req) {
            requests.push(req);
            const response = responses.shift();
            if (response === undefined) {
              throw new Error("fake client response exhausted");
            }
            if (response instanceof Error) {
              throw response;
            }
            const choice = response.choices[0];
            const { tool_calls: toolCalls, ...messageDelta } = choice.message;
            const delta: FakeOpenAIChunk["choices"][0]["delta"] = {
              ...messageDelta,
              ...(toolCalls !== undefined
                ? {
                    tool_calls: toolCalls.map((toolCall, index) => ({
                      ...toolCall,
                      index,
                    })),
                  }
                : {}),
            };
            yield {
              choices: [
                {
                  delta,
                  finish_reason: choice.finish_reason,
                },
              ],
            };
          },
        },
      },
    },
  };
}

function completion(message: FakeOpenAIMessage, finishReason: string): FakeOpenAICompletion {
  return {
    choices: [
      {
        message,
        finish_reason: finishReason,
      },
    ],
  };
}

function createProvider(client: FakeOpenAIClient): OpenAIChatProvider {
  return new OpenAIChatProvider({
    model: "gpt-test",
    client: client as never,
  });
}

describe("OpenAIChatProvider.invoke", () => {
  // 验证最普通的文本回复映射：内部 user message 会传给 OpenAI，请求里会带 model，
  // OpenAI 的 stop + content 会转成内部 completed assistant response。
  it("maps a text completion to a completed assistant response", async () => {
    const { client, requests } = createFakeClient([
      completion({ role: "assistant", content: "Hello from OpenAI" }, "stop"),
    ]);
    const provider = createProvider(client);

    const result = await provider.invoke({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(requests).toEqual([
      {
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    ]);
    expect(result).toEqual({
      message: { role: "assistant", content: "Hello from OpenAI" },
      stopReason: "completed",
    });
  });

  // 验证工具定义和工具调用的双向映射：内部 ToolDefinition 会包装成 OpenAI function tool，
  // OpenAI 返回的多个 tool_calls 会按顺序 parse 成内部 ToolCall[]。
  it("maps tool definitions and tool call responses", async () => {
    const { client, requests } = createFakeClient([
      completion(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_search",
              type: "function",
              function: { name: "search", arguments: '{"query":"docs"}' },
            },
            {
              id: "call_read",
              type: "function",
              function: { name: "read", arguments: '{"id":42}' },
            },
          ],
        },
        "tool_calls",
      ),
    ]);
    const tools: ToolDefinition[] = [
      {
        name: "search",
        description: "Search docs",
        parametersJsonSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ];
    const provider = createProvider(client);

    const result = await provider.invoke({
      messages: [{ role: "user", content: "find docs" }],
      tools,
    });

    expect(requests[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search",
          description: "Search docs",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ]);
    expect(result.stopReason).toBe("tool_calls");
    expect(result.message).toEqual({
      role: "assistant",
      toolCalls: [
        { id: "call_search", name: "search", args: { query: "docs" } },
        { id: "call_read", name: "read", args: { id: 42 } },
      ],
    });
  });

  // 验证 provider 层 JSON.parse 失败时不抛错：保留 raw arguments 到 args，
  // 并把解析错误放到 ToolCall.argsParseError，交给 AgentRunner 生成修复提示。
  it("preserves malformed tool call arguments as argsParseError", async () => {
    const { client } = createFakeClient([
      completion(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_bad",
              type: "function",
              function: { name: "search", arguments: "{bad-json" },
            },
          ],
        },
        "tool_calls",
      ),
    ]);
    const provider = createProvider(client);

    const result = await provider.invoke({
      messages: [{ role: "user", content: "find docs" }],
    });

    expect(result.stopReason).toBe("tool_calls");
    expect(result.message.toolCalls).toEqual([
      {
        id: "call_bad",
        name: "search",
        args: "{bad-json",
        argsParseError: expect.any(String) as string,
      },
    ]);
  });

  // 验证 OpenAI 的非成功 finish_reason 会映射为内部 failed，
  // 但仍保留 assistant message，方便上层 runner 统一处理失败结果。
  it("maps failed finish reasons to failed provider responses", async () => {
    for (const finishReason of ["length", "content_filter", "unknown_reason"]) {
      const { client } = createFakeClient([
        completion({ role: "assistant", content: "partial" }, finishReason),
      ]);
      const provider = createProvider(client);

      const result = await provider.invoke({
        messages: [{ role: "user", content: "hello" }],
      });

      expect(result.stopReason).toBe("failed");
      expect(result.message).toEqual({ role: "assistant", content: "partial" });
    }
  });

  // 验证 OpenAI 返回既没有文本也没有工具调用时属于受控失败，
  // provider 直接抛错，后续由 AgentRunner 捕获为 failed turn。
  it("throws when OpenAI returns neither content nor tool calls", async () => {
    const { client } = createFakeClient([completion({ role: "assistant", content: null }, "stop")]);
    const provider = createProvider(client);

    await expect(
      provider.invoke({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toThrow(/assistant/i);
  });

  // 验证请求方向的历史消息映射：内部 assistant.toolCalls 要转成 OpenAI tool_calls，
  // 内部 tool message 要带 tool_call_id，供 Chat Completions 接续工具结果。
  it("maps internal assistant and tool messages to OpenAI chat messages", async () => {
    const { client, requests } = createFakeClient([
      completion({ role: "assistant", content: "done" }, "stop"),
    ]);
    const toolCallId = "call_lookup" as ToolCallId;
    const messages: Message[] = [
      { role: "user", content: "find docs" },
      {
        role: "assistant",
        content: "calling lookup",
        toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "docs" } }],
      },
      { role: "tool", toolCallId, content: "result:docs" },
    ];
    const provider = createProvider(client);

    await provider.invoke({ messages });

    expect(requests[0]?.messages).toEqual([
      { role: "user", content: "find docs" },
      {
        role: "assistant",
        content: "calling lookup",
        tool_calls: [
          {
            id: "call_lookup",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"docs"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_lookup", content: "result:docs" },
    ]);
  });

  // 验证没有可用工具时省略 tools 字段，而不是传空数组，
  // 避免真实 OpenAI API 收到无意义 tools 配置。
  it("omits tools when no tool definitions are available", async () => {
    const { client, requests } = createFakeClient([
      completion({ role: "assistant", content: "done" }, "stop"),
    ]);
    const provider = createProvider(client);

    await provider.invoke({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(requests[0]).not.toHaveProperty("tools");
  });

  // 验证工具没有 parametersJsonSchema 时省略 function.parameters，
  // 只发送 name 和 description。
  it("omits function parameters when parametersJsonSchema is undefined", async () => {
    const { client, requests } = createFakeClient([
      completion({ role: "assistant", content: "done" }, "stop"),
    ]);
    const provider = createProvider(client);

    await provider.invoke({
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "ping", description: "Ping tool" }],
    });

    expect(requests[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "ping",
          description: "Ping tool",
        },
      },
    ]);
  });

  // 验证 SDK/network/API 异常不在 provider 内吞掉或降级，
  // 直接向上抛给 AgentRunner 统一转 failed。
  it("propagates OpenAI SDK errors", async () => {
    const { client } = createFakeClient([new Error("network down")]);
    const provider = createProvider(client);

    await expect(
      provider.invoke({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toThrow("network down");
  });
});

// usage 归一化：流式 usage 读取、cached 扣减、无 usage 时省略。
describe("OpenAIChatProvider usage", () => {
  it("maps streamed usage into the done event with cached input subtracted", async () => {
    const { client } = createFakeClient([
      completion({ role: "assistant", content: "done" }, "stop"),
    ]);
    client.chat.completions.create = attachUsage(client.chat.completions.create, {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 },
    });
    const provider = createProvider(client);

    const events = [];
    for await (const event of provider.invokeStream({
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(event);
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({
      type: "done",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 70, cachedInputTokens: 80 },
    });
  });

  it("omits usage when the stream carries no usage data", async () => {
    const { client } = createFakeClient([
      completion({ role: "assistant", content: "done" }, "stop"),
    ]);
    const provider = createProvider(client);

    const events = [];
    for await (const event of provider.invokeStream({
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(event);
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ type: "done" });
    expect(done).not.toHaveProperty("usage");
  });

  it("returns usage through invoke() as well", async () => {
    const { client } = createFakeClient([
      completion({ role: "assistant", content: "done" }, "stop"),
    ]);
    client.chat.completions.create = attachUsage(client.chat.completions.create, {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
    const provider = createProvider(client);

    const result = await provider.invoke({ messages: [{ role: "user", content: "hi" }] });
    expect(result).toMatchObject({
      stopReason: "completed",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
  });
});

// 测试辅助：包装 fake completions.create，在流末尾追加携带 usage 的 usage chunk。
function attachUsage(
  create: FakeOpenAIClient["chat"]["completions"]["create"],
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens: number };
  },
): FakeOpenAIClient["chat"]["completions"]["create"] {
  return async function* withUsage(req): AsyncGenerator<FakeOpenAIChunk, void, void> {
    for await (const chunk of create(req)) {
      yield chunk;
    }
    yield {
      choices: [] as unknown as FakeOpenAIChunk["choices"],
      usage,
    };
  };
}
