import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createSessionId,
  createToolCallId,
  createTurnId,
  type RuntimeEvent,
  type TurnCompletedEvent,
  type TurnFailedEvent,
  type TurnStartedEvent,
  type ContextBuiltEvent,
  type ModelRequestedEvent,
  type ModelRespondedEvent,
  type ToolStartedEvent,
  type ToolCompletedEvent,
  type ToolFailedEvent,
} from "@byte-mentor/core";

describe("RuntimeEvent common base", () => {
  it("every event carries type, turnId, ts:number", () => {
    const turnId = createTurnId();
    const sessionId = createSessionId();
    const messageId = createMessageId();
    const toolCallId = createToolCallId();
    const events: RuntimeEvent[] = [
      { type: "turn.started", turnId, ts: 1, sessionId },
      { type: "context.built", turnId, ts: 2, messageCount: 0 },
      { type: "model.requested", turnId, ts: 3, messageCount: 0, toolCount: 0 },
      { type: "model.responded", turnId, ts: 4, messageId, stopReason: "completed" },
      { type: "tool.started", turnId, ts: 5, toolCallId, toolName: "n" },
      { type: "tool.completed", turnId, ts: 6, toolCallId, result: "r" },
      { type: "tool.failed", turnId, ts: 7, toolCallId, message: "m" },
      { type: "turn.completed", turnId, ts: 8, sessionId, messageId, stopReason: "completed" },
      { type: "turn.failed", turnId, ts: 9, sessionId, message: "m" },
    ];
    for (const e of events) {
      expect(typeof e.type).toBe("string");
      expect(e.turnId).toBe(turnId);
      expect(typeof e.ts).toBe("number");
    }
    expect(events.length).toBe(9);
  });
});

describe("RuntimeEvent variant-specific fields", () => {
  const turnId = createTurnId();
  const sessionId = createSessionId();
  const messageId = createMessageId();
  const toolCallId = createToolCallId();

  it("turn.started carries sessionId", () => {
    const e: TurnStartedEvent = { type: "turn.started", turnId, ts: 1, sessionId };
    expect(e.sessionId).toBe(sessionId);
  });

  it("context.built carries messageCount", () => {
    const e: ContextBuiltEvent = {
      type: "context.built",
      turnId,
      ts: 1,
      messageCount: 3,
    };
    expect(e.messageCount).toBe(3);
  });

  it("model.requested carries messageCount and toolCount", () => {
    const e: ModelRequestedEvent = {
      type: "model.requested",
      turnId,
      ts: 1,
      messageCount: 3,
      toolCount: 2,
    };
    expect(e.messageCount).toBe(3);
    expect(e.toolCount).toBe(2);
  });

  it("model.responded carries messageId and stopReason", () => {
    const e: ModelRespondedEvent = {
      type: "model.responded",
      turnId,
      ts: 1,
      messageId,
      stopReason: "tool_calls",
    };
    expect(e.messageId).toBe(messageId);
    expect(e.stopReason).toBe("tool_calls");
  });

  it("tool.started carries toolCallId and toolName", () => {
    const e: ToolStartedEvent = {
      type: "tool.started",
      turnId,
      ts: 1,
      toolCallId,
      toolName: "search",
    };
    expect(e.toolCallId).toBe(toolCallId);
    expect(e.toolName).toBe("search");
  });

  it("tool.completed carries toolCallId and result", () => {
    const e: ToolCompletedEvent = {
      type: "tool.completed",
      turnId,
      ts: 1,
      toolCallId,
      result: "ok",
    };
    expect(e.toolCallId).toBe(toolCallId);
    expect(e.result).toBe("ok");
  });

  it("tool.failed carries toolCallId and error message", () => {
    const e: ToolFailedEvent = {
      type: "tool.failed",
      turnId,
      ts: 1,
      toolCallId,
      message: "unknown tool",
    };
    expect(e.toolCallId).toBe(toolCallId);
    expect(e.message).toBe("unknown tool");
  });

  it("turn.completed carries sessionId, messageId, stopReason", () => {
    const e: TurnCompletedEvent = {
      type: "turn.completed",
      turnId,
      ts: 1,
      sessionId,
      messageId,
      stopReason: "completed",
    };
    expect(e.sessionId).toBe(sessionId);
    expect(e.messageId).toBe(messageId);
    expect(e.stopReason).toBe("completed");
  });

  it("turn.failed carries sessionId and error message", () => {
    const e: TurnFailedEvent = {
      type: "turn.failed",
      turnId,
      ts: 1,
      sessionId,
      message: "provider down",
    };
    expect(e.sessionId).toBe(sessionId);
    expect(e.message).toBe("provider down");
  });
});

describe("RuntimeEvent discriminated union narrowing", () => {
  const turnId = createTurnId();

  it("narrows by type literal", () => {
    const e: RuntimeEvent = {
      type: "tool.completed",
      turnId,
      ts: 1,
      toolCallId: createToolCallId(),
      result: "x",
    };
    if (e.type === "tool.completed") {
      expect(e.result).toBe("x");
    }
  });

  it("exhaustive switch over type compiles", () => {
    const e: RuntimeEvent = { type: "turn.started", turnId, ts: 1, sessionId: createSessionId() };
    const label = runtimeEventTypeLabel(e);
    expect(label).toBe("turn.started");
  });
});

function runtimeEventTypeLabel(e: RuntimeEvent): string {
  switch (e.type) {
    case "turn.started":
      return "turn.started";
    case "turn.completed":
      return "turn.completed";
    case "turn.failed":
      return "turn.failed";
    case "context.built":
      return "context.built";
    case "model.requested":
      return "model.requested";
    case "model.responded":
      return "model.responded";
    case "tool.started":
      return "tool.started";
    case "tool.completed":
      return "tool.completed";
    case "tool.failed":
      return "tool.failed";
  }
}
