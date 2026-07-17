import type { Message, SessionId } from "@byte-mentor/core";

export interface Session {
  id: SessionId;
}

export interface SessionStore {
  create(): Promise<Session>;
  get(id: SessionId): Promise<Session | undefined>;
  appendMessages(id: SessionId, messages: Message[]): Promise<void>;
  getHistory(id: SessionId): Promise<Message[]>;
  close(): Promise<void>;
}

export class SessionStoreClosedError extends Error {
  constructor() {
    super("session store is closed");
    this.name = "SessionStoreClosedError";
  }
}
