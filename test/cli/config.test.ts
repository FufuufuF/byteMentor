import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CliConfigError, loadCliConfig } from "../../apps/cli/src/config.js";

interface ConfigTestInput {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd: string;
}

function loadConfig(input: ConfigTestInput) {
  return loadCliConfig({
    argv: input.argv ?? ["chat", "解释一下 Promise"],
    env: {
      OPENAI_API_KEY: "sk-test",
      BYTE_MENTOR_MODEL: "gpt-test",
      BYTE_MENTOR_DB_PATH: join(input.cwd, "byte-mentor.sqlite"),
      ...input.env,
    },
    cwd: input.cwd,
  });
}

describe("loadCliConfig", () => {
  // 启动目录既决定默认数据库位置，也会被原样保留为后续只读工具的固定工作区根目录。
  it("parses chat command and required env", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "byte-mentor-config-"));
    const dbPath = join(cwd, "byte-mentor.sqlite");

    const config = loadCliConfig({
      argv: ["chat", "解释一下 Promise"],
      env: {
        OPENAI_API_KEY: "sk-test",
        BYTE_MENTOR_MODEL: "gpt-test",
        BYTE_MENTOR_OPENAI_BASE_URL: "https://example.test/v1",
        BYTE_MENTOR_DB_PATH: dbPath,
      },
      cwd,
    });

    expect(config).toEqual({
      command: "chat",
      userMessage: "解释一下 Promise",
      openaiApiKey: "sk-test",
      model: "gpt-test",
      openaiBaseURL: "https://example.test/v1",
      dbPath,
      workspaceRoot: cwd,
    });
  });

  it("reports clear config errors without leaking secrets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "byte-mentor-config-"));

    expect(() =>
      loadConfig({
        cwd,
        env: { OPENAI_API_KEY: undefined },
      }),
    ).toThrowError(CliConfigError);
    expect(() =>
      loadConfig({
        cwd,
        env: { OPENAI_API_KEY: undefined },
      }),
    ).toThrow(/OPENAI_API_KEY/);

    expect(() =>
      loadConfig({
        cwd,
        env: { BYTE_MENTOR_MODEL: undefined },
      }),
    ).toThrow(/BYTE_MENTOR_MODEL/);

    expect(() =>
      loadConfig({
        cwd,
        argv: ["chat"],
        env: { OPENAI_API_KEY: "sk-secret-value" },
      }),
    ).toThrow(/usage/i);
    expect(() =>
      loadConfig({
        cwd,
        argv: ["chat"],
        env: { OPENAI_API_KEY: "sk-secret-value" },
      }),
    ).not.toThrow(/sk-secret-value/);
  });

  it("resolves db path and creates its directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "byte-mentor-config-"));
    const defaultConfig = loadCliConfig({
      argv: ["chat", "hello"],
      env: {
        OPENAI_API_KEY: "sk-test",
        BYTE_MENTOR_MODEL: "gpt-test",
      },
      cwd,
    });

    expect(defaultConfig.dbPath).toBe(join(cwd, ".byte-mentor", "byte-mentor.sqlite"));
    expect((await stat(join(cwd, ".byte-mentor"))).isDirectory()).toBe(true);

    const relativeConfig = loadConfig({
      cwd,
      env: { BYTE_MENTOR_DB_PATH: "data/session.sqlite" },
    });

    expect(relativeConfig.dbPath).toBe(join(cwd, "data", "session.sqlite"));
    expect((await stat(join(cwd, "data"))).isDirectory()).toBe(true);

    const absoluteDbPath = join(cwd, "absolute", "session.sqlite");
    const absoluteConfig = loadConfig({
      cwd,
      env: { BYTE_MENTOR_DB_PATH: absoluteDbPath },
    });

    expect(absoluteConfig.dbPath).toBe(absoluteDbPath);
    expect((await stat(join(cwd, "absolute"))).isDirectory()).toBe(true);
  });
});
