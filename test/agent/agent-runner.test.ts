import { describe, expect, it } from "vitest";
import { createMessageId, createToolCallId, createTurnId } from "@byte-mentor/core";
import type { AssistantMessage, Message, MessageId, ToolMessage } from "@byte-mentor/core";
import { AgentRunner, ToolRegistry } from "@byte-mentor/agent";
import type { ModelProvider } from "@byte-mentor/agent";

describe("AgentRunner.run", () => {
  it("returns final assistant message when provider completes", async () => {
    const inputMessages: Message[] = [
      { id: createMessageId(), role: "user", content: "hello" },
    ];
    const providerRequests: Message[][] = [];
    const provider: ModelProvider = {
      async invoke(req) {
        providerRequests.push(req.messages);
        return {
          message: { role: "assistant", content: "done" },
          stopReason: "completed",
        };
      },
    };

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

  it("executes one tool call before final provider response", async () => {
    const inputMessages: Message[] = [
      { id: createMessageId(), role: "user", content: "find docs" },
    ];
    const toolCallId = createToolCallId();
    const providerRequests: Message[][] = [];
    const provider: ModelProvider = {
      async invoke(req) {
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
      },
    };
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
        return { ok: true, result: `result:${a.query}` };
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
      content: "result:docs",
    });
    expect(finalMessage).toMatchObject({
      role: "assistant",
      content: "found docs",
    });
  });

  it("records model and tool runtime events", async () => {
    const turnId = createTurnId();
    const toolCallId = createToolCallId();
    const provider: ModelProvider = {
      async invoke(req) {
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
      },
    };
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute() {
        return { ok: true, result: "result:docs" };
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
      result: "result:docs",
    });
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

  it("stops with max_iterations when provider keeps requesting tools", async () => {
    const toolCallId = createToolCallId();
    let providerCallCount = 0;
    const provider: ModelProvider = {
      async invoke() {
        providerCallCount += 1;
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: toolCallId, name: "lookup", args: null }],
          },
          stopReason: "tool_calls",
        };
      },
    };
    const tools = new ToolRegistry();
    tools.register({
      name: "lookup",
      description: "lookup docs",
      async execute() {
        return { ok: true, result: "still needs more" };
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
      toolCalls: [{ id: toolCallId, name: "lookup", args: null }],
    });
    expect(result.newMessages[1]).toMatchObject({
      role: "tool",
      toolCallId,
      content: "still needs more",
    });
  });
});
