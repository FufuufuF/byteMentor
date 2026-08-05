import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { ShellError } from "./shell-environment.js";

export type ShellStream = "stdout" | "stderr";

// 一次 pipe 消费的原始字节块：stream 区分来源，seq 为全局单调序号供下游按序合并。
export interface ShellChunk {
  stream: ShellStream;
  seq: number;
  data: Buffer;
}

// 可等待异步消费边界：处理未完成时暂停 pipe，最多保留每流一个待处理 chunk。
export type ShellChunkConsumer = (chunk: ShellChunk) => Promise<void>;

// 执行退出的判别结果：自然退出 / 外部 signal / 主动终止 / 输出消费失败。
export type ShellExit =
  | { kind: "exit"; exitCode: number; signal: null }
  | { kind: "signal"; signal: string }
  | { kind: "killed"; reason: "timeout" | "turn" | "runtime"; termSignal: "SIGTERM" | "SIGKILL" }
  | { kind: "consumer-failed" };

export interface RunCommandInput {
  command: string;
  cwd: string;
  env: Record<string, string>;
  shellPath: string;
  timeoutMs?: number;
  turnSignal?: AbortSignal;
  runtimeCloseSignal?: AbortSignal;
  onChunk?: ShellChunkConsumer;
}

// SIGTERM 后等待进程组自然收敛的宽限时间，超时则升级为 SIGKILL。
const SIGTERM_GRACE_MS = 250;

