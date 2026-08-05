import { constants } from "node:fs";
import { accessSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type ShellErrorCode = "shell_unavailable";

// 环境/执行器层稳定错误；Batch 6 的 bash.ts 直接映射为 ToolResult.error。
export class ShellError extends Error {
  readonly code: ShellErrorCode;

  constructor(code: ShellErrorCode, message: string) {
    super(message);
    this.name = "ShellError";
    this.code = code;
  }
}

// 传给 Bash 的基础变量集合；LC_* locale 变量在下方单独枚举。
const BASE_ENV_VARIABLES = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"] as const;

// 固定 denylist：即使出现在用户白名单中也不得传给子进程，降低凭据泄漏与行为污染。
const DENYLISTED_ENV_VARIABLES = new Set<string>([
  "OPENAI_API_KEY",
  "PWD",
  "OLDPWD",
  "BASH_ENV",
  "ENV",
  "CDPATH",
  "PROMPT_COMMAND",
]);

// Runtime 固定写入子进程环境的值，最后覆盖白名单与父进程同名变量。
const FIXED_ENV_VALUES: Readonly<Record<string, string>> = {
  TERM: "dumb",
  NO_COLOR: "1",
};

// 默认 Bash 候选路径；不可用时才通过受控 PATH 查找 bash，不降级到 sh。
const DEFAULT_BASH_PATH = "/bin/bash";

export interface ResolveShellPathInput {
  parentEnv: NodeJS.ProcessEnv;
  explicitShellPath?: string;
  defaultShellPath?: string;
}

// 按「显式配置 → 默认路径 → 受控 PATH 查找」选出可用 Bash 绝对路径，绝不降级到 sh。
// 显式配置只要不可用就立即报错、不悄悄回退；默认路径"存在但不可用"同样报错，仅"不存在"才走 PATH 查找。
export function resolveShellPath(input: ResolveShellPathInput): string {
  if (input.explicitShellPath !== undefined) {
    if (!isAbsolute(input.explicitShellPath)) {
      throw new ShellError("shell_unavailable", "explicit shell path must be an absolute path");
    }
    if (!isUsableShell(input.explicitShellPath)) {
      throw new ShellError(
        "shell_unavailable",
        `explicit shell path is not usable: ${input.explicitShellPath}`,
      );
    }
    return input.explicitShellPath;
  }

  const defaultPath = input.defaultShellPath ?? DEFAULT_BASH_PATH;
  if (pathExists(defaultPath)) {
    if (!isUsableShell(defaultPath)) {
      throw new ShellError("shell_unavailable", `default shell path is not usable: ${defaultPath}`);
    }
    return defaultPath;
  }
  for (const entry of (input.parentEnv.PATH ?? "").split(":")) {
    if (entry.length > 0) {
      const candidate = join(entry, "bash");
      if (isUsableShell(candidate)) {
        return candidate;
      }
    }
  }
  throw new ShellError("shell_unavailable", "no usable bash executable found");
}

// 判断路径是否真实存在（包括目录、链接等），用于区分「不存在可回退」与「存在但不可用须报错」。
function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

// 校验候选路径存在、是普通文件且对当前用户可执行；任一不满足即不可用。
function isUsableShell(path: string): boolean {
  try {
    const metadata = statSync(path);
    if (!metadata.isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CreateShellEnvironmentInput {
  parentEnv: NodeJS.ProcessEnv;
  allowlist: readonly string[];
  shellPath: string;
}

// 按「基础变量 → 用户白名单（denylist 优先）→ Runtime 固定值」构造传给 Bash 的环境。
export function createShellEnvironment(input: CreateShellEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BASE_ENV_VARIABLES) {
    copyIfPresent(env, input.parentEnv, name);
  }
  for (const [name, value] of Object.entries(input.parentEnv)) {
    if (name.startsWith("LC_") && typeof value === "string") {
      env[name] = value;
    }
  }
  for (const name of input.allowlist) {
    if (isDeniedVariable(name)) {
      continue;
    }
    copyIfPresent(env, input.parentEnv, name);
  }
  env.SHELL = input.shellPath;
  for (const [name, value] of Object.entries(FIXED_ENV_VALUES)) {
    env[name] = value;
  }
  return env;
}

// 白名单阶段跳过固定 denylist 变量与所有 BYTE_MENTOR_ 前缀变量。
function isDeniedVariable(name: string): boolean {
  return name.startsWith("BYTE_MENTOR_") || DENYLISTED_ENV_VARIABLES.has(name);
}

// 仅复制父进程中实际存在的变量，缺失时不写入空值占位。
function copyIfPresent(
  env: Record<string, string>,
  parentEnv: NodeJS.ProcessEnv,
  name: string,
): void {
  const value = parentEnv[name];
  if (typeof value === "string") {
    env[name] = value;
  }
}
