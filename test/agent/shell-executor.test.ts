import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellEnvironment, resolveShellPath, runCommand } from "@byte-mentor/agent";
import type { ShellChunk, ShellChunkConsumer } from "@byte-mentor/agent";

// 通过公共入口解析本机可用的 Bash 路径，供所有真实子进程用例使用。
const shellPath = resolveShellPath({ parentEnv: process.env });

// 构造传给子进程的受控环境：基础集合 + 空白名单 + 固定值。
const shellEnv = createShellEnvironment({ parentEnv: process.env, allowlist: [], shellPath });

const temporaryPaths = new Set<string>();

// 每个测试后删除它创建的临时工作目录，避免文件系统状态跨用例泄漏。
afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  temporaryPaths.clear();
});

async function createCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "byte-mentor-exec-test-"));
  temporaryPaths.add(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 创建按到达顺序收集 chunk 的 consumer 与收集器，供输出断言使用。
function collectChunks(): { chunks: ShellChunk[]; consumer: ShellChunkConsumer } {
  const chunks: ShellChunk[] = [];
  return {
    chunks,
    consumer: async (chunk) => {
      chunks.push(chunk);
    },
  };
}

// 按单调 seq 排序后拼接全部 chunk 的原始字节，还原父进程观察到的合并输出。
function joinedText(chunks: ShellChunk[]): string {
  const sorted = [...chunks].sort((a, b) => a.seq - b.seq);
  return Buffer.concat(sorted.map((chunk) => chunk.data)).toString("utf-8");
}

// 轮询等待一个进程退出（发送 0 信号得到 ESRCH 即已终止），超时则失败。
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
    }
    await delay(25);
  }
  throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
}

describe("runCommand 自然退出", () => {
  it("捕获 stdout 并返回自然退出码", async () => {
    // 验证 echo 命令的 stdout 以原始 Buffer 送达，chunk.stream 为 stdout，结果 exitCode 0。
    const cwd = await createCwd();
    const { chunks, consumer } = collectChunks();
    const exit = await runCommand({
      command: "echo hello",
      cwd,
      env: shellEnv,
      shellPath,
      onChunk: consumer,
    });
    expect(exit).toEqual({ kind: "exit", exitCode: 0, signal: null });
    expect(chunks.every((chunk) => chunk.stream === "stdout")).toBe(true);
    expect(joinedText(chunks)).toBe("hello\n");
  });

  it("stderr 与 stdout 分离成不同 stream", async () => {
    // 验证 `echo err >&2` 的 chunk.stream 为 stderr，内容不混入 stdout。
    const cwd = await createCwd();
    const { chunks, consumer } = collectChunks();
    await runCommand({ command: "echo err >&2", cwd, env: shellEnv, shellPath, onChunk: consumer });
    expect(chunks.every((chunk) => chunk.stream === "stderr")).toBe(true);
    expect(joinedText(chunks)).toBe("err\n");
  });

  it("双流 chunk 的 seq 全局单调递增", async () => {
    // 验证 stdout/stderr 交错时 seq 仍为全局单调序号，供 Batch 5 按序合并。
    const cwd = await createCwd();
    const { chunks, consumer } = collectChunks();
    await runCommand({
      command: "echo out; echo err >&2; echo out2",
      cwd,
      env: shellEnv,
      shellPath,
      onChunk: consumer,
    });
    const seqs = chunks.map((chunk) => chunk.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(chunks.some((chunk) => chunk.stream === "stdout")).toBe(true);
    expect(chunks.some((chunk) => chunk.stream === "stderr")).toBe(true);
  });

  it("非零退出码仍为自然退出", async () => {
    // 验证 `exit 3` 返回 {kind:"exit", exitCode:3}，命令失败不视为执行器错误。
    const cwd = await createCwd();
    const exit = await runCommand({ command: "exit 3", cwd, env: shellEnv, shellPath });
    expect(exit).toEqual({ kind: "exit", exitCode: 3, signal: null });
  });

  it("无输出命令不产生任何 chunk", async () => {
    // 验证无输出的命令（:）不产生 chunk，返回 exitCode 0，输出为空而非占位符。
    const cwd = await createCwd();
    const { chunks, consumer } = collectChunks();
    const exit = await runCommand({
      command: ":",
      cwd,
      env: shellEnv,
      shellPath,
      onChunk: consumer,
    });
    expect(exit).toEqual({ kind: "exit", exitCode: 0, signal: null });
    expect(chunks).toHaveLength(0);
  });

  it("多行输出按原始顺序保留换行", async () => {
    // 验证多行命令输出保留换行字符且顺序正确，为后续行计数与尾部保留打基础。
    const cwd = await createCwd();
    const { chunks, consumer } = collectChunks();
    await runCommand({
      command: "printf 'line1\\nline2\\n'",
      cwd,
      env: shellEnv,
      shellPath,
      onChunk: consumer,
    });
    expect(joinedText(chunks)).toBe("line1\nline2\n");
  });

  it("cwd 固定为传入的工作目录", async () => {
    // 验证 runCommand 以显式传入的 cwd 启动 Bash，pwd 输出与 cwd 的真实路径一致。
    const cwd = await createCwd();
    const { chunks, consumer } = collectChunks();
    await runCommand({ command: "pwd", cwd, env: shellEnv, shellPath, onChunk: consumer });
    // macOS 的 /var 是指向 /private/var 的链接，pwd 返回内核解析后的物理路径。
    expect(joinedText(chunks).trim()).toBe(await realpath(cwd));
  });

  it("consumer 未完成时 Promise 不提前 settle", async () => {
    // 验证 runCommand 的 Promise 在最后一个 chunk 的 consumer 处理完成后才 resolve。
    const cwd = await createCwd();
    let settled = false;
    const runPromise = runCommand({
      command: "echo hello; sleep 0.3",
      cwd,
      env: shellEnv,
      shellPath,
      onChunk: async () => {
        await delay(60);
      },
    });
    runPromise.then(() => {
      settled = true;
    });
    await delay(30);
    expect(settled).toBe(false);
    const exit = await runPromise;
    expect(exit).toEqual({ kind: "exit", exitCode: 0, signal: null });
  });

  it("慢速 consumer 下全部 chunk 依次送达且 seq 连续", async () => {
    // 验证可等待背压下 chunk 不丢失不重复：seq 连续递增，拼接文本与期望一致。
    const cwd = await createCwd();
    const { chunks } = collectChunks();
    await runCommand({
      command: "printf 'line %s\\n' {1..40}",
      cwd,
      env: shellEnv,
      shellPath,
      onChunk: async (chunk) => {
        await delay(3);
        chunks.push(chunk);
      },
    });
    const seqs = chunks.map((chunk) => chunk.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index));
    const text = joinedText(chunks);
    expect(text).toContain("line 1\n");
    expect(text).toContain("line 40\n");
  });
});

