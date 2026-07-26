import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface CliConfig {
  command: "chat";
  userMessage: string;
  openaiApiKey: string;
  model: string;
  openaiBaseURL?: string;
  dbPath: string;
  workspaceRoot: string;
}

export class CliConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliConfigError";
  }
}

export interface LoadCliConfigInput {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

// 解析一次启动输入并固定数据库路径与工作区根目录，供后续 Runtime 组装显式使用。
export function loadCliConfig(input: LoadCliConfigInput): CliConfig {
  const parsed = parseArgs({
    args: input.argv,
    allowPositionals: true,
    strict: false,
  });
  const [command, userMessage] = parsed.positionals;
  const openaiApiKey = input.env.OPENAI_API_KEY;
  const model = input.env.BYTE_MENTOR_MODEL;

  if (openaiApiKey === undefined || openaiApiKey.length === 0) {
    throw new CliConfigError("Missing required environment variable: OPENAI_API_KEY");
  }
  if (model === undefined || model.length === 0) {
    throw new CliConfigError("Missing required environment variable: BYTE_MENTOR_MODEL");
  }
  if (userMessage === undefined || userMessage.length === 0) {
    throw new CliConfigError('Usage: byte-mentor chat "<message>"');
  }

  const dbPath = resolveDbPath(input);

  mkdirSync(dirname(dbPath), { recursive: true });

  return {
    command: command as "chat",
    userMessage,
    openaiApiKey,
    model,
    ...(input.env.BYTE_MENTOR_OPENAI_BASE_URL !== undefined
      ? { openaiBaseURL: input.env.BYTE_MENTOR_OPENAI_BASE_URL }
      : {}),
    dbPath,
    workspaceRoot: input.cwd,
  };
}

function resolveDbPath(input: LoadCliConfigInput): string {
  const configuredPath = input.env.BYTE_MENTOR_DB_PATH;
  if (configuredPath === undefined) {
    return resolve(input.cwd, ".byte-mentor/byte-mentor.sqlite");
  }
  return isAbsolute(configuredPath) ? configuredPath : resolve(input.cwd, configuredPath);
}
