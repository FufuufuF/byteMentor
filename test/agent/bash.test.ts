import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBashTool,
  createShellEnvironment,
  resolveShellPath,
  ToolRegistry,
  WorkspaceAccessPolicy,
  WorkspaceEditor,
  WorkspaceReader,
} from "@byte-mentor/agent";
import type { AgentTool, ToolExecutionContext } from "@byte-mentor/agent";

const temporaryPaths = new Set<string>();

// 每个测试后删除它创建的临时工作区、日志目录与日志文件，避免文件系统状态跨用例泄漏。
afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  temporaryPaths.clear();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BashFixture {
  tool: AgentTool;
  context: ToolExecutionContext;
  registry: ToolRegistry;
  workspaceRoot: string;
  sessionTempDirectory: string;
}

// 组装真实 bash 工具与其执行 context：受控 shell 环境、临时工作区与日志目录。
async function createBashFixture(
  input: {
    maxResultCharacters?: number;
    shellPath?: string;
    runtimeCloseSignal?: AbortSignal;
  } = {},
): Promise<BashFixture> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "byte-mentor-bash-ws-"));
  const sessionTempDirectory = join(await mkdtemp(join(tmpdir(), "byte-mentor-bash-log-")), "logs");
  temporaryPaths.add(workspaceRoot);
  temporaryPaths.add(sessionTempDirectory);
  const policy = new WorkspaceAccessPolicy({
    ...(input.maxResultCharacters === undefined
      ? {}
      : { limits: { maxSerializedToolResultCharacters: input.maxResultCharacters } }),
  });
  const reader = new WorkspaceReader({ workspaceRoot, policy });
  const editor = new WorkspaceEditor({ workspaceRoot, policy });
  const shellPath = input.shellPath ?? resolveShellPath({ parentEnv: process.env });
  const shellEnv = createShellEnvironment({ parentEnv: process.env, allowlist: [], shellPath });
  const context: ToolExecutionContext = {
    workspaceReader: reader,
    workspaceEditor: editor,
    shell: { shellPath, shellEnv },
  };
  const tool = createBashTool({
    sessionTempDirectory,
    ...(input.runtimeCloseSignal ? { runtimeCloseSignal: input.runtimeCloseSignal } : {}),
  });
  const registry = new ToolRegistry({
    context,
    maxSerializedToolResultCharacters: policy.limits.maxSerializedToolResultCharacters,
  });
  registry.register(tool);
  return { tool, context, registry, workspaceRoot, sessionTempDirectory };
}

