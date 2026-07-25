import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMessageId, createToolCallId } from "@byte-mentor/core";
import type { Message, StopReason } from "@byte-mentor/core";
import { AgentLoop, AgentRunner, ContextBuilder } from "@byte-mentor/agent";
import type {
  AgentTool,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  RuntimeCheckpoint,
} from "@byte-mentor/agent";
import { InMemorySessionStore, SqliteSessionStore } from "@byte-mentor/session";

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
