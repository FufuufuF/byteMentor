import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageId, createSessionId, createToolCallId } from "@byte-mentor/core";
import type {
  AgentLoop,
  HeadlessTurnResult,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
} from "@byte-mentor/agent";
import { InMemorySessionStore } from "@byte-mentor/session";
import { describe, expect, it, vi } from "vitest";
import type { CliConfig } from "../../apps/cli/src/config.js";
import {
  runChat,
  type RunChatDeps,
  type RunChatIO,
  type RunChatRuntime,
} from "../../apps/cli/src/run-chat.js";

interface TestToolEnvelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

type CreateRuntime = (
  config: CliConfig,
  deps: {
    provider: ModelProvider;
    sessionStore: InMemorySessionStore;
  },
) => RunChatRuntime;

describe("runChat", () => {
  // Starts an input-only interactive view and keeps runChat pending until the user requests exit.
  it("waits for input when no initial message is configured", async () => {
    const config = createConfig({});
    const output = createOutput();
    const close = vi.fn(async () => undefined);
    const runTurn = vi.fn<AgentLoop["runTurn"]>(async () => completedTurn("unused"));
    const createLoop = vi.fn<NonNullable<RunChatDeps["createLoop"]>>(() => ({
      loop: { runTurn },
      close,
    }));
    let viewOptions!: Parameters<NonNullable<RunChatDeps["createView"]>>[0];
    const view = createViewRecorder();
    const createView: NonNullable<RunChatDeps["createView"]> = (options) => {
      viewOptions = options;
      return view.port;
    };

    const resultPromise = runChat(config, output.io, { createLoop, createView });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runTurn).not.toHaveBeenCalled();
    expect(view.calls).toContainEqual(["start"]);
    viewOptions.onExit();
    const exitCode = await resultPromise;

    expect(exitCode).toBe(0);
    expect(createLoop).toHaveBeenCalledWith(config);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe("");
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Auto-submits the optional prompt, renders through view callbacks, and remains interactive afterward.
  it("submits an initial message without exiting after the turn", async () => {
    const config = createConfig({ initialMessage: "解释 Promise" });
    const output = createOutput();
    const close = vi.fn(async () => undefined);
    const runTurn: AgentLoop["runTurn"] = async (input, options) => {
      expect(input).toEqual({ userMessage: "解释 Promise" });
      options?.onStreamEvent?.({ type: "content_delta", text: "Promise" });
      options?.onStreamEvent?.({
        type: "done",
        message: { role: "assistant", content: "Promise answer" },
        stopReason: "completed",
      });
      return completedTurn("Promise answer");
    };
    const createLoop = vi.fn<NonNullable<RunChatDeps["createLoop"]>>(() => ({
      loop: { runTurn },
      close,
    }));
    let viewOptions!: Parameters<NonNullable<RunChatDeps["createView"]>>[0];
    const view = createViewRecorder();
    const createView: NonNullable<RunChatDeps["createView"]> = (options) => {
      viewOptions = options;
      return view.port;
    };
    let settled = false;

    const resultPromise = runChat(config, output.io, { createLoop, createView }).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    expect(view.calls).toContainEqual(["appendUserMessage", "解释 Promise"]);
    expect(view.calls).toContainEqual(["appendAssistantDelta", "Promise"]);
    viewOptions.onExit();
    expect(await resultPromise).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Reports terminal startup failure through stderr and still closes runtime/view once.
  it("returns one when view startup fails", async () => {
    const config = createConfig({});
    const output = createOutput();
    const close = vi.fn(async () => undefined);
    const createLoop = vi.fn<NonNullable<RunChatDeps["createLoop"]>>(() => ({
      loop: { runTurn: async () => completedTurn("unused") },
      close,
    }));
    const stop = vi.fn();
    const createView: NonNullable<RunChatDeps["createView"]> = () => ({
      ...createViewRecorder().port,
      start() {
        throw new Error("terminal unavailable");
      },
      stop,
    });

    const exitCode = await runChat(config, output.io, { createLoop, createView });

    expect(exitCode).toBe(1);
    expect(output.stderr()).toMatch(/terminal unavailable/);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  // 真实 CLI 组装必须向首个模型请求暴露六个按名称排序的内置工作区工具，包含写工具 edit_file 与 bash。
  it("assembles six sorted workspace tool definitions", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "byte-mentor-runtime-tools-"));
    const requests: ProviderRequest[] = [];
    const provider = invokeProvider(async (request) => {
      requests.push(request);
      return {
        message: { role: "assistant", content: "done" },
        stopReason: "completed",
      };
    });
    const runtime = (await loadCreateRuntime())(
      createConfig({ initialMessage: "inspect tools", workspaceRoot }),
      { provider, sessionStore: new InMemorySessionStore() },
    );
    try {
      await runtime.loop.runTurn({ userMessage: "inspect tools" });
    } finally {
      await runtime.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }

    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      "bash",
      "edit_file",
      "find_files",
      "list_directory",
      "read_file",
      "search_text",
    ]);
  });

  // 端到端写工具验收：read_file → edit_file（不相交替换）→ bash 非零退出 → bash 截断，
  // 验证 diff/patch、单文件原子性、非零退出码成功 payload、尾部与完整日志生命周期。
  it("completes the write-tools acceptance loop", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "byte-mentor-acceptance-"));
    await writeFile(join(workspaceRoot, "a.txt"), "hello world\nline one\nline two\n", "utf8");
    let step = 0;
    const provider = invokeProvider(async (request) => {
      const previous = step === 0 ? undefined : parseLastToolEnvelope(request);
      switch (step) {
        case 0:
          step += 1;
          return toolCallResponse("read_file", { path: "a.txt" });
        case 1:
          expect(previous).toMatchObject({
            ok: true,
            data: { content: "hello world\nline one\nline two\n" },
          });
          step += 1;
          return toolCallResponse("edit_file", {
            path: "a.txt",
            edits: [
              { oldText: "hello world", newText: "HELLO WORLD" },
              { oldText: "line one", newText: "line 1" },
            ],
          });
        case 2:
          expect(previous).toMatchObject({
            ok: true,
            data: { replacements: 2, diff: expect.stringContaining("HELLO WORLD") },
          });
          step += 1;
          return toolCallResponse("bash", { command: "cat a.txt; exit 7" });
        case 3:
          expect(previous).toMatchObject({
            ok: true,
            data: {
              exitCode: 7,
              output: expect.stringContaining("HELLO WORLD"),
            },
          });
          step += 1;
          return toolCallResponse("bash", { command: "seq 1 3000" });
        case 4:
          expect(previous).toMatchObject({
            ok: true,
            data: { truncated: true, fullOutputPath: expect.any(String) },
          });
          step += 1;
          return {
            message: { role: "assistant", content: "accepted" },
            stopReason: "completed",
          };
        default:
          return {
            message: { role: "assistant", content: "accepted" },
            stopReason: "completed",
          };
      }
    });
    const runtime = (await loadCreateRuntime())(
      createConfig({ initialMessage: "go", workspaceRoot }),
      { provider, sessionStore: new InMemorySessionStore() },
    );
    try {
      const result = await runtime.loop.runTurn({ userMessage: "go" });
      expect(result.status).toBe("completed");
      expect(await readFile(join(workspaceRoot, "a.txt"), "utf8")).toBe(
        "HELLO WORLD\nline 1\nline two\n",
      );
    } finally {
      await runtime.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
    expect(step).toBe(5);
  }, 30_000);

  // 经真实 Runtime 执行 bash 工具：非零退出码仍是成功 payload，截断日志被创建并在 close 时清理。
  it("executes bash with non-zero exit code and cleans session logs on close", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "byte-mentor-runtime-bash-"));
    let step = 0;
    const provider = invokeProvider(async (request) => {
      if (step === 0) {
        step += 1;
        return toolCallResponse("bash", { command: "seq 1 2500; exit 3" });
      }
      expect(parseLastToolEnvelope(request)).toMatchObject({
        ok: true,
        data: { truncated: true, exitCode: 3 },
      });
      return {
        message: { role: "assistant", content: "bash done" },
        stopReason: "completed",
      };
    });
    const runtime = (await loadCreateRuntime())(
      createConfig({ initialMessage: "run bash", workspaceRoot }),
      { provider, sessionStore: new InMemorySessionStore() },
    );
    try {
      await runtime.loop.runTurn({ userMessage: "run bash" });
      const logs = (await readdir(tmpdir())).filter((name) =>
        name.startsWith("byte-mentor-bash-session-"),
      );
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      await runtime.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
    const remaining = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("byte-mentor-bash-session-"),
    );
    expect(remaining).toHaveLength(0);
  }, 30_000);

  // fake provider 逐步消费真实 ToolMessage，验证固定临时工作区内的浏览、查找、搜索和续读闭环。
  it("completes the workspace discovery and reading loop", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "byte-mentor-runtime-smoke-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(
      join(workspaceRoot, "src", "lesson.ts"),
      "export const needle = true;\nsecond line\n",
      "utf8",
    );
    let step = 0;
    const provider = invokeProvider(async (request) => {
      const previous = step === 0 ? undefined : parseLastToolEnvelope(request);
      switch (step) {
        case 0:
          step += 1;
          return toolCallResponse("list_directory", { path: "." });
        case 1:
          expect(previous).toMatchObject({
            ok: true,
            data: { entries: expect.arrayContaining([expect.objectContaining({ name: "src" })]) },
          });
          step += 1;
          return toolCallResponse("find_files", { path: ".", query: "lesson" });
        case 2:
          expect(previous).toMatchObject({
            ok: true,
            data: {
              matches: expect.arrayContaining([expect.objectContaining({ path: "src/lesson.ts" })]),
            },
          });
          step += 1;
          return toolCallResponse("search_text", { path: "src", query: "needle" });
        case 3:
          expect(previous).toMatchObject({
            ok: true,
            data: {
              matches: expect.arrayContaining([
                expect.objectContaining({ path: "src/lesson.ts", line: 1 }),
              ]),
            },
          });
          step += 1;
          return toolCallResponse("read_file", { path: "src/lesson.ts", lineLimit: 1 });
        case 4: {
          expect(previous).toMatchObject({
            ok: true,
            data: {
              content: "export const needle = true;\n",
              nextPosition: { line: 2, column: 1 },
            },
          });
          const nextPosition = previous?.data?.nextPosition as { line: number; column: number };
          step += 1;
          return toolCallResponse("read_file", {
            path: "src/lesson.ts",
            startLine: nextPosition.line,
            startColumn: nextPosition.column,
          });
        }
        default:
          expect(previous).toMatchObject({
            ok: true,
            data: { content: "second line\n", eof: true },
          });
          step += 1;
          return {
            message: { role: "assistant", content: "workspace inspected" },
            stopReason: "completed",
          };
      }
    });
    const sessionStore = new InMemorySessionStore();
    const runtime = (await loadCreateRuntime())(
      createConfig({ initialMessage: "inspect workspace", workspaceRoot }),
      { provider, sessionStore },
    );
    let result: Awaited<ReturnType<AgentLoop["runTurn"]>>;
    try {
      result = await runtime.loop.runTurn({ userMessage: "inspect workspace" });
    } finally {
      await runtime.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }

    expect(process.cwd()).not.toBe(workspaceRoot);
    expect(result.status).toBe("completed");
    expect(step).toBe(6);
    const toolMessages = result.newMessages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(5);
    expect(toolMessages.every((message) => JSON.parse(message.content).ok === true)).toBe(true);
  });

  // 工作区外路径和三类默认敏感路径必须全部经过真实 Runtime 返回 access_denied envelope。
  it("rejects workspace escapes and default denied paths", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "byte-mentor-runtime-denied-"));
    await mkdir(join(workspaceRoot, ".git"));
    await mkdir(join(workspaceRoot, ".byte-mentor"));
    await writeFile(join(workspaceRoot, ".env"), "TOKEN=secret\n", "utf8");
    await writeFile(join(workspaceRoot, ".git", "config"), "secret\n", "utf8");
    await writeFile(join(workspaceRoot, ".byte-mentor", "secret.txt"), "secret\n", "utf8");
    const paths = ["../outside.txt", ".env", ".git/config", ".byte-mentor/secret.txt"];
    const observedErrors: TestToolEnvelope[] = [];
    let step = 0;
    const provider = invokeProvider(async (request) => {
      if (step > 0) {
        observedErrors.push(parseLastToolEnvelope(request));
      }
      if (step < paths.length) {
        const path = paths[step] as string;
        step += 1;
        return toolCallResponse("read_file", { path });
      }
      return {
        message: { role: "assistant", content: "denials confirmed" },
        stopReason: "completed",
      };
    });
    const runtime = (await loadCreateRuntime())(
      createConfig({ initialMessage: "read denied files", workspaceRoot }),
      { provider, sessionStore: new InMemorySessionStore() },
    );
    try {
      await runtime.loop.runTurn({ userMessage: "read denied files" });
    } finally {
      await runtime.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }

    expect(observedErrors).toHaveLength(4);
    expect(observedErrors.every((result) => result.ok === false)).toBe(true);
    expect(observedErrors.map((result) => result.error?.code)).toEqual([
      "access_denied",
      "access_denied",
      "access_denied",
      "access_denied",
    ]);
  });
});

