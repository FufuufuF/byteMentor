import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createToolCallId,
  type AssistantMessage,
  type Message,
  type StopReason,
  type ToolCall,
  type ToolMessage,
  type UserMessage,
} from "@byte-mentor/core";

describe("core messages", () => {
  it("UserMessage carries role and content", () => {
    const msg: UserMessage = { role: "user", content: "hello" };
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hello");
  });

  it("AssistantMessage can be created without toolCalls", () => {
    const msg: AssistantMessage = { role: "assistant", content: "hi there" };
    expect(msg.toolCalls).toBeUndefined();
    expect(msg.content).toBe("hi there");
  });

  it("AssistantMessage can carry toolCalls with id, name, and args", () => {
    const toolCallId = createToolCallId();
    const call: ToolCall = {
      id: toolCallId,
      name: "search",
      args: { query: "tdd" },
    };
    const msg: AssistantMessage = {
      role: "assistant",
      content: "calling search",
      toolCalls: [call],
    };
    expect(msg.toolCalls?.[0].id).toBe(toolCallId);
    expect(msg.toolCalls?.[0].name).toBe("search");
    expect(msg.toolCalls?.[0].args).toEqual({ query: "tdd" });
  });

  it("ToolMessage links back to AssistantMessage.toolCalls[].id via toolCallId", () => {
    const toolCallId = createToolCallId();
    const assistant: AssistantMessage = {
      role: "assistant",
      content: "calling tool",
      toolCalls: [{ id: toolCallId, name: "calc", args: { x: 1 } }],
    };
    const toolMsg: ToolMessage = {
      role: "tool",
      toolCallId,
      content: "42",
    };
    expect(toolMsg.toolCallId).toBe(assistant.toolCalls?.[0].id);
  });

  it("Message union narrows by role discriminant", () => {
    const messages: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "tool", toolCallId: createToolCallId(), content: "r" },
    ];
    const userMsg = messages.find((m): m is UserMessage => m.role === "user");
    const assistantMsg = messages.find((m): m is AssistantMessage => m.role === "assistant");
    const toolMsg = messages.find((m): m is ToolMessage => m.role === "tool");
    expect(userMsg?.content).toBe("q");
    expect(assistantMsg?.content).toBe("a");
    expect(toolMsg?.content).toBe("r");
  });

  it("AssistantMessage may omit content when only requesting tool calls", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      toolCalls: [{ id: createToolCallId(), name: "noop", args: {} }],
    };
    expect(msg.content).toBeUndefined();
    expect(msg.toolCalls?.length).toBe(1);
  });

  it("MessageId can be attached to any message via optional id field", () => {
    const id = createMessageId();
    const msg: Message = { role: "user", content: "hi", id };
    expect((msg as { id?: string }).id).toBe(id);
  });
});

describe("StopReason", () => {
  it("accepts each declared variant", () => {
    const reasons: StopReason[] = ["completed", "failed", "max_iterations", "tool_calls"];
    expect(reasons).toContain("completed");
    expect(reasons).toContain("failed");
    expect(reasons).toContain("max_iterations");
    expect(reasons).toContain("tool_calls");
  });
});
