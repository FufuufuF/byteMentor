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
const CHECKPOINT_PERSISTENCE_FAILURE_TOOL_ERROR =
  "Error: Tool execution skipped because checkpoint persistence failed.";

export interface AgentRunnerInput {
  turnId: TurnId;
  messages: Message[];
  tools: ToolRegistry;
  maxIterations?: number;
  onStreamEvent?: (event: ProviderStreamEvent) => void;
  checkpoint?: (payload: RuntimeCheckpoint) => Promise<void>;
}

export interface AgentRunnerResult {
  newMessages: Message[];
  stopReason: StopReason;
  events: RuntimeEvent[];
  error?: { message: string };
}

export class AgentRunner {
  constructor(private readonly provider: ModelProvider) {}

  async run(input: AgentRunnerInput): Promise<AgentRunnerResult> {
    const workingMessages = [...input.messages];
    const newMessages: Message[] = [];
    const events: RuntimeEvent[] = [];
    const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const toolDefinitions = input.tools.list();
      events.push({
        type: "model.requested",
        turnId: input.turnId,
        ts: Date.now(),
        messageCount: workingMessages.length,
        toolCount: toolDefinitions.length,
      });
      const providerResult = await this.invokeProvider({
        messages: workingMessages,
        tools: toolDefinitions,
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
      events.push({
        type: "model.responded",
        turnId: input.turnId,
        ts: Date.now(),
        messageId: assistantMessage.id,
        stopReason: response.stopReason,
      });

      if (!hasToolCalls(assistantMessage)) {
        if (response.stopReason === "completed") {
          for (const event of providerResult.contentDeltas) {
            input.onStreamEvent?.(event);
          }
        }
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

      for (const toolCall of assistantMessage.toolCalls) {
        if (toolCall.argsParseError !== undefined) {
          const toolMessage: ToolMessage = {
            id: createMessageId(),
            role: "tool",
            toolCallId: toolCall.id,
            content: toolCallArgsParseErrorContent(toolCall),
          };
          workingMessages.push(toolMessage);
          newMessages.push(toolMessage);
          continue;
        }
        events.push({
          type: "tool.started",
          turnId: input.turnId,
          ts: Date.now(),
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });
        const toolResult = await input.tools.execute(toolCall.name, toolCall.args);
        events.push(
          toolResult.ok
            ? {
                type: "tool.completed",
                turnId: input.turnId,
                ts: Date.now(),
                toolCallId: toolCall.id,
                result: toolResult.result,
              }
            : {
                type: "tool.failed",
                turnId: input.turnId,
                ts: Date.now(),
                toolCallId: toolCall.id,
                message: toolResult.error.message,
              },
        );
        const toolMessage: ToolMessage = {
          id: createMessageId(),
          role: "tool",
          toolCallId: toolCall.id,
          content: toolResult.ok ? toolResult.result : toolResult.error.message,
        };
        workingMessages.push(toolMessage);
        newMessages.push(toolMessage);
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

  private async invokeProvider(input: {
    messages: Message[];
    tools: ReturnType<ToolRegistry["list"]>;
  }): Promise<
    | {
        ok: true;
        response: ProviderResponse;
        contentDeltas: Array<Extract<ProviderStreamEvent, { type: "content_delta" }>>;
      }
    | { ok: false; message: string }
  > {
    try {
      let done: Extract<ProviderStreamEvent, { type: "done" }> | undefined;
      const contentDeltas: Array<Extract<ProviderStreamEvent, { type: "content_delta" }>> = [];
      for await (const event of this.provider.invokeStream(input)) {
        if (event.type === "content_delta") {
          contentDeltas.push(event);
        } else {
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
        contentDeltas,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
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
