import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

export const PROTOCOL_MAX_SHELL_LOG_BYTES = 100 * 1024 * 1024;

// 日志创建、chmod、补写或追加失败时抛出，由 bash.ts 统一映射为 resource_limit 并终止进程。
export class ShellLogError extends Error {
  readonly code = "shell_log_failed";

  constructor(message: string) {
    super(message);
    this.name = "ShellLogError";
  }
}

export interface ShellLogWriteResult {
  fullOutputPath: string;
  limitReached: boolean;
}

// 懒创建 mode 0700 的 session 临时目录与随机 mode 0600 完整日志；
// 所有写入经单一异步写链串行并施加背压；close 幂等清理整个 session 目录。
export class ShellLogStore {
  private readonly sessionTempDirectory: string;
  private readonly maxLogBytes: number;
  private fullPath: string | undefined;
  private currentBytes = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(input: { sessionTempDirectory: string; maxLogBytes?: number }) {
    const maxLogBytes = input.maxLogBytes ?? PROTOCOL_MAX_SHELL_LOG_BYTES;
    if (
      !Number.isInteger(maxLogBytes) ||
      maxLogBytes <= 0 ||
      maxLogBytes > PROTOCOL_MAX_SHELL_LOG_BYTES
    ) {
      throw new TypeError(
        `shell log maxLogBytes must be between 1 and ${PROTOCOL_MAX_SHELL_LOG_BYTES}`,
      );
    }
    this.sessionTempDirectory = input.sessionTempDirectory;
    this.maxLogBytes = maxLogBytes;
  }

  // 首次写入：懒创建目录与日志文件并补写从命令开始累计的全部已清理文本。
  backfill(text: string): Promise<ShellLogWriteResult> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      return this.write(text);
    });
  }

  // 后续写入：通过单一异步写链追加，施加背压。
  append(text: string): Promise<ShellLogWriteResult> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      return this.write(text);
    });
  }

  // 等待写链收敛后返回日志绝对路径；尚未创建日志时返回 undefined。
  async fullOutputPath(): Promise<string | undefined> {
    await this.writeChain;
    return this.fullPath;
  }

  // 幂等清理整个 session 临时目录（含日志文件），Runtime close 时调用一次收尾。
  async close(): Promise<void> {
    await this.writeChain;
    await rm(this.sessionTempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  // 把写操作串行挂到单一写链上，保证追加顺序与背压。
  private enqueue(write: () => Promise<ShellLogWriteResult>): Promise<ShellLogWriteResult> {
    const result = this.writeChain.then(write);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // 幂等创建 session 临时目录（0700）与随机名日志文件（0600 exclusive）。
  private async ensureInitialized(): Promise<void> {
    if (this.fullPath !== undefined) {
      return;
    }
    try {
      await mkdir(this.sessionTempDirectory, { recursive: true });
      await chmod(this.sessionTempDirectory, 0o700);
      const path = join(
        this.sessionTempDirectory,
        `bash-output-${randomBytes(16).toString("hex")}.log`,
      );
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      await chmod(path, 0o600);
      this.fullPath = path;
    } catch (error) {
      throw new ShellLogError(`unable to create shell log: ${(error as Error).message}`);
    }
  }

  // 追加文本：剩余空间不足时只写入 UTF-8 scalar 边界内可容纳的最长前缀并标记 limitReached。
  private async write(text: string): Promise<ShellLogWriteResult> {
    const path = this.fullPath as string;
    const remaining = this.maxLogBytes - this.currentBytes;
    let toWrite = text;
    let limitReached = false;
    if (Buffer.byteLength(text, "utf-8") > remaining) {
      toWrite = utf8PrefixByBytes(text, remaining);
      limitReached = true;
    }
    try {
      const handle = await open(path, "a");
      try {
        await handle.write(toWrite);
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw new ShellLogError(`unable to append shell log: ${(error as Error).message}`);
    }
    this.currentBytes += Buffer.byteLength(toWrite, "utf-8");
    return { fullOutputPath: path, limitReached };
  }
}

// 按 UTF-8 字节上限截取文本前缀，回退到完整多字节字符边界，不产生替换字符或损坏字节。
function utf8PrefixByBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf-8");
  if (buffer.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf-8");
}
