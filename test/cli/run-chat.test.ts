import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  it("streams completed content deltas to stdout in order", async () => {
    const config = createConfig({ userMessage: "解释一下 Promise" });
    const output = createOutput();
    const close = vi.fn(async () => undefined);
    const runTurn: AgentLoop["runTurn"] = async (input, options) => {
      expect(input).toEqual({ userMessage: "解释一下 Promise" });
      options?.onStreamEvent?.({ type: "content_delta", text: "Promise " });
      options?.onStreamEvent?.({ type: "content_delta", text: "代表一个" });
      options?.onStreamEvent?.({ type: "content_delta", text: "未来结果。" });
      return completedTurn("Promise 代表一个未来结果。");
    };
    const createLoop = vi.fn<NonNullable<RunChatDeps["createLoop"]>>(() => ({
      loop: { runTurn },
      close,
    }));

    const exitCode = await runChat(config, output.io, { createLoop });

    expect(exitCode).toBe(0);
    expect(createLoop).toHaveBeenCalledWith(config);
    expect(output.stdout()).toBe("Promise 代表一个未来结果。\n");
    expect(output.stderr()).toBe("");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports non-completed turns to stderr and closes the runtime", async () => {
    const config = createConfig({ userMessage: "继续解释" });
    const output = createOutput();
    const close = vi.fn(async () => undefined);
    const runTurn: AgentLoop["runTurn"] = async () =>
      failedTurn("provider request failed before final answer");
    const createLoop = vi.fn<NonNullable<RunChatDeps["createLoop"]>>(() => ({
      loop: { runTurn },
      close,
    }));

    const exitCode = await runChat(config, output.io, { createLoop });

    expect(exitCode).toBe(1);
    expect(output.stderr()).toMatch(/provider request failed before final answer/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the runtime when runTurn throws", async () => {
    const config = createConfig({ userMessage: "解释 async await" });
    const output = createOutput();
    const close = vi.fn(async () => undefined);
    const runTurn: AgentLoop["runTurn"] = async () => {
      throw new Error("OpenAI request failed");
    };
    const createLoop = vi.fn<NonNullable<RunChatDeps["createLoop"]>>(() => ({
      loop: { runTurn },
      close,
    }));

    const exitCode = await runChat(config, output.io, { createLoop });

    expect(exitCode).toBe(1);
    expect(output.stderr()).toMatch(/OpenAI request failed/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  // 真实 CLI 组装必须向首个模型请求暴露四个按名称排序的内置只读工具。
  it("assembles four sorted workspace tool definitions", async () => {
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
      createConfig({ userMessage: "inspect tools", workspaceRoot }),
      { provider, sessionStore: new InMemorySessionStore() },
    );
    try {
      await runtime.loop.runTurn({ userMessage: "inspect tools" });
    } finally {
      await runtime.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }

    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      "find_files",
      "list_directory",
      "read_file",
      "search_text",
    ]);
  });

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
      createConfig({ userMessage: "inspect workspace", workspaceRoot }),
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
      createConfig({ userMessage: "read denied files", workspaceRoot }),
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

function createConfig(input: { userMessage: string; workspaceRoot?: string }): CliConfig {
  return {
    command: "chat",
    userMessage: input.userMessage,
    openaiApiKey: "sk-test",
    model: "gpt-test",
    dbPath: "/tmp/byte-mentor-test.sqlite",
    workspaceRoot: input.workspaceRoot ?? "/tmp/byte-mentor-workspace",
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

function failedTurn(message: string): HeadlessTurnResult {
  return {
    status: "failed",
    sessionId: createSessionId(),
    error: { message },
    newMessages: [],
    stopReason: "failed",
    events: [],
    trace: [],
  };
}
