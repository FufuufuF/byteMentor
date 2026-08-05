import type { AgentTool, JsonObject, ToolErrorCode, ToolResult } from "../contracts.js";
import { ShellLogError, ShellLogStore } from "../shell/shell-log-store.js";
import {
  computeShellTail,
  PROTOCOL_MAX_SHELL_LINES,
  ShellOutputAccumulator,
} from "../shell/shell-output.js";
import { resolveShellPath } from "../shell/shell-environment.js";
import { runCommand } from "../shell/shell-executor.js";

const PROTOCOL_MAX_COMMAND_CHARACTERS = 32_768;
const PROTOCOL_MAX_TIMEOUT_SECONDS = 2_147_483.647;

interface BashArguments {
  command: string;
  timeout?: number;
}

const parametersJsonSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      minLength: 1,
      description:
        'A shell command to run in the workspace root. Use one command for multi-step work, e.g. "cd packages/agent && pnpm test".',
    },
    timeout: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: PROTOCOL_MAX_TIMEOUT_SECONDS,
      description:
        "Optional timeout in seconds after which the command is terminated. Omit for no default timeout.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

export interface CreateBashToolInput {
  /** 完整输出日志所属的 session 临时目录，由 Runtime 持有并在 close 时清理。 */
  sessionTempDirectory: string;
  runtimeCloseSignal?: AbortSignal;
}

// 组装模型可调用的 bash 工具：薄适配层，把 ShellExecutor 生命周期与输出组件组合成
// 结构化 ToolResult，进程与输出细节不回流 Registry。
export function createBashTool(input: CreateBashToolInput): AgentTool {
  return {
    name: "bash",
    description: [
      "Use when: You need to run a shell command in the workspace, e.g. tests, builds, or inspecting files beyond workspace tools.",
      "Commands run as a single disposable non-interactive Bash in the workspace root; shell state does not persist between calls.",
      "A non-zero exit code is a normal command result, not a tool failure.",
    ].join("\n"),
    parametersJsonSchema,

    async execute(args, context, options): Promise<ToolResult> {
      const shell = context.shell;
      if (shell === undefined) {
        return {
          ok: false,
          error: { code: "execution_failed", message: "bash shell context is not configured" },
        };
      }
      const inputArgs = args as BashArguments;
      const invalidMessage = validateBashArguments(inputArgs);
      if (invalidMessage !== undefined) {
        return { ok: false, error: { code: "invalid_arguments", message: invalidMessage } };
      }
      if (options?.signal?.aborted) {
        return {
          ok: false,
          error: {
            code: "command_cancelled",
            message: "bash command cancelled before start",
            details: { cancelledBy: "turn" },
          },
        };
      }

      const maxResultCharacters =
        context.workspaceReader.policy.limits.maxSerializedToolResultCharacters;
      // 用 command 与最小成功 payload 预检序列化大小；固定字段已超预算时不启动进程。
      const minimalPayload = JSON.stringify({
        ok: true,
        data: { command: inputArgs.command, exitCode: 0, output: "", truncated: false },
      });
      if (minimalPayload.length > maxResultCharacters) {
        return {
          ok: false,
          error: {
            code: "resource_limit",
            message: "bash result exceeds the serialized tool result limit",
          },
        };
      }

      // 每次执行前确认显式配置的 Bash 仍可用，不可用时返回 shell_unavailable。
      let shellPath: string;
      try {
        shellPath = resolveShellPath({
          parentEnv: process.env,
          explicitShellPath: shell.shellPath,
        });
      } catch {
        return {
          ok: false,
          error: { code: "shell_unavailable", message: "bash shell is unavailable" },
        };
      }

      const accumulator = new ShellOutputAccumulator({ maxLines: PROTOCOL_MAX_SHELL_LINES });
      let logStore: ShellLogStore | undefined;
      let logged = false;

      const exit = await runCommand({
        command: inputArgs.command,
        cwd: context.workspaceReader.workspaceRoot,
        env: shell.shellEnv,
        shellPath,
        timeoutMs:
          inputArgs.timeout === undefined ? undefined : Math.round(inputArgs.timeout * 1000),
        turnSignal: options?.signal,
        runtimeCloseSignal: input.runtimeCloseSignal,
        onChunk: async (chunk) => {
          const cleaned = accumulator.push(chunk);
          // 首次超过任一返回限制时懒创建完整日志并补写此前的全部已清理文本，后续追加。
          if (
            !logged &&
            (accumulator.totalLines() > PROTOCOL_MAX_SHELL_LINES ||
              accumulator.tailText().length > maxResultCharacters)
          ) {
            logged = true;
            logStore = new ShellLogStore({ sessionTempDirectory: input.sessionTempDirectory });
            const result = await logStore.backfill(accumulator.extractFullText());
            if (result.limitReached) {
              throw new ShellLogError("shell log size limit reached");
            }
          } else if (logged && cleaned.length > 0) {
            const result = await logStore!.append(cleaned);
            if (result.limitReached) {
              throw new ShellLogError("shell log size limit reached");
            }
          }
        },
      });

      const fullOutputPath = logged ? await logStore!.fullOutputPath() : undefined;
      const tail = computeShellTail({
        text: logged ? accumulator.tailText() : accumulator.text(),
        totalLines: accumulator.totalLines(),
        fields: {
          command: inputArgs.command,
          exitCode: exit.kind === "exit" ? exit.exitCode : null,
          ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
        },
        maxLines: PROTOCOL_MAX_SHELL_LINES,
        maxSerializedCharacters: maxResultCharacters,
      });

      const successPayload: JsonObject = {
        command: inputArgs.command,
        exitCode: exit.kind === "exit" ? exit.exitCode : null,
        output: tail.output,
        truncated: tail.truncated,
        ...(tail.truncation === undefined ? {} : { truncation: tail.truncation }),
        ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
      };

      if (exit.kind === "exit") {
        return { ok: true, data: successPayload };
      }
      if (exit.kind === "signal") {
        return errorResult(
          "execution_failed",
          `bash command terminated by signal ${exit.signal}`,
          { signal: exit.signal },
          successPayload,
        );
      }
      if (exit.kind === "killed" && exit.reason === "timeout") {
        return errorResult("command_timed_out", "bash command timed out", {}, successPayload);
      }
      if (exit.kind === "killed") {
        return errorResult(
          "command_cancelled",
          "bash command cancelled",
          { cancelledBy: exit.reason },
          successPayload,
        );
      }
      // 输出消费失败（完整日志超限或写入失败）：终止路径已完成，返回 resource_limit。
      return errorResult(
        "resource_limit",
        "bash output exceeded capture limits",
        {},
        successPayload,
      );
    },
  };
}

