import { describe, expect, it, vi } from "vitest";
import { CliConfigError, type CliConfig } from "../../apps/cli/src/config.js";
import { main, type CliMainDeps, type CliMainProcess } from "../../apps/cli/src/index.js";
import type { RunChatIO } from "../../apps/cli/src/run-chat.js";

describe("CLI main", () => {
  it("loads config from process input and delegates to runChat", async () => {
    const output = createOutput();
    const env = {
      OPENAI_API_KEY: "sk-test",
      BYTE_MENTOR_MODEL: "gpt-test",
    };
    const processLike: CliMainProcess = {
      argv: ["/usr/local/bin/node", "/repo/apps/cli/dist/index.js", "chat", "hello"],
      env,
      cwd: () => "/repo",
      stdout: output.io.stdout,
      stderr: output.io.stderr,
    };
    const config = createConfig({ userMessage: "hello" });
    const loadConfig = vi.fn<NonNullable<CliMainDeps["loadConfig"]>>(() => config);
    const runChat = vi.fn<NonNullable<CliMainDeps["runChat"]>>(async () => 0);

    await main(processLike, { loadConfig, runChat });

    expect(loadConfig).toHaveBeenCalledWith({
      argv: ["chat", "hello"],
      env,
      cwd: "/repo",
    });
    expect(runChat).toHaveBeenCalledWith(config, {
      stdout: processLike.stdout,
      stderr: processLike.stderr,
    });
    expect(processLike.exitCode).toBe(0);
    expect(output.stderr()).toBe("");
  });

  it("prints config errors and skips runChat", async () => {
    const output = createOutput();
    const processLike: CliMainProcess = {
      argv: ["/usr/local/bin/node", "/repo/apps/cli/dist/index.js", "chat"],
      env: {},
      cwd: () => "/repo",
      stdout: output.io.stdout,
      stderr: output.io.stderr,
    };
    const loadConfig = vi.fn<NonNullable<CliMainDeps["loadConfig"]>>(() => {
      throw new CliConfigError('Usage: byte-mentor chat "<message>"');
    });
    const runChat = vi.fn<NonNullable<CliMainDeps["runChat"]>>(async () => 0);

    await main(processLike, { loadConfig, runChat });

    expect(runChat).not.toHaveBeenCalled();
    expect(processLike.exitCode).toBe(1);
    expect(output.stderr()).toMatch(/Usage: byte-mentor chat "<message>"/);
  });
});

function createConfig(input: { userMessage: string }): CliConfig {
  return {
    command: "chat",
    userMessage: input.userMessage,
    openaiApiKey: "sk-test",
    model: "gpt-test",
    dbPath: "/tmp/byte-mentor-test.sqlite",
    workspaceRoot: "/tmp/byte-mentor-workspace",
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
