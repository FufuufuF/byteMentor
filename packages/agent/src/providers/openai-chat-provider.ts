import OpenAI from "openai";
import { normalizeUsage } from "@byte-mentor/core";
import type {
  AssistantMessage,
  Message,
  StopReason,
  TokenUsage,
  ToolCall,
  ToolCallId,
} from "@byte-mentor/core";
import type {
  ModelProvider,
  ProviderInvocationOptions,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ToolDefinition,
} from "./provider.js";

export interface OpenAIChatProviderConfig {
  model: string;
  client?: OpenAI;
  apiKey?: string;
  baseURL?: string;
}

export class OpenAIChatProvider implements ModelProvider {
  private readonly model: string;
  private readonly client: OpenAI;

  constructor(config: OpenAIChatProviderConfig) {
    this.model = config.model;
    this.client =
      config.client ??
      new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      });
  }

  async invoke(
    req: ProviderRequest,
    options?: ProviderInvocationOptions,
  ): Promise<ProviderResponse> {
    let done: Extract<ProviderStreamEvent, { type: "done" }> | undefined;
    for await (const event of this.invokeStream(req, options)) {
      if (event.type === "done") {
        done = event;
      }
    }
    if (done === undefined) {
      throw new Error("OpenAI chat completion stream did not include a done event");
    }
    return {
      message: done.message,
      stopReason: done.stopReason,
      ...(done.usage === undefined ? {} : { usage: done.usage }),
    };
  }

  async *invokeStream(
    req: ProviderRequest,
    options?: ProviderInvocationOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    const request: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: req.messages.map(toOpenAIMessage),
      stream: true,
      ...toolsRequestPart(req.tools),
    };
    const stream = await this.client.chat.completions.create(request, {
      signal: options?.signal,
    });
    let content = "";
    const toolCalls = new Map<number, StreamingToolCall>();
    let usage: TokenUsage | undefined;
    let terminalChunk:
      | { content: string; toolCalls: Map<number, StreamingToolCall>; stopReason: StopReason }
      | undefined;

    for await (const chunk of stream) {
      // usage chunk（choices 为空数组）：只携带 usage，不产生内容增量。
      if (chunk.usage !== undefined && chunk.usage !== null) {
        usage = normalizeOpenAIUsage(chunk.usage);
        continue;
      }
      const choice = chunk.choices[0];
      if (choice === undefined) {
        continue;
      }
      const contentDelta = choice.delta.content;
      if (hasTextContent(contentDelta)) {
        content += contentDelta;
        yield { type: "content_delta", text: contentDelta };
      }
      for (const toolCallDelta of choice.delta.tool_calls ?? []) {
        applyToolCallDelta(toolCalls, toolCallDelta);
      }
      // finish_reason 可能出现在普通 chunk（后续还有 usage chunk）也可能在最后；
      // 先记录终止状态，等流结束后统一产出 done，保证 usage 收集完整。
      if (choice.finish_reason !== null) {
        terminalChunk = {
          content,
          toolCalls: new Map(toolCalls),
          stopReason: toStopReason(choice.finish_reason),
        };
      }
    }
    if (terminalChunk === undefined) {
      throw new Error("OpenAI chat completion stream ended without finish_reason");
    }
    yield {
      type: "done",
      message: toStreamedAssistantMessage(terminalChunk.content, terminalChunk.toolCalls),
      stopReason: terminalChunk.stopReason,
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

// 把 OpenAI 上报的 usage 归一化为内部 TokenUsage：total 已含 cached 时扣减，避免重复计入。
function normalizeOpenAIUsage(usage: OpenAI.CompletionUsage): TokenUsage {
  const cachedInputTokens = usage.prompt_tokens_details?.cached_tokens;
  return normalizeUsage({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(cachedInputTokens !== undefined && cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  });
}

interface StreamingToolCall {
  id?: string;
  name?: string;
  argumentsRaw: string;
}

type OpenAIToolCallDelta = NonNullable<
  OpenAI.ChatCompletionChunk.Choice.Delta["tool_calls"]
>[number];

function toOpenAIMessage(message: Message): OpenAI.ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      ...(message.content !== undefined ? { content: message.content } : {}),
      ...(message.toolCalls !== undefined && message.toolCalls.length > 0
        ? { tool_calls: message.toolCalls.map(toOpenAIToolCall) }
        : {}),
    } as OpenAI.ChatCompletionMessageParam;
  }
  return {
    role: message.role,
    content: message.content,
  };
}

function toOpenAIToolCall(toolCall: ToolCall): OpenAI.ChatCompletionMessageFunctionToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.args),
    },
  };
}

function toolsRequestPart(tools: ToolDefinition[] | undefined): {
  tools?: OpenAI.ChatCompletionTool[];
} {
  if (tools === undefined || tools.length === 0) {
    return {};
  }
  return {
    tools: tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        ...(tool.parametersJsonSchema !== undefined
          ? { parameters: tool.parametersJsonSchema as Record<string, unknown> }
          : {}),
      },
    })),
  };
}

function toStreamedAssistantMessage(
  content: string,
  toolCallMap: Map<number, StreamingToolCall>,
): AssistantMessage {
  const toolCalls = [...toolCallMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, toolCall]) => toStreamedToolCall(toolCall));
  if (hasTextContent(content)) {
    return {
      role: "assistant",
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
  if (toolCalls.length > 0) {
    return {
      role: "assistant",
      toolCalls,
    };
  }
  throw new Error("OpenAI assistant message had neither content nor tool calls");
}

function hasTextContent(content: string | null | undefined): content is string {
  return content !== null && content !== undefined && content.length > 0;
}

function applyToolCallDelta(
  toolCalls: Map<number, StreamingToolCall>,
  delta: OpenAIToolCallDelta,
): void {
  if (delta.type !== undefined && delta.type !== "function") {
    throw new Error(`Unsupported OpenAI tool call type: ${delta.type}`);
  }
  const current = toolCalls.get(delta.index) ?? { argumentsRaw: "" };
  if (delta.id !== undefined) {
    current.id = delta.id;
  }
  if (delta.function?.name !== undefined) {
    current.name = delta.function.name;
  }
  if (delta.function?.arguments !== undefined) {
    current.argumentsRaw += delta.function.arguments;
  }
  toolCalls.set(delta.index, current);
}

function toStreamedToolCall(toolCall: StreamingToolCall): ToolCall {
  if (toolCall.id === undefined) {
    throw new Error("OpenAI streamed tool call was missing id");
  }
  if (toolCall.name === undefined) {
    throw new Error("OpenAI streamed tool call was missing function name");
  }
  const argsResult = parseToolArguments(toolCall.argumentsRaw);
  return {
    id: toolCall.id as ToolCallId,
    name: toolCall.name,
    args: argsResult.args,
    ...(argsResult.argsParseError !== undefined
      ? { argsParseError: argsResult.argsParseError }
      : {}),
  };
}

function parseToolArguments(
  rawArguments: string,
): { args: unknown; argsParseError?: undefined } | { args: string; argsParseError: string } {
  try {
    return { args: JSON.parse(rawArguments) as unknown };
  } catch (e) {
    return {
      args: rawArguments,
      argsParseError: e instanceof Error ? e.message : String(e),
    };
  }
}

function toStopReason(finishReason: string | null): StopReason {
  switch (finishReason) {
    case "stop":
      return "completed";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
    case "content_filter":
    default:
      return "failed";
  }
}
