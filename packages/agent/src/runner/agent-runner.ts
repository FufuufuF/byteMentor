import { createMessageId } from "@byte-mentor/core";
import type {
  AssistantMessage,
  Message,
  MessageId,
  RuntimeEvent,
  StopReason,
  ToolCall,
  ToolMessage,
  TurnId,
} from "@byte-mentor/core";
import type {
  ModelProvider,
  ProviderResponse,
  ProviderStreamEvent,
} from "../providers/provider.js";
import type { RuntimeCheckpoint } from "../loop/runtime-checkpoint.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 4;
const TOOL_RESULT_PREVIEW_CHARACTERS = 500;
const CHECKPOINT_PERSISTENCE_FAILURE_TOOL_ERROR =
  "Error: Tool execution skipped because checkpoint persistence failed.";

export interface AgentRunnerOptions {
  maxConcurrentToolCalls?: number;
}

export interface AgentRunnerInput {
  turnId: TurnId;
  messages: Message[];
  tools: ToolRegistry;
  maxIterations?: number;
  onStreamEvent?: (event: ProviderStreamEvent) => void;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  checkpoint?: (payload: RuntimeCheckpoint) => Promise<void>;
}

export interface AgentRunnerResult {
  newMessages: Message[];
  stopReason: StopReason;
  events: RuntimeEvent[];
  error?: { message: string };
}

interface ToolCallExecution {
  toolMessage: ToolMessage;
}

export class AgentRunner {
  private readonly provider: ModelProvider;
  private readonly maxConcurrentToolCalls: number;

  // 保存模型 Provider 和工具调用并发上限，并在启动时拒绝无效的 Runtime 配置。
  constructor(provider: ModelProvider, options: AgentRunnerOptions = {}) {
    const maxConcurrentToolCalls =
      options.maxConcurrentToolCalls ?? DEFAULT_MAX_CONCURRENT_TOOL_CALLS;
    if (!Number.isInteger(maxConcurrentToolCalls) || maxConcurrentToolCalls <= 0) {
      throw new Error("maxConcurrentToolCalls must be a positive integer");
    }
    this.provider = provider;
    this.maxConcurrentToolCalls = maxConcurrentToolCalls;
  }

  // 执行当前 turn 的模型与工具循环，记录运行事件，并返回本轮新产生的消息。
  async run(input: AgentRunnerInput): Promise<AgentRunnerResult> {
    const workingMessages = [...input.messages];
    const newMessages: Message[] = [];
    const events: RuntimeEvent[] = [];
    const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const toolDefinitions = input.tools.list();
      emitRuntimeEvent(events, input.onRuntimeEvent, {
        type: "model.requested",
        turnId: input.turnId,
        ts: Date.now(),
        messageCount: workingMessages.length,
        toolCount: toolDefinitions.length,
      });
      const providerResult = await this.invokeProvider({
        messages: workingMessages,
        tools: toolDefinitions,
        onStreamEvent: input.onStreamEvent,
      });
      if (!providerResult.ok) {
        return {
          newMessages,
          stopReason: "failed",
          events,
          error: { message: providerResult.message },
        };
      }
      const response = providerResult.response;
      const assistantMessage = withMessageId(response.message);
      emitRuntimeEvent(events, input.onRuntimeEvent, {
        type: "model.responded",
        turnId: input.turnId,
        ts: Date.now(),
        messageId: assistantMessage.id,
        stopReason: response.stopReason,
      });

      if (!hasToolCalls(assistantMessage)) {
        newMessages.push(assistantMessage);
        if (response.stopReason === "completed") {
          const checkpointError = await emitCheckpoint(input.checkpoint, {
            phase: "final_response",
            iteration,
            newMessages: [...newMessages],
            pendingToolCalls: [],
          });
          if (checkpointError !== undefined) {
            return checkpointFailed(newMessages, events, checkpointError);
          }
        }
        return {
          newMessages,
          stopReason: response.stopReason,
          events,
        };
      }

      // 处理工具调用
      workingMessages.push(assistantMessage);
      newMessages.push(assistantMessage);
      const awaitingToolsError = await emitCheckpoint(input.checkpoint, {
        phase: "awaiting_tools",
        iteration,
        newMessages: [...newMessages],
        pendingToolCalls: assistantMessage.toolCalls,
      });
      if (awaitingToolsError !== undefined) {
        newMessages.push(
          ...assistantMessage.toolCalls.map<ToolMessage>((toolCall) => ({
            id: createMessageId(),
            role: "tool",
            toolCallId: toolCall.id,
            content: CHECKPOINT_PERSISTENCE_FAILURE_TOOL_ERROR,
          })),
        );
        return checkpointFailed(newMessages, events, awaitingToolsError);
      }

      const toolExecutions = await this.executeToolCallBatch(
        input,
        assistantMessage.toolCalls,
        events,
      );
      for (const execution of toolExecutions) {
        workingMessages.push(execution.toolMessage);
        newMessages.push(execution.toolMessage);
      }
      const toolsCompletedError = await emitCheckpoint(input.checkpoint, {
        phase: "tools_completed",
        iteration,
        newMessages: [...newMessages],
        pendingToolCalls: [],
      });
      if (toolsCompletedError !== undefined) {
        return checkpointFailed(newMessages, events, toolsCompletedError);
      }
    }

