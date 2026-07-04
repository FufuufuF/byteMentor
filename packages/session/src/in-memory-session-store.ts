import type { Message, SessionId } from "@byte-mentor/core";
import { createSessionId } from "@byte-mentor/core";

export interface Session {
  id: SessionId;
}

export interface SessionStore {
  create(): Promise<Session>;
  get(id: SessionId): Promise<Session | undefined>;
  appendMessages(id: SessionId, messages: Message[]): Promise<void>;
  getHistory(id: SessionId): Promise<Message[]>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<SessionId, Message[]>();

  async create(): Promise<Session> {
    const id = createSessionId();
    this.sessions.set(id, []);
    return { id };
  }

  async get(id: SessionId): Promise<Session | undefined> {
    if (!this.sessions.has(id)) {
      return undefined;
    }
    return { id };
  }

  async appendMessages(id: SessionId, messages: Message[]): Promise<void> {
    const history = this.sessions.get(id);
    if (history === undefined) {
      throw new Error(`session not found: ${id}`);
    }
    history.push(...messages);
  }

  async getHistory(id: SessionId): Promise<Message[]> {
    const history = this.sessions.get(id);
    return history ? [...history] : [];
  }
}