describe("runCommand 终止判别", () => {
  it("外部 signal 终止返回 signal 判别", async () => {
    // 验证命令被外部 SIGTERM 杀死时返回 {kind:"signal", signal:"SIGTERM"}，不虚构 128+signal。
    const cwd = await createCwd();
    const exit = await runCommand({ command: "kill -TERM $$", cwd, env: shellEnv, shellPath });
    expect(exit).toEqual({ kind: "signal", signal: "SIGTERM" });
  });

  it("自然退出后迟到的 timeout 不改写结果", async () => {
    // 验证进程先自然退出、timeout 稍后到期时不改写为超时终止。
    const cwd = await createCwd();
    const exit = await runCommand({
      command: "exit 0",
      cwd,
      env: shellEnv,
      shellPath,
      timeoutMs: 30,
    });
    expect(exit).toEqual({ kind: "exit", exitCode: 0, signal: null });
  });

  it("resolve 后迟到的 turn abort 不改写结果", async () => {
    // 验证 Promise 已 resolve 后再次 abort 不会改写结果，signal 监听器已在收敛时移除。
    const cwd = await createCwd();
    const turn = new AbortController();
    const exit = await runCommand({
      command: "exit 0",
      cwd,
      env: shellEnv,
      shellPath,
      turnSignal: turn.signal,
    });
    turn.abort();
    expect(exit).toEqual({ kind: "exit", exitCode: 0, signal: null });
  });

  it("consumer 抛错时终止进程并返回 consumer-failed", async () => {
    // 验证输出消费抛错是独立终止原因：执行器终止进程组并返回 {kind:"consumer-failed"}。
    const cwd = await createCwd();
    const exit = await runCommand({
      command: "echo boom; sleep 5",
      cwd,
      env: shellEnv,
      shellPath,
      onChunk: async () => {
        throw new Error("consumer exploded");
      },
    });
    expect(exit).toEqual({ kind: "consumer-failed" });
  }, 15_000);
});