    return {
      newMessages,
      stopReason: "max_iterations",
      events,
    };
  }

  // 仅在整批调用都可解析且明确声明 safe 时使用有界并发，否则按原顺序逐个执行。
  private async executeToolCallBatch(
    input: AgentRunnerInput,
    toolCalls: ToolCall[],
    events: RuntimeEvent[],
  ): Promise<ToolCallExecution[]> {
    const canRunConcurrently = toolCalls.every(
      (toolCall) =>
        toolCall.argsParseError === undefined &&
        input.tools.getConcurrency(toolCall.name) === "safe",
    );
    if (!canRunConcurrently) {
      const executions: ToolCallExecution[] = [];
      for (const toolCall of toolCalls) {
        executions.push(await this.executeToolCall(input, toolCall, events));
      }
      return executions;
    }

    return mapWithConcurrency(toolCalls, this.maxConcurrentToolCalls, (toolCall) =>
      this.executeToolCall(input, toolCall, events),
    );
  }

  // 执行单个调用并生成对应 ToolMessage 与有界观测事件；参数解析失败不会进入 Registry。
  private async executeToolCall(
    input: AgentRunnerInput,
    toolCall: ToolCall,
    events: RuntimeEvent[],
  ): Promise<ToolCallExecution> {
    if (toolCall.argsParseError !== undefined) {
      return {
        toolMessage: {
          id: createMessageId(),
          role: "tool",
          toolCallId: toolCall.id,
          content: toolCallArgsParseErrorContent(toolCall),
        },
      };
    }

    const startedAt = Date.now();
    const startedEvent: RuntimeEvent = {
      type: "tool.started",
      turnId: input.turnId,
      ts: startedAt,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    };
    emitRuntimeEvent(events, input.onRuntimeEvent, startedEvent);
    const toolOutput = await input.tools.execute(toolCall.name, toolCall.args);
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    const terminalEvent: RuntimeEvent = toolOutput.result.ok
      ? {
          type: "tool.completed",
          turnId: input.turnId,
          ts: completedAt,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          durationMs,
          outputCharacters: toolOutput.content.length,
          resultPreview: [...toolOutput.content].slice(0, TOOL_RESULT_PREVIEW_CHARACTERS).join(""),
          resultPreviewTruncated: [...toolOutput.content].length > TOOL_RESULT_PREVIEW_CHARACTERS,
        }
      : {
          type: "tool.failed",
          turnId: input.turnId,
          ts: completedAt,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          durationMs,
          errorCode: toolOutput.result.error.code,
          message: toolOutput.result.error.message,
        };
    emitRuntimeEvent(events, input.onRuntimeEvent, terminalEvent);
    return {
      toolMessage: {
        id: createMessageId(),
        role: "tool",
        toolCallId: toolCall.id,
        content: toolOutput.content,
      },
    };
  }

  // Consumes one provider iteration, forwarding each yielded event before requesting the next one.
  private async invokeProvider(input: {
    messages: Message[];
    tools: ReturnType<ToolRegistry["list"]>;
    onStreamEvent?: (event: ProviderStreamEvent) => void;
  }): Promise<
    | {
        ok: true;
        response: ProviderResponse;
      }
    | { ok: false; message: string }
  > {
    try {
      let done: Extract<ProviderStreamEvent, { type: "done" }> | undefined;
      for await (const event of this.provider.invokeStream(input)) {
        try {
          input.onStreamEvent?.(event);
        } catch (cause) {
          throw new StreamObserverError(cause);
        }
        if (event.type === "done") {
          done = event;
        }
      }
      if (done === undefined) {
        throw new Error("provider stream did not include a done event");
      }
      return {
        ok: true,
        response: {
          message: done.message,
          stopReason: done.stopReason,
        },
      };
    } catch (e) {
      if (e instanceof StreamObserverError) {
        throw e.observerCause;
      }
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}

// Records a runtime event before synchronously notifying observers at the exact occurrence point.
function emitRuntimeEvent(
  events: RuntimeEvent[],
  observer: AgentRunnerInput["onRuntimeEvent"],
  event: RuntimeEvent,
): void {
  events.push(event);
  observer?.(event);
}

class StreamObserverError extends Error {
  // Preserves a callback failure so provider error folding cannot consume application-layer errors.
  constructor(readonly observerCause: unknown) {
    super("stream observer failed");
  }
}

// 使用固定数量的 worker 消费输入，确保 mapper 从开始到完成的并发数不超过显式上限。
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function emitCheckpoint(
  checkpoint: AgentRunnerInput["checkpoint"],
  payload: RuntimeCheckpoint,
): Promise<string | undefined> {
  if (checkpoint === undefined) {
    return undefined;
  }
  try {
    await checkpoint(payload);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkpointFailed(
  newMessages: Message[],
  events: RuntimeEvent[],
  message: string,
): AgentRunnerResult {
  return {
    newMessages,
    stopReason: "failed",
    events,
    error: { message },
  };
}

function withMessageId(message: AssistantMessage): AssistantMessage & { id: MessageId } {
  return {
    ...message,
    id: message.id ?? createMessageId(),
  };
}

function hasToolCalls(
  message: AssistantMessage,
): message is AssistantMessage & { toolCalls: [ToolCall, ...ToolCall[]] } {
  return message.toolCalls !== undefined && message.toolCalls.length > 0;
}

function toolCallArgsParseErrorContent(toolCall: ToolCall): string {
  return [
    `Tool call arguments could not be parsed for "${toolCall.name}".`,
    `Error: ${toolCall.argsParseError}`,
    `Raw arguments: ${String(toolCall.args)}`,
    "Retry this tool call with arguments that match the tool schema.",
  ].join("\n");
}