describe("bash 参数校验", () => {
  it("空或纯空白 command 返回 invalid_arguments", async () => {
    // 验证空白命令不启动进程，返回 invalid_arguments。
    const { tool, context } = await createBashFixture();
    expect(await tool.execute({ command: "" }, context)).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(await tool.execute({ command: "   \n\t " }, context)).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });

  it("command 超过 32768 Unicode 字符上限返回 invalid_arguments", async () => {
    // 验证协议硬上限：超长 command 不启动进程。
    const { tool, context } = await createBashFixture();
    const result = await tool.execute({ command: "x".repeat(32_769) }, context);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  it("非法 timeout（0、负数、NaN、超过上限）返回 invalid_arguments", async () => {
    // 验证 timeout 必须是有限正数且不超过 2147483.647 秒。
    const { tool, context } = await createBashFixture();
    for (const timeout of [0, -1, Number.NaN, 2_147_483.648, Number.POSITIVE_INFINITY]) {
      expect(await tool.execute({ command: ":", timeout }, context)).toMatchObject({
        ok: false,
        error: { code: "invalid_arguments" },
      });
    }
  });

  it("合法 timeout 边界值可执行", async () => {
    // 验证 1 秒与协议上限秒数都能通过校验并执行。
    const { tool, context } = await createBashFixture();
    expect(await tool.execute({ command: ":", timeout: 1 }, context)).toMatchObject({ ok: true });
    expect(await tool.execute({ command: ":", timeout: 2_147_483.647 }, context)).toMatchObject({
      ok: true,
    });
  });

  it("未知字段经 schema 校验返回 invalid_arguments", async () => {
    // 验证 additionalProperties: false 拒绝额外参数，不暴露 cwd/env。
    const { registry } = await createBashFixture();
    const output = await registry.execute("bash", { command: ":", cwd: "/tmp", env: {} });
    expect(output.result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });
});

describe("bash 成功执行", () => {
  it("零退出码返回结构化成功 payload", async () => {
    // 验证 echo 的 stdout 进入 output，exitCode 原样返回。
    const { tool, context } = await createBashFixture();
    const result = await tool.execute({ command: "echo hello" }, context);
    expect(result).toEqual({
      ok: true,
      data: { command: "echo hello", exitCode: 0, output: "hello\n", truncated: false },
    });
  });

  it("非零退出码仍是成功 ToolResult", async () => {
    // 验证命令失败（exit 3）不转换为 ok:false，模型可据 exitCode 判断下一步。
    const { tool, context } = await createBashFixture();
    const result = await tool.execute({ command: "exit 3" }, context);
    expect(result).toMatchObject({
      ok: true,
      data: { command: "exit 3", exitCode: 3, truncated: false },
    });
  });

  it("无输出命令返回空字符串", async () => {
    // 验证无输出命令 output 为空字符串，不使用自然语言占位符。
    const { tool, context } = await createBashFixture();
    const result = await tool.execute({ command: ":" }, context);
    expect(result).toMatchObject({ ok: true, data: { output: "", exitCode: 0 } });
  });

  it("stdout 与 stderr 合并到 output", async () => {
    // 验证双流输出按到达顺序合并进 output。
    const { tool, context } = await createBashFixture();
    const result = await tool.execute({ command: "echo out; echo err >&2" }, context);
    expect(result).toMatchObject({ ok: true, data: { output: "out\nerr\n" } });
  });

  it("cwd 固定为工作区根目录", async () => {
    // 验证命令在 workspaceRoot 下执行，pwd 输出与工作区的真实路径一致。
    const { tool, context, workspaceRoot } = await createBashFixture();
    const result = await tool.execute({ command: "pwd" }, context);
    expect(result).toMatchObject({ ok: true, data: { exitCode: 0 } });
    if (result.ok) {
      const output = (result.data as { output: string }).output;
      const resolvedRoot = (await realpath(workspaceRoot)).replace(/\/+$/, "");
      expect(output.trim()).toBe(resolvedRoot);
    }
  });

  it("命令原字符串保留执行（前后空白不 trim）", async () => {
    // 验证空白判断不改变实际传给 Bash 的 command 原字符串。
    const { tool, context } = await createBashFixture();
    const result = await tool.execute({ command: "  echo ok  " }, context);
    expect(result).toMatchObject({ ok: true, data: { output: "ok\n" } });
  });
});

describe("bash 终止语义", () => {
  it("外部 signal 终止返回 execution_failed 并保留 signal 与输出", async () => {
    // 验证命令被外部 SIGTERM 杀死时不虚构 128+signal，details 保留 signal 名称。
    const { tool, context } = await createBashFixture();
    const result = await tool.execute({ command: "echo before; kill -TERM $$" }, context);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "execution_failed",
        details: { signal: "SIGTERM", output: "before\n" },
      },
    });
  });

  it("timeout 到期返回 command_timed_out", async () => {
    // 验证超过 timeout 秒数时进程树被终止，返回 command_timed_out。
    const { tool, context } = await createBashFixture();
    const result = await tool.execute({ command: "sleep 5", timeout: 0.05 }, context);
    expect(result).toMatchObject({ ok: false, error: { code: "command_timed_out" } });
  }, 15_000);

  it("turn 取消已启动进程返回 command_cancelled cancelledBy turn", async () => {
    // 验证已启动 Bash 被 turn 取消时返回 command_cancelled 并标注来源。
    const { tool, context } = await createBashFixture();
    const controller = new AbortController();
    const pending = tool.execute({ command: "sleep 5" }, context, { signal: controller.signal });
    await delay(30);
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "command_cancelled", details: { cancelledBy: "turn" } },
    });
  }, 15_000);

  it("runtime close 取消返回 command_cancelled cancelledBy runtime", async () => {
    // 验证 Runtime 关闭时通过 runtimeCloseSignal 终止已启动 Bash。
    const closeController = new AbortController();
    const { tool, context } = await createBashFixture({
      runtimeCloseSignal: closeController.signal,
    });
    const pending = tool.execute({ command: "sleep 5" }, context);
    await delay(30);
    closeController.abort();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "command_cancelled", details: { cancelledBy: "runtime" } },
    });
  }, 15_000);

  it("shell 不可用返回 shell_unavailable", async () => {
    // 验证显式配置的 Bash 路径不可用时返回 shell_unavailable，不启动进程。
    const missingShell = join(tmpdir(), `byte-mentor-missing-bash-${Date.now()}`);
    const { tool, context, workspaceRoot } = await createBashFixture();
    const result = await tool.execute(
      { command: "echo hi" },
      { ...context, shell: { shellPath: missingShell, shellEnv: {} } },
    );
    void workspaceRoot;
    expect(result).toMatchObject({ ok: false, error: { code: "shell_unavailable" } });
  });

  it("未配置 shell context 返回 execution_failed", async () => {
    // 验证缺少 shell context 时 bash 不执行，返回 execution_failed。
    const { tool, workspaceRoot } = await createBashFixture();
    const policy = new WorkspaceAccessPolicy();
    const reader = new WorkspaceReader({ workspaceRoot, policy });
    const editor = new WorkspaceEditor({ workspaceRoot, policy });
    const result = await tool.execute(
      { command: "echo hi" },
      { workspaceReader: reader, workspaceEditor: editor },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "execution_failed" } });
  });
});