describe("runCommand timeout 状态机", () => {
  it("timeout 到期发送 SIGTERM 终止进程组", async () => {
    // 验证达到 timeout 时先 SIGTERM，进程自然收敛则 termSignal 为 SIGTERM。
    const cwd = await createCwd();
    const exit = await runCommand({
      command: "sleep 5",
      cwd,
      env: shellEnv,
      shellPath,
      timeoutMs: 50,
    });
    expect(exit).toMatchObject({ kind: "killed", reason: "timeout", termSignal: "SIGTERM" });
  }, 15_000);

  it("忽略 SIGTERM 的命令在 250ms 后升级为 SIGKILL", async () => {
    // 验证 trap '' TERM 的命令不受 SIGTERM 影响，250ms 后进程组被 SIGKILL。
    const cwd = await createCwd();
    const exit = await runCommand({
      command: "trap '' TERM; sleep 5",
      cwd,
      env: shellEnv,
      shellPath,
      timeoutMs: 50,
    });
    expect(exit).toMatchObject({ kind: "killed", reason: "timeout", termSignal: "SIGKILL" });
  }, 15_000);
});

describe("runCommand 取消与进程组清理", () => {
  it("turn signal 取消返回 reason turn", async () => {
    // 验证 turnSignal.abort() 触发 {kind:"killed", reason:"turn"}，SIGTERM 优先。
    const cwd = await createCwd();
    const turn = new AbortController();
    const runPromise = runCommand({
      command: "sleep 5",
      cwd,
      env: shellEnv,
      shellPath,
      turnSignal: turn.signal,
    });
    await delay(30);
    turn.abort();
    const exit = await runPromise;
    expect(exit).toMatchObject({ kind: "killed", reason: "turn", termSignal: "SIGTERM" });
  }, 15_000);

  it("runtime close signal 取消返回 reason runtime", async () => {
    // 验证 runtimeCloseSignal.abort() 触发 {kind:"killed", reason:"runtime"}。
    const cwd = await createCwd();
    const runtime = new AbortController();
    const runPromise = runCommand({
      command: "sleep 5",
      cwd,
      env: shellEnv,
      shellPath,
      runtimeCloseSignal: runtime.signal,
    });
    await delay(30);
    runtime.abort();
    const exit = await runPromise;
    expect(exit).toMatchObject({ kind: "killed", reason: "runtime", termSignal: "SIGTERM" });
  }, 15_000);

  it("第一个观察到的终止原因获胜", async () => {
    // 验证 turn abort 与 timeout 竞争时，先观察到的 turn 取消决定终止原因。
    const cwd = await createCwd();
    const turn = new AbortController();
    const runPromise = runCommand({
      command: "sleep 5",
      cwd,
      env: shellEnv,
      shellPath,
      timeoutMs: 5_000,
      turnSignal: turn.signal,
    });
    await delay(30);
    turn.abort();
    const exit = await runPromise;
    expect(exit).toMatchObject({ kind: "killed", reason: "turn" });
  }, 15_000);

  it("自然退出后后台后代进程被清理", async () => {
    // 验证 `sleep 30 &` 后台后代在 runCommand 返回前被终止，不遗留同进程组进程。
    const cwd = await createCwd();
    const { chunks, consumer } = collectChunks();
    const exit = await runCommand({
      command: "sleep 30 & echo $!",
      cwd,
      env: shellEnv,
      shellPath,
      onChunk: consumer,
    });
    expect(exit).toEqual({ kind: "exit", exitCode: 0, signal: null });
    const pid = Number(joinedText(chunks).trim());
    expect(Number.isInteger(pid)).toBe(true);
    await waitForProcessExit(pid, 3_000);
  }, 15_000);

  it("被终止的 turn 结束后后台进程同样被清理", async () => {
    // 验证取消路径下后台后代也被进程组终止：sleep 5 在 runCommand 返回后不再存活。
    const cwd = await createCwd();
    const turn = new AbortController();
    const { chunks, consumer } = collectChunks();
    const runPromise = runCommand({
      command: "sleep 30 & echo $!; sleep 5",
      cwd,
      env: shellEnv,
      shellPath,
      turnSignal: turn.signal,
      onChunk: consumer,
    });
    await delay(60);
    turn.abort();
    const exit = await runPromise;
    expect(exit).toMatchObject({ kind: "killed", reason: "turn" });
    const pid = Number(joinedText(chunks).trim());
    expect(Number.isInteger(pid)).toBe(true);
    await waitForProcessExit(pid, 3_000);
  }, 15_000);
});