// 组装稳定错误结果：保留终止前输出、截断信息与完整日志路径，遵守 Registry 序列化预算。
function errorResult(
  code: ToolErrorCode,
  message: string,
  extra: JsonObject,
  successPayload: JsonObject,
): ToolResult {
  return {
    ok: false,
    error: {
      code,
      message,
      details: {
        ...extra,
        output: successPayload.output,
        truncated: successPayload.truncated,
        ...(successPayload.truncation === undefined
          ? {}
          : { truncation: successPayload.truncation }),
        ...(successPayload.fullOutputPath === undefined
          ? {}
          : { fullOutputPath: successPayload.fullOutputPath }),
      },
    },
  };
}

// 校验协议硬上限：command 非空白且最多 32,768 个 Unicode 字符，timeout 为有限正秒数。
function validateBashArguments(input: BashArguments): string | undefined {
  if (typeof input.command !== "string" || input.command.trim().length === 0) {
    return "command must be a non-empty shell command string";
  }
  if (Array.from(input.command).length > PROTOCOL_MAX_COMMAND_CHARACTERS) {
    return `command must not exceed ${PROTOCOL_MAX_COMMAND_CHARACTERS} Unicode characters`;
  }
  if (input.timeout !== undefined) {
    if (
      typeof input.timeout !== "number" ||
      !Number.isFinite(input.timeout) ||
      input.timeout <= 0 ||
      input.timeout > PROTOCOL_MAX_TIMEOUT_SECONDS
    ) {
      return `timeout must be a finite positive number up to ${PROTOCOL_MAX_TIMEOUT_SECONDS} seconds`;
    }
  }
  return undefined;
}
