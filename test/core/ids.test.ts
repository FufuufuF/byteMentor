import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createSessionId,
  createToolCallId,
  createTurnId,
  type MessageId,
  type SessionId,
} from "@byte-mentor/core";

describe("core ids", () => {
  it("createSessionId returns a string-compatible unique value per call", () => {
    const a = createSessionId();
    const b = createSessionId();
    expect(typeof a).toBe("string");
    expect(a).not.toBe(b);
  });

  it("each factory returns a distinct value", () => {
    const session = createSessionId();
    const message = createMessageId();
    const toolCall = createToolCallId();
    const turn = createTurnId();
    expect(new Set([session, message, toolCall, turn]).size).toBe(4);
  });

  it("branded SessionId is not assignable to MessageId at compile time", () => {
    const session = createSessionId();
    // @ts-expect-error brand mismatch: SessionId cannot be assigned to MessageId
    const asMessage: MessageId = session;
    expect(asMessage as string).toBe(session as string);
  });

  it("branded types can be passed back to APIs expecting the same brand", () => {
    const session: SessionId = createSessionId();
    const again: SessionId = session;
    expect(again).toBe(session);
  });
});
