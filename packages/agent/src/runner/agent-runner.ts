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
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from "../providers/provider.js";
import type { RuntimeCheckpoint } from "../loop/runtime-checkpoint.js";
import type { ToolExecutionOutput } from "../tools/contracts.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 4;
const TOOL_RESULT_PREVIEW_CHARACTERS = 500;
const CHECKPOINT_PERSISTENCE_FAILURE_TOOL_ERROR =
  "Error: Tool execution skipped because checkpoint persistence failed.";
const CANCELLED_REPLY_TEXT = "[Assistant reply cancelled.]";
const CANCELLED_TOOL_MESSAGE = "tool call cancelled before it started";

export interface AgentRunnerOptions {
  maxConcurrentToolCalls?: number;
}

export interface AgentRunnerInput {
  turnId: TurnId;
  messages: Message[];
  tools: ToolRegistry;
  maxIterations?: number;
  signal?: AbortSignal;
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
  // 取消是独立终态：请求前检查 signal，Provider 因 signal 中止或批次后被取消时收敛为 cancelled。
  async run(input: AgentRunnerInput): Promise<AgentRunnerResult> {
    const workingMessages = [...input.messages];
    const newMessages: Message[] = [];
    const events: RuntimeEvent[] = [];
    const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (input.signal?.aborted) {
        return this.finishCancelled(input, newMessages, events, iteration);
      }
      const toolDefinitions = input.tools.list();
      emitRuntimeEvent(events, input.onRuntimeEvent, {
        type: "model.requested",
        turnId: input.turnId,
        ts: Date.now(),
        messageCount: workingMessages.length,
        toolCount: toolDefinitions.length,
      });
      const providerResult = await this.invokeProvider(
        {
          messages: workingMessages,
          tools: toolDefinitions,
        },
        input.signal,
        input.onStreamEvent,
      );
      if (!providerResult.ok) {
        if (input.signal?.aborted) {
          return this.finishCancelled(input, newMessages, events, iteration);
        }
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
      if (input.signal?.aborted) {
        return this.finishCancelled(input, newMessages, events, iteration);
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

  // 取消终态：追加固定合成 AssistantMessage，保存 pendingToolCalls 为空的 cancelled checkpoint，
  // 再返回不携带通用 error 的 cancelled 结果；checkpoint 失败时数据完整性优先于取消。
  private async finishCancelled(
    input: AgentRunnerInput,
    newMessages: Message[],
    events: RuntimeEvent[],
    iteration: number,
  ): Promise<AgentRunnerResult> {
    const cancelledMessage: Message = {
      id: createMessageId(),
      role: "assistant",
      content: CANCELLED_REPLY_TEXT,
    };
    const finalMessages = [...newMessages, cancelledMessage];
    const checkpointError = await emitCheckpoint(input.checkpoint, {
      phase: "cancelled",
      iteration,
      newMessages: finalMessages,
      pendingToolCalls: [],
    });
    if (checkpointError !== undefined) {
      return checkpointFailed(newMessages, events, checkpointError);
    }
    return {
      newMessages: finalMessages,
      stopReason: "cancelled",
      events,
    };
  }

  // 仅在整批调用都可解析且明确声明 safe 时使用有界并发，否则按原顺序逐个执行。
  // 取消后串行批次不再启动后续调用，并发批次停止领取新任务，未启动调用统一生成 tool_cancelled。
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

    const results = await mapWithConcurrency(
      toolCalls,
      this.maxConcurrentToolCalls,
      input.signal,
      (toolCall) => this.executeToolCall(input, toolCall, events),
    );
    return toolCalls.map((toolCall, index) => {
      const execution = results[index];
      if (execution !== undefined) {
        return execution;
      }
      return cancelledToolCall(input, toolCall, events);
    });
  }

  // 执行单个调用并生成对应 ToolMessage 与有界观测事件；参数解析失败不会进入 Registry。
  // 已取消且尚未启动的调用直接生成 tool_cancelled，已启动调用等待真实结果并按其裁决事件。
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
    if (input.signal?.aborted) {
      return cancelledToolCall(input, toolCall, events);
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
    const toolOutput = await input.tools.execute(toolCall.name, toolCall.args, {
      signal: input.signal,
    });
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    const terminalEvent = terminalToolEvent(
      input.turnId,
      toolCall,
      toolOutput,
      completedAt,
      durationMs,
    );
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

  // Consumes one provider request while keeping the stream observer outside the provider-facing payload.
  private async invokeProvider(
    request: ProviderRequest,
    signal: AbortSignal | undefined,
    onStreamEvent?: (event: ProviderStreamEvent) => void,
  ): Promise<
    | {
        ok: true;
        response: ProviderResponse;
      }
    | { ok: false; message: string }
  > {
    try {
      let done: Extract<ProviderStreamEvent, { type: "done" }> | undefined;
      for await (const event of this.provider.invokeStream(request, { signal })) {
        try {
          onStreamEvent?.(event);
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

// 为未启动的 Tool Call 生成 tool_cancelled ToolMessage 与 started 为 false 的取消事件。
function cancelledToolCall(
  input: AgentRunnerInput,
  toolCall: ToolCall,
  events: RuntimeEvent[],
): ToolCallExecution {
  emitRuntimeEvent(events, input.onRuntimeEvent, {
    type: "tool.cancelled",
    turnId: input.turnId,
    ts: Date.now(),
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    started: false,
    durationMs: 0,
    errorCode: "tool_cancelled",
    message: CANCELLED_TOOL_MESSAGE,
  });
  return {
    toolMessage: {
      id: createMessageId(),
      role: "tool",
      toolCallId: toolCall.id,
      content: JSON.stringify({
        ok: false,
        error: { code: "tool_cancelled", message: CANCELLED_TOOL_MESSAGE },
      }),
    },
  };
}

// 按真实结果裁决终态事件：成功为 completed，取消错误码为 started 的 cancelled，其他失败为 failed。
function terminalToolEvent(
  turnId: TurnId,
  toolCall: ToolCall,
  toolOutput: ToolExecutionOutput,
  completedAt: number,
  durationMs: number,
): RuntimeEvent {
  if (toolOutput.result.ok) {
    return {
      type: "tool.completed",
      turnId,
      ts: completedAt,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      durationMs,
      outputCharacters: toolOutput.content.length,
      resultPreview: [...toolOutput.content].slice(0, TOOL_RESULT_PREVIEW_CHARACTERS).join(""),
      resultPreviewTruncated: [...toolOutput.content].length > TOOL_RESULT_PREVIEW_CHARACTERS,
    };
  }
  const code = toolOutput.result.error.code;
  if (code === "tool_cancelled" || code === "command_cancelled") {
    return {
      type: "tool.cancelled",
      turnId,
      ts: completedAt,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      started: true,
      durationMs,
      errorCode: code,
      message: toolOutput.result.error.message,
    };
  }
  return {
    type: "tool.failed",
    turnId,
    ts: completedAt,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    durationMs,
    errorCode: code,
    message: toolOutput.result.error.message,
  };
}

class StreamObserverError extends Error {
  // Preserves a callback failure so provider error folding cannot consume application-layer errors.
  constructor(readonly observerCause: unknown) {
    super("stream observer failed");
  }
}

// 使用固定数量的 worker 消费输入，确保 mapper 从开始到完成的并发数不超过显式上限；
// signal 取消后 worker 停止领取新任务，未领取项保持 undefined 交给调用方生成取消结果。
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal | undefined,
  mapper: (item: T) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      if (signal?.aborted) {
        return;
      }
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
