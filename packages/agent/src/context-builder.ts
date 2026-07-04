import type { Message } from "@byte-mentor/core";

export interface ContextBuilderInput {
  history: Message[];
  userMessage: Message;
}

export class ContextBuilder {
  async build(input: ContextBuilderInput): Promise<Message[]> {
    return [...input.history, input.userMessage];
  }
}
