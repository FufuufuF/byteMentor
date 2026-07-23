import { createMessageId, createSessionId } from "@byte-mentor/core";
import type { AgentLoop, HeadlessTurnResult } from "@byte-mentor/agent";
import { describe, expect, it, vi } from "vitest";
import type { CliConfig } from "../../apps/cli/src/config.js";
import { runChat, type RunChatDeps, type RunChatIO } from "../../apps/cli/src/run-chat.js";

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
});

function createConfig(input: { userMessage: string }): CliConfig {
  return {
    command: "chat",
    userMessage: input.userMessage,
    openaiApiKey: "sk-test",
    model: "gpt-test",
    dbPath: "/tmp/byte-mentor-test.sqlite",
  };
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
