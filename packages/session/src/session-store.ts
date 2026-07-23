import type { Message, SessionId } from "@byte-mentor/core";

export type SessionMetadata = Record<string, unknown>;

export interface Session {
  id: SessionId;
  metadata: SessionMetadata;
}

export interface SessionStore {
  create(): Promise<Session>;
  get(id: SessionId): Promise<Session | undefined>;
  appendMessages(id: SessionId, messages: Message[]): Promise<void>;
  getHistory(id: SessionId): Promise<Message[]>;
  updateMetadata(
    id: SessionId,
    updater: (metadata: SessionMetadata) => SessionMetadata,
  ): Promise<SessionMetadata>;
  close(): Promise<void>;
}

export class SessionStoreClosedError extends Error {
  constructor() {
    super("session store is closed");
    this.name = "SessionStoreClosedError";
  }
}
