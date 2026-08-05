import type { ShellChunk, ShellStream } from "./shell-executor.js";

export const PROTOCOL_MAX_SHELL_LINES = 2_000;
export const PROTOCOL_MAX_SERIALIZED_RESULT_CHARACTERS = 24_000;

// 按 push 调用顺序（即 executor 背压保证的 seq 顺序）累积解码、清理后的双流输出，
// 只保留最近 maxLines 行的尾部以保证内存有界；完整文本在首次接管时交给日志。
export class ShellOutputAccumulator {
  private readonly maxLines: number;
  private readonly decoders: Record<ShellStream, InstanceType<typeof TextDecoder>>;
  private readonly cleaners: Record<ShellStream, AnsiCleaner>;
  private fullBuffer = "";
  private tail = "";
  private newlineCount = 0;
  private endsWithNewline = false;
  private hasText = false;
  private handedOff = false;

  constructor(input: { maxLines?: number } = {}) {
    const maxLines = input.maxLines ?? PROTOCOL_MAX_SHELL_LINES;
    if (!isValidLimit(maxLines, PROTOCOL_MAX_SHELL_LINES)) {
      throw new TypeError(`shell maxLines must be between 1 and ${PROTOCOL_MAX_SHELL_LINES}`);
    }
    this.maxLines = maxLines;
    this.decoders = {
      stdout: new TextDecoder("utf-8"),
      stderr: new TextDecoder("utf-8"),
    };
    this.cleaners = {
      stdout: new AnsiCleaner(),
      stderr: new AnsiCleaner(),
    };
  }

  // 每条流使用独立流式 decoder 与 ANSI 清理状态；chunk 顺序即合并顺序。
  // 返回本次 chunk 解码并清理后的文本，供调用方补写完整日志。
  push(chunk: ShellChunk): string {
    const text = this.decoders[chunk.stream].decode(chunk.data, { stream: true });
    const cleaned = this.cleaners[chunk.stream].clean(text);
    this.appendText(cleaned);
    return cleaned;
  }

  // 未接管前的完整已清理文本（接管后为空）。
  text(): string {
    return this.handedOff ? "" : this.fullBuffer;
  }

  // 最近 maxLines 行的尾部文本，用于返回尾部与 JSON 预算。
  tailText(): string {
    return this.tail;
  }

  // 完整清理文本的精确行数：空输出 0 行、末尾 LF 不新增空行、无末尾 LF 的最后一段计一行。
  totalLines(): number {
    if (!this.hasText) {
      return 0;
    }
    return this.endsWithNewline ? this.newlineCount : this.newlineCount + 1;
  }

  // 首次调用返回从命令开始累计的全部已清理文本并清空，此后只维护尾部（完整文本进日志）。
  extractFullText(): string {
    const text = this.fullBuffer;
    this.fullBuffer = "";
    this.handedOff = true;
    return text;
  }

  private appendText(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.hasText = true;
    if (!this.handedOff) {
      this.fullBuffer += text;
    }
    this.tail = keepLastLines(this.tail + text, this.maxLines);
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 0x0a) {
        this.newlineCount += 1;
      }
    }
    this.endsWithNewline = text.endsWith("\n");
  }
}

export interface ShellTailFields {
  command: string;
  exitCode: number | null;
  fullOutputPath?: string;
}

export type ShellTruncation = {
  truncatedBy: "lines" | "output_limit";
  totalLines: number;
  returnedLines: number;
};

export interface ShellTailResult {
  output: string;
  truncated: boolean;
  truncation?: ShellTruncation;
}

export interface ComputeShellTailInput {
  text: string;
  /** 完整清理文本的精确行数；缺省时从 text 推导，供 text 已被截断为尾部时使用。 */
  totalLines?: number;
  fields: ShellTailFields;
  maxLines?: number;
  maxSerializedCharacters?: number;
}

