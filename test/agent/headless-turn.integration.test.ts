import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMessageId, createToolCallId } from "@byte-mentor/core";
import type { Message, RuntimeEvent, StopReason } from "@byte-mentor/core";
import { AgentLoop, AgentRunner, ContextBuilder } from "@byte-mentor/agent";
import type {
  AgentTool,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  RuntimeCheckpoint,
} from "@byte-mentor/agent";
import { InMemorySessionStore, SqliteSessionStore } from "@byte-mentor/session";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function settleAsyncWork(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !condition(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function invokeProvider(
  invoke: (req: ProviderRequest) => Promise<ProviderResponse>,
): ModelProvider {
  return {
    async invoke(req) {
      return invoke(req);
    },
    async *invokeStream(req) {
      const response = await invoke(req);
      if (response.message.content !== undefined && response.message.content.length > 0) {
        yield { type: "content_delta", text: response.message.content };
      }
      yield {
        type: "done",
        message: response.message,
        stopReason: response.stopReason,
      };
    },
  };
}

describe("headless turn public API integration", () => {
  // Verifies a no-tool turn observes every lifecycle event in the same order returned to the caller.
  it("observes the complete runtime event sequence for a simple turn", async () => {
    const provider = invokeProvider(async () => ({
      message: { role: "assistant", content: "Hello." },
      stopReason: "completed",
    }));
    const observed: RuntimeEvent[] = [];
    const loop = new AgentLoop({
      sessionStore: new InMemorySessionStore(),
      contextBuilder: new ContextBuilder(),
      runner: new AgentRunner(provider),
    });

    const result = await loop.runTurn(
      { userMessage: "Hello" },
      {
        onRuntimeEvent(event) {
          observed.push(event);
        },
      },
    );

    expect(observed).toEqual(result.events);
    expect(observed.map((event) => event.type)).toEqual([
      "turn.started",
      "context.built",
      "model.requested",
      "model.responded",
      "turn.completed",
    ]);
  });

  // Verifies provider failure still emits turn.failed and preserves observer/result order.
  it("observes a failed turn through its terminal runtime event", async () => {
    const provider = invokeProvider(async () => {
      throw new Error("provider unavailable");
    });
    const observed: RuntimeEvent[] = [];
    const loop = new AgentLoop({
      sessionStore: new InMemorySessionStore(),
      contextBuilder: new ContextBuilder(),
      runner: new AgentRunner(provider),
    });

    const result = await loop.runTurn(
      { userMessage: "Hello" },
      {
        onRuntimeEvent(event) {
          observed.push(event);
        },
      },
    );

    expect(result.status).toBe("failed");
    expect(observed).toEqual(result.events);
    expect(observed.at(-1)?.type).toBe("turn.failed");
  });

  // 验证外部调用方只通过包公开 API 即可完成模型请求、工具执行、JSON 回传和会话持久化。
  it("runs a tool-using headless turn through public package exports", async () => {
    const toolCallId = createToolCallId();
    const providerRequests: unknown[] = [];
    const provider = invokeProvider(async (req) => {
      providerRequests.push({
        messages: req.messages,
        tools: req.tools,
      });
      if (req.messages.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: toolCallId,
                name: "lookup",
                args: { query: "public api" },
              },
            ],
          },
          stopReason: "tool_calls",
        };
      }
      return {
        message: {
          role: "assistant",
          content: "The public API turn completed.",
        },
        stopReason: "completed",
      };
    });
    const lookupTool: AgentTool = {
      name: "lookup",
      description: "lookup docs",
      parametersJsonSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      async execute(args) {
        const a = args as { query: string };
        return { ok: true, data: `docs:${a.query}` };
      },
    };
    const sessionStore = new InMemorySessionStore();
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: new AgentRunner(provider),
    });
    loop.tools.register(lookupTool);

    const result = await loop.runTurn({ userMessage: "Use lookup once." });

    const history = await sessionStore.getHistory(result.sessionId);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      throw new Error(`expected completed result, got ${result.status}`);
    }
    expect(result.stopReason).toBe("completed");
    expect(result.finalMessage).toMatchObject({
      role: "assistant",
      content: "The public API turn completed.",
    });
    expect(result.newMessages).toEqual(history);
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(history[1]).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: toolCallId, name: "lookup", args: { query: "public api" } }],
    });
    expect(history[2]).toMatchObject({
      role: "tool",
      toolCallId,
      content: '{"ok":true,"data":"docs:public api"}',
    });
    expect(result.events.map((event) => event.type)).toEqual([
      "turn.started",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.started",
      "tool.completed",
      "model.requested",
      "model.responded",
      "turn.completed",
    ]);
    expect(providerRequests).toHaveLength(2);
  });

  // 公共 Headless 链路应让 safe 调用重叠执行，同时按模型调用顺序持久化工具消息。
  it("preserves persisted tool order across concurrent headless execution", async () => {
    const firstId = createToolCallId();
    const secondId = createToolCallId();
    const provider = invokeProvider(async (req) =>
      req.messages.length === 1
        ? {
            message: {
              role: "assistant",
              toolCalls: [
                { id: firstId, name: "safe_read", args: { label: "first" } },
                { id: secondId, name: "safe_read", args: { label: "second" } },
              ],
            },
            stopReason: "tool_calls",
          }
        : {
            message: { role: "assistant", content: "Both reads completed." },
            stopReason: "completed",
          },
    );
    const release = deferred<void>();
    const started: string[] = [];
    const sessionStore = new InMemorySessionStore();
    const loop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: new AgentRunner(provider, { maxConcurrentToolCalls: 2 }),
    });
    loop.tools.register({
      name: "safe_read",
      description: "read safely",
      concurrency: "safe",
      async execute(args) {
        const label = (args as { label: string }).label;
        started.push(label);
        await release.promise;
        return { ok: true, data: `${label} result` };
      },
    });
    const turnPromise = loop.runTurn({ userMessage: "Read both files." });

    await settleAsyncWork(() => started.length >= 2);
    let result: Awaited<ReturnType<AgentLoop["runTurn"]>>;
    try {
      expect([...started]).toEqual(["first", "second"]);
    } finally {
      release.resolve();
      result = await turnPromise;
    }
    const history = await sessionStore.getHistory(result.sessionId);
    expect(history.slice(1, 4)).toMatchObject([
      { role: "assistant", toolCalls: [{ id: firstId }, { id: secondId }] },
      { role: "tool", toolCallId: firstId, content: '{"ok":true,"data":"first result"}' },
      {
        role: "tool",
        toolCallId: secondId,
        content: '{"ok":true,"data":"second result"}',
      },
    ]);
  });

  // SQLite 重开后应恢复最后 checkpoint，并在新 turn 构建上下文前清理恢复元数据。
  it("restores a runtime checkpoint after reopening a SQLite session store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "byte-mentor-checkpoint-integration-"));
    const dbPath = join(dir, "session.sqlite");
    const firstStore = new SqliteSessionStore({ dbPath });
    let secondStore: SqliteSessionStore | undefined;
    try {
      const session = await firstStore.create();
      const previousUserMessage: Message = {
        id: createMessageId(),
        role: "user",
        content: "previous question",
      };
      const restoredAssistant = {
        id: createMessageId(),
        role: "assistant" as const,
        content: "recovered answer",
      };
      await firstStore.appendMessages(session.id, [previousUserMessage]);
      await firstStore.updateMetadata(session.id, () => ({
        project: "byte-mentor",
        pending_user_turn: true,
        runtime_checkpoint: {
          phase: "final_response",
          iteration: 0,
          newMessages: [restoredAssistant],
          pendingToolCalls: [],
        } satisfies RuntimeCheckpoint,
      }));
      await firstStore.close();

      secondStore = new SqliteSessionStore({ dbPath });
      const runnerMessages: Message[][] = [];
      const loop = new AgentLoop({
        sessionStore: secondStore,
        contextBuilder: new ContextBuilder(),
        runner: {
          async run(input: { messages: Message[] }) {
            runnerMessages.push(input.messages);
            return {
              newMessages: [
                {
                  id: createMessageId(),
                  role: "assistant" as const,
                  content: "current answer",
                },
              ],
              stopReason: "completed" as StopReason,
              events: [],
            };
          },
        },
      });

      await loop.runTurn({ sessionId: session.id, userMessage: "current question" });

      expect(runnerMessages).toEqual([
        [
          previousUserMessage,
          restoredAssistant,
          {
            id: expect.any(String),
            role: "user",
            content: "current question",
          },
        ],
      ]);
      expect((await secondStore.get(session.id))?.metadata).toEqual({
        project: "byte-mentor",
      });
    } finally {
      await firstStore.close();
      await secondStore?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
