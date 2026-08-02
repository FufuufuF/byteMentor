import { describe, expect, test } from "vitest";
import { createToolCallId } from "@byte-mentor/core";
import { AgentLoop, AgentRunner, ContextBuilder, ToolRegistry } from "@byte-mentor/agent";
import type { ModelProvider, ProviderRequest, ProviderStreamEvent } from "@byte-mentor/agent";
import { InMemorySessionStore } from "@byte-mentor/session";
import { ByteMentorTui } from "@byte-mentor/tui";
import { runChat, type RunChatIO } from "../../apps/cli/src/run-chat.js";
import { VirtualTerminal } from "../tui/virtual-terminal.js";

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

function sendText(terminal: VirtualTerminal, text: string): void {
  for (const character of text) terminal.sendInput(character);
  terminal.sendInput("\r");
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition did not become true");
}

const silentIO: RunChatIO = {
  stdout: { write: () => undefined },
  stderr: { write: () => undefined },
};

describe("interactive chat integration", () => {
  // Streams before completion, executes a real registered tool, and preserves one session across both turns.
  test("runs two interactive turns with live tool rendering", async () => {
    const firstStreamContinues = deferred<void>();
    const firstDeltaObserved = deferred<void>();
    const toolContinues = deferred<void>();
    const toolStarted = deferred<void>();
    const toolCallId = createToolCallId();
    const requests: ProviderRequest[] = [];
    let providerCall = 0;
    const provider = streamProvider(async function* (request) {
      requests.push({ ...request, messages: [...request.messages] });
      providerCall += 1;
      if (providerCall === 1) {
        yield { type: "content_delta", text: "第一段" };
        firstDeltaObserved.resolve();
        await firstStreamContinues.promise;
        yield { type: "content_delta", text: "回答" };
        yield {
          type: "done",
          message: { role: "assistant", content: "第一段回答" },
          stopReason: "completed",
        };
        return;
      }
      if (providerCall === 2) {
        yield {
          type: "done",
          message: {
            role: "assistant",
            toolCalls: [{ id: toolCallId, name: "read_lesson", args: { topic: "Promise" } }],
          },
          stopReason: "tool_calls",
        };
        return;
      }
      yield { type: "content_delta", text: "工具读取完成" };
      yield {
        type: "done",
        message: { role: "assistant", content: "工具读取完成" },
        stopReason: "completed",
      };
    });
    const sessionStore = new InMemorySessionStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "read_lesson",
      description: "read lesson content",
      concurrency: "safe",
      async execute() {
        toolStarted.resolve();
        await toolContinues.promise;
        return { ok: true, data: "lesson result" };
      },
    });
    const realLoop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: new AgentRunner(provider),
      tools,
    });
    const sessionIds: string[] = [];
    let closeCount = 0;
    const terminal = new VirtualTerminal(80, 24);
    const resultPromise = runChat(
      {
        command: "chat",
        openaiApiKey: "sk-test",
        model: "gpt-test",
        dbPath: "/tmp/unused.sqlite",
        workspaceRoot: "/workspace",
      },
      silentIO,
      {
        createLoop: () => ({
          loop: {
            async runTurn(input, options) {
              const result = await realLoop.runTurn(input, options);
              sessionIds.push(result.sessionId);
              return result;
            },
          },
          async close() {
            closeCount += 1;
            await sessionStore.close();
          },
        }),
        createView: (options) => new ByteMentorTui({ ...options, terminal }),
      },
    );
    await terminal.waitForRender();

    sendText(terminal, "第一个问题");
    await firstDeltaObserved.promise;
    await terminal.waitForRender();
    expect(terminal.getScrollBuffer().join("\n")).toContain("第一段");
    expect(sessionIds).toHaveLength(0);
    firstStreamContinues.resolve();
    await waitFor(() => sessionIds.length === 1);

    sendText(terminal, "读取课程");
    await toolStarted.promise;
    await terminal.waitForRender();
    expect(terminal.getScrollBuffer().join("\n")).toContain("running");
    toolContinues.resolve();
    await waitFor(() => sessionIds.length === 2);
    await terminal.waitForRender();

    const screen = terminal.getScrollBuffer().join("\n");
    expect(screen).toContain("lesson result");
    expect(screen).toContain("工具读取完成");
    expect(new Set(sessionIds)).toHaveLength(1);
    expect(requests[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);

    terminal.sendInput("\x03");
    expect(await resultPromise).toBe(0);
    expect(closeCount).toBe(1);
  });

  // Shows a provider failure in the transcript and accepts a recovery turn in the same session.
  test("continues after a failed model turn", async () => {
    let providerCall = 0;
    const provider = streamProvider(async function* () {
      providerCall += 1;
      if (providerCall === 1) throw new Error("provider unavailable");
      yield { type: "content_delta", text: "recovered" };
      yield {
        type: "done",
        message: { role: "assistant", content: "recovered" },
        stopReason: "completed",
      };
    });
    const sessionStore = new InMemorySessionStore();
    const realLoop = new AgentLoop({
      sessionStore,
      contextBuilder: new ContextBuilder(),
      runner: new AgentRunner(provider),
    });
    const sessionIds: string[] = [];
    const terminal = new VirtualTerminal(80, 24);
    const resultPromise = runChat(
      {
        command: "chat",
        openaiApiKey: "sk-test",
        model: "gpt-test",
        dbPath: "/tmp/unused.sqlite",
        workspaceRoot: "/workspace",
      },
      silentIO,
      {
        createLoop: () => ({
          loop: {
            async runTurn(input, options) {
              const result = await realLoop.runTurn(input, options);
              sessionIds.push(result.sessionId);
              return result;
            },
          },
          close: () => sessionStore.close(),
        }),
        createView: (options) => new ByteMentorTui({ ...options, terminal }),
      },
    );
    await terminal.waitForRender();

    sendText(terminal, "失败一次");
    await waitFor(() => sessionIds.length === 1);
    await terminal.waitForRender();
    expect(terminal.getScrollBuffer().join("\n")).toContain("provider unavailable");
    sendText(terminal, "再试一次");
    await waitFor(() => sessionIds.length === 2);
    await terminal.waitForRender();
    expect(terminal.getScrollBuffer().join("\n")).toContain("recovered");
    expect(new Set(sessionIds)).toHaveLength(1);

    terminal.sendInput("\x03");
    expect(await resultPromise).toBe(0);
  });
});

function streamProvider(
  invokeStream: (request: ProviderRequest) => AsyncIterable<ProviderStreamEvent>,
): ModelProvider {
  return {
    async invoke(request) {
      let done: Extract<ProviderStreamEvent, { type: "done" }> | undefined;
      for await (const event of invokeStream(request)) {
        if (event.type === "done") done = event;
      }
      if (done === undefined) throw new Error("missing done event");
      return { message: done.message, stopReason: done.stopReason };
    },
    invokeStream,
  };
}
