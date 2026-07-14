import OpenAI from "openai";
import type {
  AssistantMessage,
  Message,
  StopReason,
  ToolCall,
  ToolCallId,
} from "@byte-mentor/core";
import type { ModelProvider, ProviderRequest, ProviderResponse, ToolDefinition } from "./provider.js";

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

  async invoke(req: ProviderRequest): Promise<ProviderResponse> {
    const request: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: req.messages.map(toOpenAIMessage),
      ...toolsRequestPart(req.tools),
    };
    const completion = await this.client.chat.completions.create(request);
    const choice = completion.choices[0];
    if (choice === undefined) {
      throw new Error("OpenAI chat completion did not include choices");
    }
    return {
      message: toAssistantMessage(choice.message),
      stopReason: toStopReason(choice.finish_reason),
    };
  }
}

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

function toolsRequestPart(
  tools: ToolDefinition[] | undefined,
): { tools?: OpenAI.ChatCompletionTool[] } {
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

function toAssistantMessage(message: OpenAI.ChatCompletionMessage): AssistantMessage {
  const toolCalls = message.tool_calls?.map(toToolCall);
  if (hasTextContent(message.content)) {
    return {
      role: "assistant",
      content: message.content,
      ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
  if (toolCalls !== undefined && toolCalls.length > 0) {
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

function toToolCall(toolCall: OpenAI.ChatCompletionMessageToolCall): ToolCall {
  if (toolCall.type !== "function") {
    throw new Error(`Unsupported OpenAI tool call type: ${toolCall.type}`);
  }
  const argsResult = parseToolArguments(toolCall.function.arguments);
  return {
    id: toolCall.id as ToolCallId,
    name: toolCall.function.name,
    args: argsResult.args,
    ...(argsResult.argsParseError !== undefined
      ? { argsParseError: argsResult.argsParseError }
      : {}),
  };
}

function parseToolArguments(rawArguments: string):
  | { args: unknown; argsParseError?: undefined }
  | { args: string; argsParseError: string } {
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
