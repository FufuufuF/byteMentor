import { describe, expect, it } from "vitest";
import { OpenAIChatProvider } from "@byte-mentor/agent";
import type { ProviderResponse, ProviderStreamEvent } from "@byte-mentor/agent";

interface FakeChunkDeltaToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface FakeChunk {
  choices: [
    {
      delta: {
        role?: "assistant";
        content?: string | null;
        tool_calls?: FakeChunkDeltaToolCall[];
      };
      finish_reason: string | null;
    },
  ];
}

interface FakeOpenAIClient {
  chat: {
    completions: {
      create(req: unknown): AsyncIterable<FakeChunk>;
    };
  };
}

function createStreamingClient(chunks: FakeChunk[]): {
  client: FakeOpenAIClient;
  requests: unknown[];
} {
  const requests: unknown[] = [];
  return {
    requests,
    client: {
      chat: {
        completions: {
          async *create(req) {
            requests.push(req);
            yield* chunks;
          },
        },
      },
    },
  };
}

function chunk(delta: FakeChunk["choices"][0]["delta"], finishReason: string | null): FakeChunk {
  return {
    choices: [{ delta, finish_reason: finishReason }],
  };
}

function createProvider(client: FakeOpenAIClient): OpenAIChatProvider {
  return new OpenAIChatProvider({
    model: "gpt-test",
    client: client as never,
  });
}

async function collectStream(provider: OpenAIChatProvider): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.invokeStream({
    messages: [{ role: "user", content: "hello" }],
  })) {
    events.push(event);
  }
  return events;
}

describe("OpenAIChatProvider.invokeStream", () => {
  // 验证文本流式输出：OpenAI content delta 会逐段产出 content_delta，
  // 最后 done 事件会携带拼接完成的 assistant message。
  it("streams content deltas and a final done event", async () => {
    const { client, requests } = createStreamingClient([
      chunk({ role: "assistant", content: "hello " }, null),
      chunk({ content: "world" }, null),
      chunk({}, "stop"),
    ]);
    const provider = createProvider(client);

    const events = await collectStream(provider);

    expect(requests[0]).toMatchObject({ model: "gpt-test", stream: true });
    expect(events).toEqual([
      { type: "content_delta", text: "hello " },
      { type: "content_delta", text: "world" },
      {
        type: "done",
        message: { role: "assistant", content: "hello world" },
        stopReason: "completed",
      },
    ]);
  });

  // 验证非流式 invoke 是 invokeStream 的折叠包装：
  // 手动消费 stream 得到的 done 结果应与 invoke() 返回值一致。
  it("folds invoke from invokeStream", async () => {
    const chunks = [
      chunk({ role: "assistant", content: "hello " }, null),
      chunk({ content: "world" }, null),
      chunk({}, "stop"),
    ];
    const streamProvider = createProvider(createStreamingClient([...chunks]).client);
    const invokeProvider = createProvider(createStreamingClient([...chunks]).client);

    const streamEvents = await collectStream(streamProvider);
    const done = streamEvents.at(-1) as Extract<ProviderStreamEvent, { type: "done" }>;
    const result = await invokeProvider.invoke({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result).toEqual({
      message: done.message,
      stopReason: done.stopReason,
    } satisfies ProviderResponse);
  });

  // 验证 tool_call delta 累加：arguments 可以跨多个 chunk 到达，
  // provider 需要在 done 时一次性 JSON.parse 成内部 ToolCall.args。
  it("accumulates streamed tool call arguments before done", async () => {
    const { client } = createStreamingClient([
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_search",
              type: "function",
              function: { name: "search", arguments: '{"query"' },
            },
          ],
        },
        null,
      ),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ':"docs"}' } }] }, "tool_calls"),
    ]);
    const provider = createProvider(client);

    const events = await collectStream(provider);

    expect(events).toEqual([
      {
        type: "done",
        message: {
          role: "assistant",
          toolCalls: [{ id: "call_search", name: "search", args: { query: "docs" } }],
        },
        stopReason: "tool_calls",
      },
    ]);
  });

  // 验证同一轮多个 tool_call 以 OpenAI delta index 分别累加，
  // 最终内部 toolCalls 按 index 从小到大稳定输出。
  it("accumulates multiple streamed tool calls by index", async () => {
    const { client } = createStreamingClient([
      chunk(
        {
          tool_calls: [
            {
              index: 1,
              id: "call_read",
              type: "function",
              function: { name: "read", arguments: '{"id"' },
            },
            {
              index: 0,
              id: "call_search",
              type: "function",
              function: { name: "search", arguments: '{"query"' },
            },
          ],
        },
        null,
      ),
      chunk(
        {
          tool_calls: [
            { index: 1, function: { arguments: ":42}" } },
            { index: 0, function: { arguments: ':"docs"}' } },
          ],
        },
        "tool_calls",
      ),
    ]);
    const provider = createProvider(client);

    const events = await collectStream(provider);

    expect(events.at(-1)).toEqual({
      type: "done",
      message: {
        role: "assistant",
        toolCalls: [
          { id: "call_search", name: "search", args: { query: "docs" } },
          { id: "call_read", name: "read", args: { id: 42 } },
        ],
      },
      stopReason: "tool_calls",
    });
  });

  // 验证流式 tool arguments 拼接完成后 JSON.parse 失败时，
  // 不抛错，而是在 ToolCall 上带 argsParseError 和 raw arguments。
  it("preserves streamed tool argument parse errors", async () => {
    const { client } = createStreamingClient([
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_bad",
              type: "function",
              function: { name: "search", arguments: "{bad" },
            },
          ],
        },
        "tool_calls",
      ),
    ]);
    const provider = createProvider(client);

    const events = await collectStream(provider);

    expect(events.at(-1)).toEqual({
      type: "done",
      message: {
        role: "assistant",
        toolCalls: [
          {
            id: "call_bad",
            name: "search",
            args: "{bad",
            argsParseError: expect.any(String) as string,
          },
        ],
      },
      stopReason: "tool_calls",
    });
  });
});