function createConfig(input: { initialMessage?: string; workspaceRoot?: string }): CliConfig {
  return {
    command: "chat",
    ...(input.initialMessage !== undefined ? { initialMessage: input.initialMessage } : {}),
    openaiApiKey: "sk-test",
    model: "gpt-test",
    dbPath: "/tmp/byte-mentor-test.sqlite",
    workspaceRoot: input.workspaceRoot ?? "/tmp/byte-mentor-workspace",
  };
}

function createViewRecorder(): {
  calls: Array<[string, ...unknown[]]>;
  port: ReturnType<NonNullable<RunChatDeps["createView"]>>;
} {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    port: {
      start: () => calls.push(["start"]),
      stop: () => calls.push(["stop"]),
      appendUserMessage: (text) => calls.push(["appendUserMessage", text]),
      beginAssistantMessage: () => calls.push(["beginAssistantMessage"]),
      appendAssistantDelta: (text) => calls.push(["appendAssistantDelta", text]),
      completeAssistantMessage: (content) => calls.push(["completeAssistantMessage", content]),
      addToolCall: (toolCall) => calls.push(["addToolCall", toolCall]),
      startToolCall: (id) => calls.push(["startToolCall", id]),
      completeToolCall: (id, output) => calls.push(["completeToolCall", id, output]),
      failToolCall: (id, message) => calls.push(["failToolCall", id, message]),
      cancelToolCall: (id, message) => calls.push(["cancelToolCall", id, message]),
      showError: (message) => calls.push(["showError", message]),
      setBusy: (busy) => calls.push(["setBusy", busy]),
      setSessionId: (sessionId) => calls.push(["setSessionId", sessionId]),
      setExitAfterTurn: (pending) => calls.push(["setExitAfterTurn", pending]),
    },
  };
}

