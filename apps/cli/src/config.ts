import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface CliConfig {
  command: "chat";
  initialMessage?: string;
  openaiApiKey: string;
  model: string;
  openaiBaseURL?: string;
  dbPath: string;
  workspaceRoot: string;
  bashPath?: string;
  bashEnvAllowlist?: string[];
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
  const [command, ...messageParts] = parsed.positionals;
  const openaiApiKey = input.env.OPENAI_API_KEY;
  const model = input.env.BYTE_MENTOR_MODEL;

  if (command !== "chat") {
    throw new CliConfigError("Usage: byte-mentor chat [message]");
  }

  if (openaiApiKey === undefined || openaiApiKey.length === 0) {
    throw new CliConfigError("Missing required environment variable: OPENAI_API_KEY");
  }
  if (model === undefined || model.length === 0) {
    throw new CliConfigError("Missing required environment variable: BYTE_MENTOR_MODEL");
  }
  const initialMessage = messageParts.join(" ").trim() || undefined;

  const dbPath = resolveDbPath(input);

  mkdirSync(dirname(dbPath), { recursive: true });

  return {
    command,
    ...(initialMessage !== undefined ? { initialMessage } : {}),
    openaiApiKey,
    model,
    ...(input.env.BYTE_MENTOR_OPENAI_BASE_URL !== undefined
      ? { openaiBaseURL: input.env.BYTE_MENTOR_OPENAI_BASE_URL }
      : {}),
    ...(input.env.BYTE_MENTOR_BASH_PATH !== undefined
      ? { bashPath: resolveBashPath(input.env.BYTE_MENTOR_BASH_PATH) }
      : {}),
    ...(input.env.BYTE_MENTOR_BASH_ENV_ALLOWLIST !== undefined
      ? { bashEnvAllowlist: resolveBashEnvAllowlist(input.env.BYTE_MENTOR_BASH_ENV_ALLOWLIST) }
      : {}),
    dbPath,
    workspaceRoot: input.cwd,
  };
}

// 解析可选显式 Bash 路径：变量只要已设置就必须是非空绝对路径，否则在启动前报配置错误。
function resolveBashPath(value: string): string {
  if (value.length === 0 || !isAbsolute(value)) {
    throw new CliConfigError("BYTE_MENTOR_BASH_PATH must be a non-empty absolute path when set");
  }
  return value;
}

// 解析逗号分隔的额外环境变量白名单：trim、删空、按首次出现去重并校验名称。
function resolveBashEnvAllowlist(value: string): string[] {
  const names: string[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim();
    if (name.length === 0) {
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new CliConfigError(`BYTE_MENTOR_BASH_ENV_ALLOWLIST contains invalid name: ${name}`);
    }
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function resolveDbPath(input: LoadCliConfigInput): string {
  const configuredPath = input.env.BYTE_MENTOR_DB_PATH;
  if (configuredPath === undefined) {
    return resolve(input.cwd, ".byte-mentor/byte-mentor.sqlite");
  }
  return isAbsolute(configuredPath) ? configuredPath : resolve(input.cwd, configuredPath);
}
