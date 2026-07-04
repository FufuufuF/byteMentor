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
import type { ModelProvider } from "./provider.js";
import type { ToolRegistry } from "./tool-registry.js";

const DEFAULT_MAX_ITERATIONS = 10;

export interface AgentRunnerInput {
  turnId: TurnId;
  messages: Message[];
  tools: ToolRegistry;
  maxIterations?: number;
}

export interface AgentRunnerResult {
  newMessages: Message[];
  stopReason: StopReason;
  events: RuntimeEvent[];
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
      const response = await this.provider.invoke({
        messages: workingMessages,
        tools: toolDefinitions,
      });
      const assistantMessage = withMessageId(response.message);
      events.push({
        type: "model.responded",
        turnId: input.turnId,
        ts: Date.now(),
        messageId: assistantMessage.id,
        stopReason: response.stopReason,
      });

      if (!hasToolCalls(assistantMessage)) {
        newMessages.push(assistantMessage);
        return {
          newMessages,
          stopReason: response.stopReason,
          events,
        };
      }

      workingMessages.push(assistantMessage);
      newMessages.push(assistantMessage);

      for (const toolCall of assistantMessage.toolCalls) {
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
    }

    return {
      newMessages,
      stopReason: "max_iterations",
      events,
    };
  }
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