async function loadCreateRuntime(): Promise<CreateRuntime> {
  const module = await import("../../apps/cli/src/run-chat.js");
  const createRuntime = (module as { createRuntime?: CreateRuntime }).createRuntime;
  expect(createRuntime).toBeTypeOf("function");
  if (createRuntime === undefined) {
    throw new Error("createRuntime is not exported");
  }
  return createRuntime;
}

function invokeProvider(
  invoke: (request: ProviderRequest) => Promise<ProviderResponse>,
): ModelProvider {
  return {
    invoke,
    async *invokeStream(request) {
      const response = await invoke(request);
      yield { type: "done", message: response.message, stopReason: response.stopReason };
    },
  };
}

function toolCallResponse(name: string, args: Record<string, unknown>): ProviderResponse {
  return {
    message: {
      role: "assistant",
      toolCalls: [{ id: createToolCallId(), name, args }],
    },
    stopReason: "tool_calls",
  };
}

function parseLastToolEnvelope(request: ProviderRequest): TestToolEnvelope {
  const message = request.messages.at(-1);
  if (message?.role !== "tool") {
    throw new Error("expected the previous ToolMessage at the end of the provider request");
  }
  return JSON.parse(message.content) as TestToolEnvelope;
}

function createOutput(): { io: RunChatIO; stdout(): string; stderr(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: {
        write(text) {
          stdout.push(text);
        },
      },
      stderr: {
        write(text) {
          stderr.push(text);
        },
      },
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

function completedTurn(content: string): HeadlessTurnResult {
  const finalMessage = {
    id: createMessageId(),
    role: "assistant" as const,
    content,
  };
  return {
    status: "completed",
    sessionId: createSessionId(),
    finalMessage,
    newMessages: [finalMessage],
    stopReason: "completed",
    events: [],
    trace: [],
  };
}