// 以受控环境启动一次性 Bash 并消费到收敛，返回第一个观察到的终止原因对应的判别结果。
export async function runCommand(input: RunCommandInput): Promise<ShellExit> {
  const child = await spawnBash(input);
  const pgid = child.pid as number;

  let nextSeq = 0;
  let pendingConsumers = 0;
  let wakeConsumers: (() => void) | undefined;
  let exitSettled = false;
  let termination: "timeout" | "turn" | "runtime" | "consumer" | undefined;
  let naturalExitLocked = false;
  let settleExit!: (exit: ShellExit) => void;
  const exitPromise = new Promise<ShellExit>((resolve) => {
    settleExit = resolve;
  });
  let closeSettle!: () => void;
  const closeEvent = new Promise<void>((resolve) => {
    closeSettle = resolve;
  });

  // 等待所有在途 consumer 完成，保证 settle 前输出消费真正收敛。
  function waitConsumersDrained(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (pendingConsumers === 0) {
        resolve();
        return;
      }
      wakeConsumers = resolve;
    });
  }

  // 裁决唯一结果：等 consumer 排空后置位 exitSettled 并释放调用方，随后清理 timer 与监听器。
  async function settle(exit: ShellExit): Promise<void> {
    await waitConsumersDrained();
    if (exitSettled) {
      return;
    }
    exitSettled = true;
    cleanup();
    settleExit(exit);
  }

  let timer: NodeJS.Timeout | undefined;
  const abortCleanups: Array<() => void> = [];

  function cleanup(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    for (const remove of abortCleanups) {
      remove();
    }
  }

  // 注册主动终止请求：结果已定或已有终止原因时忽略，保证第一个观察到的原因获胜。
  function requestTerminate(reason: "timeout" | "turn" | "runtime" | "consumer"): void {
    if (exitSettled || termination !== undefined || naturalExitLocked) {
      return;
    }
    termination = reason;
    void runTermination(reason);
  }

  // 统一终止进程组：SIGTERM → 等待最多 graceMs → 仍存活则 SIGKILL，返回最终使用的信号。
  async function terminateProcessGroup(graceMs: number): Promise<"SIGTERM" | "SIGKILL"> {
    sendSignalToGroup(pgid, "SIGTERM");
    await waitForGroupDeath(pgid, graceMs);
    if (processGroupAlive(pgid)) {
      sendSignalToGroup(pgid, "SIGKILL");
      await waitForGroupDeath(pgid, graceMs);
      return "SIGKILL";
    }
    return "SIGTERM";
  }

  // 主动终止：清理进程组后等 stdio 关闭与 consumer 收敛，再裁决终止结果。
  async function runTermination(
    reason: "timeout" | "turn" | "runtime" | "consumer",
  ): Promise<void> {
    const termSignal = await terminateProcessGroup(SIGTERM_GRACE_MS);
    await closeEvent;
    if (reason === "consumer") {
      await settle({ kind: "consumer-failed" });
    } else {
      await settle({ kind: "killed", reason, termSignal });
    }
  }

  // 自然退出路径：bash 已退出，best-effort 清理同进程组仍存活的后台后代（可能持有 pipe），
  // 再等待 stdio 真正关闭后裁决自然结果。
  async function settleNaturalExit(exitCode: number): Promise<void> {
    await terminateProcessGroup(SIGTERM_GRACE_MS);
    await closeEvent;
    await settle({ kind: "exit", exitCode, signal: null });
  }

  // 用 exit 事件（进程退出）触发裁决流程，而非 close 事件（stdio 全关）：后台后代可能持有
  // stdout/stderr pipe 使 close 永不触发，必须先在清理进程组后才能等到 close。
  child.once("close", () => {
    closeSettle();
  });
  child.once("exit", (exitCode, signalCode) => {
    if (termination !== undefined) {
      return;
    }
    naturalExitLocked = true;
    if (exitCode !== null) {
      void settleNaturalExit(exitCode);
    } else {
      void (async () => {
        await terminateProcessGroup(SIGTERM_GRACE_MS);
        await closeEvent;
        await settle({ kind: "signal", signal: signalCode ?? "UNKNOWN" });
      })();
    }
  });

  // 以固定参数启动 detached、non-login、non-interactive 的一次性 Bash，stdin 忽略。
  if (input.turnSignal !== undefined) {
    wireAbort(input.turnSignal, "turn");
  }
  if (input.runtimeCloseSignal !== undefined) {
    wireAbort(input.runtimeCloseSignal, "runtime");
  }
  if (input.timeoutMs !== undefined) {
    timer = setTimeout(() => requestTerminate("timeout"), input.timeoutMs);
  }

  pump(child.stdout as Readable, "stdout");
  pump(child.stderr as Readable, "stderr");

  return exitPromise;

  function wireAbort(signal: AbortSignal, reason: "turn" | "runtime"): void {
    if (signal.aborted) {
      requestTerminate(reason);
      return;
    }
    const handler = (): void => requestTerminate(reason);
    signal.addEventListener("abort", handler, { once: true });
    abortCleanups.push(() => signal.removeEventListener("abort", handler));
  }

  // 背压式 pipe 消费：consumer 未完成时暂停该流，完成后恢复，chunk 处理严格按到达顺序。
  function pump(stream: Readable, name: ShellStream): void {
    stream.on("data", (data: Buffer) => {
      stream.pause();
      const chunk: ShellChunk = { stream: name, seq: nextSeq++, data };
      pendingConsumers += 1;
      void (async () => {
        try {
          await input.onChunk?.(chunk);
        } catch {
          requestTerminate("consumer");
        } finally {
          pendingConsumers -= 1;
          if (pendingConsumers === 0 && wakeConsumers !== undefined) {
            wakeConsumers();
            wakeConsumers = undefined;
          }
          if (!stream.destroyed) {
            stream.resume();
          }
        }
      })();
    });
  }
}

// 异步启动子进程：spawn 的同步异常与异步 error 事件统一转为 shell_unavailable。
function spawnBash(input: RunCommandInput): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(input.shellPath, ["--noprofile", "--norc", "-c", input.command], {
        cwd: input.cwd,
        detached: true,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new ShellError("shell_unavailable", `unable to spawn shell: ${(error as Error).message}`),
      );
      return;
    }
    child.once("error", (error) => {
      reject(new ShellError("shell_unavailable", `unable to start shell: ${error.message}`));
    });
    child.once("spawn", () => {
      resolve(child);
    });
  });
}

// 向独立进程组发送信号（0 用于存活探测）；进程组已不存在（ESRCH）时返回 false。
function sendSignalToGroup(pgid: number, signal: NodeJS.Signals | number): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

// 以 0 号信号探测进程组是否仍有存活进程。
function processGroupAlive(pgid: number): boolean {
  return sendSignalToGroup(pgid, 0);
}

// 轮询等待进程组在期限内不再存活，用于 SIGTERM 自然收敛与 SIGKILL 升级后的等待。
async function waitForGroupDeath(pgid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pgid)) {
      return;
    }
    await delay(10);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