// 先应用 2,000 行尾部限制，再按实际 JSON.stringify() 预算缩短 output 尾部；
// 预算继续缩短时 truncatedBy 为 output_limit，否则为 lines。
export function computeShellTail(input: ComputeShellTailInput): ShellTailResult {
  const maxLines = input.maxLines ?? PROTOCOL_MAX_SHELL_LINES;
  const maxCharacters = input.maxSerializedCharacters ?? PROTOCOL_MAX_SERIALIZED_RESULT_CHARACTERS;
  if (!isValidLimit(maxLines, PROTOCOL_MAX_SHELL_LINES)) {
    throw new TypeError(`shell maxLines must be between 1 and ${PROTOCOL_MAX_SHELL_LINES}`);
  }
  if (!isValidLimit(maxCharacters, PROTOCOL_MAX_SERIALIZED_RESULT_CHARACTERS)) {
    throw new TypeError(
      `shell maxSerializedCharacters must be between 1 and ${PROTOCOL_MAX_SERIALIZED_RESULT_CHARACTERS}`,
    );
  }

  const totalLines = input.totalLines ?? countLines(input.text);
  const tail = keepLastLines(input.text, maxLines);
  const lineTruncation: ShellTruncation | undefined =
    totalLines > maxLines
      ? { truncatedBy: "lines", totalLines, returnedLines: countLines(tail) }
      : undefined;

  const buildPayload = (output: string, truncation: ShellTruncation | undefined): string =>
    JSON.stringify({
      ok: true,
      data: {
        command: input.fields.command,
        exitCode: input.fields.exitCode,
        output,
        truncated: truncation !== undefined,
        ...(truncation === undefined ? {} : { truncation }),
        ...(input.fields.fullOutputPath === undefined
          ? {}
          : { fullOutputPath: input.fields.fullOutputPath }),
      },
    });

  if (buildPayload(tail, lineTruncation).length <= maxCharacters) {
    if (lineTruncation === undefined) {
      return { output: tail, truncated: false };
    }
    return { output: tail, truncated: true, truncation: lineTruncation };
  }

  // JSON 预算不足：二分缩短 output 尾部至可放入预算，按 Unicode scalar 边界截取。
  const limitTruncation: ShellTruncation = {
    truncatedBy: "output_limit",
    totalLines,
    returnedLines: countLines(tail),
  };
  let lower = 0;
  let upper = tail.length;
  let best = tail;
  while (lower <= upper) {
    const mid = (lower + upper) >> 1;
    const candidate = lastCodeUnits(tail, mid);
    if (buildPayload(candidate, limitTruncation).length <= maxCharacters) {
      best = candidate;
      lower = mid + 1;
    } else {
      upper = mid - 1;
    }
  }
  return {
    output: best,
    truncated: true,
    truncation: { ...limitTruncation, returnedLines: countLines(best) },
  };
}

// 统计一个文本的完整行数：空文本 0 行、末尾 LF 不新增空行、无末尾 LF 的最后一段计一行。
function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let newlines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      newlines += 1;
    }
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

// 保留文本最后 maxLines 行（含尾部换行），供尾部返回与有界累积。
function keepLastLines(text: string, maxLines: number): string {
  if (countLines(text) <= maxLines) {
    return text;
  }
  const endsWithNewline = text.endsWith("\n");
  const parts = text.split("\n");
  const contentParts = endsWithNewline ? parts.slice(0, -1) : parts;
  const tail = contentParts.slice(contentParts.length - maxLines).join("\n");
  return endsWithNewline ? `${tail}\n` : tail;
}

// 取字符串尾部的 count 个 UTF-16 码元；若起点切在孤立低 surrogate 则丢弃它，保证 scalar 边界。
function lastCodeUnits(text: string, count: number): string {
  if (count >= text.length) {
    return text;
  }
  if (count <= 0) {
    return "";
  }
  let start = text.length - count;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) {
    start += 1;
  }
  return text.slice(start);
}

function isValidLimit(value: number, max: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= max;
}

// 流式 ANSI/控制字符清理：跨 chunk 维护 CSI/OSC/DCS 状态，保留 LF 与 tab，
// 移除 CR、DEL、其余 C0/C1 控制字符与 ANSI escape sequence。
class AnsiCleaner {
  private state: "none" | "string" | "csi" | "osc" = "none";
  private pendingEsc = false;

  clean(text: string): string {
    let output = "";
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (this.state === "none") {
        if (ch === "\x1b") {
          this.state = "string";
          this.pendingEsc = false;
          continue;
        }
        if (code === 0x9b) {
          // 单字节 C1 CSI：等效 ESC [，后续参数与 final byte 一起作为 ANSI 序列移除。
          this.state = "csi";
          continue;
        }
        if (code === 0x0a || code === 0x09) {
          output += ch;
          continue;
        }
        if (code === 0x0d) {
          continue;
        }
        if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
          continue;
        }
        output += ch;
        continue;
      }
      this.consumeEscapeChar(ch);
    }
    return output;
  }

  // 消费 escape 序列内部字符，直到 final byte / BEL / ST 结束回到 none。
  private consumeEscapeChar(ch: string): void {
    if (this.state === "string") {
      if (ch === "[") {
        this.state = "csi";
      } else if (ch === "]") {
        this.state = "osc";
      } else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") {
        this.state = "osc";
      } else {
        this.state = "none";
      }
      return;
    }
    if (this.state === "csi") {
      const code = ch.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) {
        this.state = "none";
      }
      return;
    }
    if (this.state === "osc") {
      if (ch === "\x07") {
        this.state = "none";
        this.pendingEsc = false;
        return;
      }
      if (this.pendingEsc && ch === "\\") {
        this.state = "none";
        this.pendingEsc = false;
        return;
      }
      this.pendingEsc = ch === "\x1b";
    }
  }
}
