import { describe, expect, test } from "vitest";
import {
  createMessageId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from "@byte-mentor/core";
import type { Message, RuntimeEvent, SessionId } from "@byte-mentor/core";
import type { AgentLoop, HeadlessTurnOptions, HeadlessTurnResult } from "@byte-mentor/agent";
import {
  InteractiveChatController,
  type InteractiveChatView,
} from "../../apps/cli/src/interactive-chat-controller.js";

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

class RecordingView implements InteractiveChatView {
  calls: Array<[string, ...unknown[]]> = [];

  start(): void {
    this.calls.push(["start"]);
  }
  stop(): void {
    this.calls.push(["stop"]);
  }
  appendUserMessage(text: string): void {
    this.calls.push(["appendUserMessage", text]);
  }
  beginAssistantMessage(): void {
    this.calls.push(["beginAssistantMessage"]);
  }
  appendAssistantDelta(text: string): void {
    this.calls.push(["appendAssistantDelta", text]);
  }
  completeAssistantMessage(content?: string): void {
    this.calls.push(["completeAssistantMessage", content]);
  }
  addToolCall(toolCall: { id: string; name: string; args: unknown }): void {
    this.calls.push(["addToolCall", toolCall]);
  }
  startToolCall(id: string): void {
    this.calls.push(["startToolCall", id]);
  }
  completeToolCall(id: string, output: string): void {
    this.calls.push(["completeToolCall", id, output]);
  }
  failToolCall(id: string, message: string): void {
    this.calls.push(["failToolCall", id, message]);
  }
  cancelToolCall(id: string, message: string): void {
    this.calls.push(["cancelToolCall", id, message]);
  }
  showError(message: string): void {
    this.calls.push(["showError", message]);
  }
  setBusy(busy: boolean): void {
    this.calls.push(["setBusy", busy]);
  }
  setSessionId(sessionId: string): void {
    this.calls.push(["setSessionId", sessionId]);
  }
  setExitAfterTurn(pending: boolean): void {
    this.calls.push(["setExitAfterTurn", pending]);
  }
}

describe("InteractiveChatController", () => {
  // Auto-submits an initial prompt, keeps the view running, and reuses the first result session on later input.
  test("runs consecutive turns in one process-local session", async () => {
    const sessionId = createSessionId();
    const inputs: Parameters<AgentLoop["runTurn"]>[0][] = [];
    const loop = {
      async runTurn(input: Parameters<AgentLoop["runTurn"]>[0]) {
        inputs.push(input);
        return completedTurn(sessionId, `answer ${inputs.length}`);
      },
    };
    const view = new RecordingView();
    const controller = new InteractiveChatController({ loop, view, close: async () => undefined });

    await controller.start("first question");
    await controller.submit("second question");
    await controller.submit("third question");

    expect(inputs).toEqual([
      { userMessage: "first question" },
      { userMessage: "second question", sessionId },
      { userMessage: "third question", sessionId },
    ]);
    expect(view.calls.filter(([name]) => name === "start")).toHaveLength(1);
    expect(view.calls.filter(([name]) => name === "stop")).toHaveLength(0);
  });

  // Rejects overlapping input while one runTurn promise is active and accepts input again after it settles.
  test("allows at most one active turn", async () => {
    const firstTurn = deferred<HeadlessTurnResult>();
    const inputs: string[] = [];
    const loop = {
      async runTurn(input: Parameters<AgentLoop["runTurn"]>[0]) {
        inputs.push(input.userMessage);
        return inputs.length === 1
          ? firstTurn.promise
          : completedTurn(createSessionId(), "second answer");
      },
    };
    const controller = new InteractiveChatController({
      loop,
      view: new RecordingView(),
      close: async () => undefined,
    });
    await controller.start();

    const active = controller.submit("first");
    await controller.submit("blocked");
    expect(inputs).toEqual(["first"]);
    firstTurn.resolve(completedTurn(createSessionId(), "first answer"));
    await active;
    await controller.submit("accepted");
    expect(inputs).toEqual(["first", "accepted"]);
  });

  // Maps provider boundaries, tool lifecycle events, and full ToolMessage reconciliation into view mutations.
  test("maps streaming and tool events into the transcript", async () => {
    const toolCallId = createToolCallId();
    const view = new RecordingView();
    const loop = {
      async runTurn(_input: Parameters<AgentLoop["runTurn"]>[0], options?: HeadlessTurnOptions) {
        options?.onStreamEvent?.({ type: "content_delta", text: "checking" });
        options?.onStreamEvent?.({
          type: "done",
          message: {
            role: "assistant",
            content: "checking tools",
            toolCalls: [{ id: toolCallId, name: "read_file", args: { path: "README.md" } }],
          },
          stopReason: "tool_calls",
        });
        options?.onRuntimeEvent?.(toolEvent("tool.started", toolCallId));
        options?.onRuntimeEvent?.(toolEvent("tool.completed", toolCallId));
        options?.onStreamEvent?.({
          type: "done",
          message: { role: "assistant", content: "final answer" },
          stopReason: "completed",
        });
        return completedTurn(createSessionId(), "final answer", [
          {
            id: createMessageId(),
            role: "tool",
            toolCallId,
            content: "complete tool output",
          },
        ]);
      },
    };
    const controller = new InteractiveChatController({ loop, view, close: async () => undefined });
    await controller.start();

    await controller.submit("inspect");

    expect(view.calls).toEqual(
      expect.arrayContaining([
        ["appendAssistantDelta", "checking"],
        ["completeAssistantMessage", "checking tools"],
        ["addToolCall", { id: toolCallId, name: "read_file", args: { path: "README.md" } }],
        ["startToolCall", toolCallId],
        ["completeToolCall", toolCallId, "preview"],
        ["completeToolCall", toolCallId, "complete tool output"],
        ["completeAssistantMessage", "final answer"],
      ]),
    );
  });

  // Displays failed and thrown turns inside the view, restores idle, and permits a subsequent turn.
  test("recovers from turn failures without exiting", async () => {
    let attempt = 0;
    const view = new RecordingView();
    const loop = {
      async runTurn(_input: Parameters<AgentLoop["runTurn"]>[0], options?: HeadlessTurnOptions) {
        attempt += 1;
        if (attempt === 1) {
          options?.onStreamEvent?.({ type: "content_delta", text: "partial" });
          return failedTurn(createSessionId(), "provider failed");
        }
        if (attempt === 2) throw new Error("network disconnected");
        return completedTurn(createSessionId(), "recovered");
      },
    };
    const controller = new InteractiveChatController({ loop, view, close: async () => undefined });
    await controller.start();

    await controller.submit("first");
    await controller.submit("second");
    await controller.submit("third");

    expect(view.calls.filter(([name]) => name === "showError")).toEqual([
      ["showError", "provider failed"],
      ["showError", "network disconnected"],
    ]);
    expect(view.calls).toContainEqual(["completeAssistantMessage", undefined]);
    expect(view.calls.filter(([name, busy]) => name === "setBusy" && busy === false)).toHaveLength(
      3,
    );
  });

  // Defers a busy exit until turn completion and runs view/runtime cleanup exactly once on repeated requests.
  test("cleans up exactly once for idle and deferred exits", async () => {
    const pending = deferred<HeadlessTurnResult>();
    const view = new RecordingView();
    let closeCount = 0;
    const controller = new InteractiveChatController({
      loop: { runTurn: async () => pending.promise },
      view,
      close: async () => {
        closeCount += 1;
      },
    });
    await controller.start();
    const active = controller.submit("finish before exit");

    controller.requestExit();
    controller.requestExit();
    expect(view.calls).toContainEqual(["setExitAfterTurn", true]);
    expect(closeCount).toBe(0);
    pending.resolve(completedTurn(createSessionId(), "done"));
    await active;
    expect(await controller.waitForExit()).toBe(0);
    controller.requestExit();

    expect(view.calls.filter(([name]) => name === "stop")).toHaveLength(1);
    expect(closeCount).toBe(1);
  });
});

describe("InteractiveChatController cancellation", () => {
  // 忙碌时请求退出应 abort 当前 turn 的 signal、标记退出意图，并在 turn 收敛后关闭 Runtime。
  test("aborts the active turn signal when exit is requested while busy", async () => {
    const pending = deferred<HeadlessTurnResult>();
    const signals: Array<AbortSignal | undefined> = [];
    const view = new RecordingView();
    let closeCount = 0;
    const controller = new InteractiveChatController({
      loop: {
        async runTurn(_input, options) {
          signals.push(options?.signal);
          return pending.promise;
        },
      },
      view,
      close: async () => {
        closeCount += 1;
      },
    });
    await controller.start();
    const active = controller.submit("busy turn");

    controller.requestExit();

    expect(view.calls).toContainEqual(["setExitAfterTurn", true]);
    expect(signals[0]?.aborted).toBe(true);
    expect(closeCount).toBe(0);

    pending.resolve(cancelledTurn(createSessionId()));
    await active;
    expect(await controller.waitForExit()).toBe(0);
    expect(closeCount).toBe(1);
  });

  // 取消的 turn 会结束已有的流式 Assistant 卡片，但不调用 showError。
  test("ends a streaming assistant card without showing an error for a cancelled turn", async () => {
    const view = new RecordingView();
    const loop = {
      async runTurn(_input: Parameters<AgentLoop["runTurn"]>[0], options?: HeadlessTurnOptions) {
        options?.onStreamEvent?.({ type: "content_delta", text: "partial" });
        return cancelledTurn(createSessionId());
      },
    };
    const controller = new InteractiveChatController({ loop, view, close: async () => undefined });
    await controller.start();

    await controller.submit("cancel me");

    expect(view.calls).toContainEqual(["completeAssistantMessage", undefined]);
    expect(view.calls.filter(([name]) => name === "showError")).toEqual([]);
  });

  // Controller 将 tool.cancelled 收敛为终态 Tool 卡片，reconcile 时仍以取消状态呈现完整内容。
  test("maps tool.cancelled events into terminal tool cards", async () => {
    const toolCallId = createToolCallId();
    const view = new RecordingView();
    const cancelledContent = '{"ok":false,"error":{"code":"tool_cancelled","message":"cancelled"}}';
    const loop = {
      async runTurn(_input: Parameters<AgentLoop["runTurn"]>[0], options?: HeadlessTurnOptions) {
        options?.onRuntimeEvent?.({
          type: "tool.cancelled",
          turnId: createTurnId(),
          ts: Date.now(),
          toolCallId,
          toolName: "edit_file",
          started: false,
          durationMs: 0,
          errorCode: "tool_cancelled",
          message: "cancelled before start",
        });
        return cancelledTurn(createSessionId(), [
          {
            id: createMessageId(),
            role: "tool",
            toolCallId,
            content: cancelledContent,
          },
        ]);
      },
    };
    const controller = new InteractiveChatController({ loop, view, close: async () => undefined });
    await controller.start();

    await controller.submit("cancel");

    expect(view.calls).toContainEqual(["cancelToolCall", toolCallId, "cancelled before start"]);
    expect(view.calls).toContainEqual(["cancelToolCall", toolCallId, cancelledContent]);
    expect(
      view.calls.filter(([name, id]) => name === "completeToolCall" && id === toolCallId),
    ).toHaveLength(0);
  });

  // 空闲时退出不引入取消链路，行为与既有请求退出一致。
  test("exits immediately without abort when idle", async () => {
    const view = new RecordingView();
    let closeCount = 0;
    const controller = new InteractiveChatController({
      loop: { runTurn: async () => completedTurn(createSessionId(), "done") },
      view,
      close: async () => {
        closeCount += 1;
      },
    });
    await controller.start();

    controller.requestExit();
    expect(await controller.waitForExit()).toBe(0);
    expect(closeCount).toBe(1);
  });
});

function completedTurn(
  sessionId: SessionId,
  content: string,
  beforeFinal: Message[] = [],
): HeadlessTurnResult {
  const finalMessage = { id: createMessageId(), role: "assistant" as const, content };
  return {
    status: "completed",
    sessionId,
    finalMessage,
    newMessages: [...beforeFinal, finalMessage],
    stopReason: "completed",
    events: [],
    trace: [],
  };
}

function failedTurn(sessionId: SessionId, message: string): HeadlessTurnResult {
  return {
    status: "failed",
    sessionId,
    error: { message },
    newMessages: [],
    stopReason: "failed",
    events: [],
    trace: [],
  };
}

function cancelledTurn(sessionId: SessionId, beforeFinal: Message[] = []): HeadlessTurnResult {
  return {
    status: "cancelled",
    sessionId,
    newMessages: [
      ...beforeFinal,
      {
        id: createMessageId(),
        role: "assistant",
        content: "[Assistant reply cancelled.]",
      },
    ],
    stopReason: "cancelled",
    events: [],
    trace: [],
  };
}

function toolEvent(
  type: "tool.started" | "tool.completed",
  toolCallId: ReturnType<typeof createToolCallId>,
): RuntimeEvent {
  const base = {
    turnId: createTurnId(),
    ts: Date.now(),
    toolCallId,
    toolName: "read_file",
  };
  return type === "tool.started"
    ? { ...base, type }
    : {
        ...base,
        type,
        durationMs: 1,
        outputCharacters: 7,
        resultPreview: "preview",
        resultPreviewTruncated: false,
      };
}
