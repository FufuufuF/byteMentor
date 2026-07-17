import { describe, expect, it } from "vitest";
import { createToolCallId } from "@byte-mentor/core";
import { AgentLoop, AgentRunner, ContextBuilder } from "@byte-mentor/agent";
import type {
  AgentTool,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
} from "@byte-mentor/agent";
import { InMemorySessionStore } from "@byte-mentor/session";

function invokeProvider(
  invoke: (req: ProviderRequest) => Promise<ProviderResponse>,
): ModelProvider {
  return {
    async invoke(req) {
      return invoke(req);
    },
    async *invokeStream(req) {
      const response = await invoke(req);
      if (response.message.content !== undefined && response.message.content.length > 0) {
        yield { type: "content_delta", text: response.message.content };
      }
      yield {
        type: "done",
        message: response.message,
        stopReason: response.stopReason,
      };
    },
  };
}

describe("headless turn public API integration", () => {
  it("runs a tool-using headless turn through public package exports", async () => {
    const toolCallId = createToolCallId();
    const providerRequests: unknown[] = [];
    const provider = invokeProvider(async (req) => {
      providerRequests.push({
        messages: req.messages,
        tools: req.tools,
      });
      if (req.messages.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: toolCallId,
                name: "lookup",
                args: { query: "public api" },
              },
            ],
          },
          stopReason: "tool_calls",
        };
      }
      return {
        message: {
          role: "assistant",
          content: "The public API turn completed.",
        },
        stopReason: "completed",
      };
    });
    const lookupTool: AgentTool = {
      name: "lookup",
      description: "lookup docs",
      parametersJsonSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      async execute(args) {
        const a = args as { query: string };
        return { ok: true, result: `docs:${a.query}` };
      },
    };
    const sessionStore = new InMemorySessionStore();
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: new AgentRunner(provider),
    });
    loop.tools.register(lookupTool);

    const result = await loop.runTurn({ userMessage: "Use lookup once." });

    const history = await sessionStore.getHistory(result.sessionId);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      throw new Error(`expected completed result, got ${result.status}`);
    }
    expect(result.stopReason).toBe("completed");
    expect(result.finalMessage).toMatchObject({
      role: "assistant",
      content: "The public API turn completed.",
    });
    expect(result.newMessages).toEqual(history);
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(history[1]).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "public api" } }],
    });
    expect(history[2]).toMatchObject({
      role: "tool",
      toolCallId,
      content: "docs:public api",
    });
    expect(result.events.map((event) => event.type)).toEqual([
      "turn.started",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.started",
      "tool.completed",
      "model.requested",
      "model.responded",
      "turn.completed",
    ]);
    expect(providerRequests).toHaveLength(2);
  });
});
