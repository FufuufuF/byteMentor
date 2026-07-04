import { describe, expect, it } from "vitest";
import { createMessageId } from "@byte-mentor/core";
import type { Message } from "@byte-mentor/core";

describe("ContextBuilder.build", () => {
  it("builds model messages from history followed by the current user message", async () => {
    const agent = await import("@byte-mentor/agent");
    expect(agent).toHaveProperty("ContextBuilder");
    const ContextBuilder = agent.ContextBuilder as new () => {
      build(input: { history: Message[]; userMessage: Message }): Promise<Message[]>;
    };
    const history: Message[] = [
      { id: createMessageId(), role: "user", content: "previous question" },
      { id: createMessageId(), role: "assistant", content: "previous answer" },
    ];
    const userMessage: Message = {
      id: createMessageId(),
      role: "user",
      content: "current question",
    };

    const messages = await new ContextBuilder().build({ history, userMessage });

    expect(messages).toEqual([...history, userMessage]);
  });
});
