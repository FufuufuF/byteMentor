import type { Message, SessionId } from "@byte-mentor/core";
import { createSessionId } from "@byte-mentor/core";
import type { Session, SessionMetadata, SessionStore } from "./session-store.js";

interface InMemorySessionRecord {
  metadata: SessionMetadata;
  messages: Message[];
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<SessionId, InMemorySessionRecord>();

  async create(): Promise<Session> {
    const id = createSessionId();
    const metadata = {};
    this.sessions.set(id, { metadata, messages: [] });
    return { id, metadata };
  }

  async get(id: SessionId): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return undefined;
    }
    return { id, metadata: { ...session.metadata } };
  }

  async appendMessages(id: SessionId, messages: Message[]): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new Error(`session not found: ${id}`);
    }
    session.messages.push(...messages);
  }

  async getHistory(id: SessionId): Promise<Message[]> {
    const session = this.sessions.get(id);
    return session ? [...session.messages] : [];
  }

  async updateMetadata(
    id: SessionId,
    updater: (metadata: SessionMetadata) => SessionMetadata,
  ): Promise<SessionMetadata> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new Error(`session not found: ${id}`);
    }
    const metadata = { ...updater({ ...session.metadata }) };
    session.metadata = metadata;
    return { ...metadata };
  }

  async close(): Promise<void> {}
}