describe("bash 结果预算与完整日志", () => {
  it("固定字段已超预算时返回 resource_limit 且不启动进程", async () => {
    // 验证 spawn 前预检：command 与最小成功 payload 已无法放入预算时拒绝执行。
    const { tool, context } = await createBashFixture({ maxResultCharacters: 200 });
    const result = await tool.execute({ command: "x".repeat(300) }, context);
    expect(result).toMatchObject({ ok: false, error: { code: "resource_limit" } });
  });

  it("超过 2000 行触发行截断并生成完整日志", async () => {
    // 验证超限时返回尾部与完整日志路径，日志文件包含命令开始后的全部输出。
    const { tool, context } = await createBashFixture();
    const result = await tool.execute({ command: "seq 1 2500" }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const data = result.data as {
      truncated: boolean;
      truncation: { truncatedBy: string; totalLines: number; returnedLines: number };
      fullOutputPath: string;
    };
    expect(data.truncated).toBe(true);
    expect(data.truncation).toEqual({
      truncatedBy: "lines",
      totalLines: 2500,
      returnedLines: 2000,
    });
    expect(data.fullOutputPath).toBeTypeOf("string");
    const log = await readFile(data.fullOutputPath, "utf-8");
    expect(log.startsWith("1\n")).toBe(true);
    expect(log.includes("2500\n")).toBe(true);
  }, 20_000);

  it("序列化预算截断标记 truncatedBy output_limit", async () => {
    // 验证输出超序列化预算时按 output_limit 截断并保留尾部。
    const { tool, context } = await createBashFixture({ maxResultCharacters: 600 });
    const result = await tool.execute({ command: "seq 1 300" }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const data = result.data as { truncated: boolean; truncation?: { truncatedBy: string } };
    expect(data.truncated).toBe(true);
    expect(data.truncation?.truncatedBy).toBe("output_limit");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(600);
  }, 20_000);

  it("未截断时不创建完整日志目录", async () => {
    // 验证未发生截断时懒日志目录不存在，不暴露 fullOutputPath。
    const { tool, context, sessionTempDirectory } = await createBashFixture();
    const result = await tool.execute({ command: "echo hi" }, context);
    expect(result).toMatchObject({ ok: true, data: { truncated: false } });
    await expect(access(sessionTempDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("截断结果序列化长度不超过 Registry 预算", async () => {
    // 验证含完整路径与截断元数据时最终 ToolResult 仍遵守预算。
    const { tool, context } = await createBashFixture({ maxResultCharacters: 800 });
    const result = await tool.execute({ command: "seq 1 400" }, context);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(800);
  }, 20_000);
});
