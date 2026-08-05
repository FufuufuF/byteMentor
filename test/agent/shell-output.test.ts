import { describe, expect, it } from "vitest";
import { computeShellTail, ShellOutputAccumulator } from "@byte-mentor/agent";
import type { ShellChunk } from "@byte-mentor/agent";

// 构造一个 ShellChunk；data 为字符串时按 UTF-8 编码成 Buffer。
function chunk(stream: "stdout" | "stderr", seq: number, data: Buffer | string): ShellChunk {
  return { stream, seq, data: typeof data === "string" ? Buffer.from(data, "utf-8") : data };
}

// 把一个字符串整体（或其 Buffer 切片）推入累加器的便捷封装。
function push(
  acc: ShellOutputAccumulator,
  data: string,
  stream: "stdout" | "stderr" = "stdout",
): void {
  acc.push(chunk(stream, 0, data));
}

describe("ShellOutputAccumulator", () => {
  it("单流简单输出累积并可取回全部与行数", () => {
    // 验证单 chunk 文本被完整累积，totalLines 按行统计。
    const acc = new ShellOutputAccumulator();
    push(acc, "hello\nworld\n");
    expect(acc.text()).toBe("hello\nworld\n");
    expect(acc.totalLines()).toBe(2);
  });

  it("跨 chunk 拆分 UTF-8 多字节字符仍正确解码", () => {
    // 验证 stdout 流上「你好」的 6 字节 UTF-8 被切到两个 chunk 后解码不损坏。
    const full = Buffer.from("你好\n", "utf-8");
    const acc = new ShellOutputAccumulator();
    acc.push(chunk("stdout", 0, full.subarray(0, 4)));
    acc.push(chunk("stdout", 1, full.subarray(4)));
    expect(acc.text()).toBe("你好\n");
  });

  it("stdout 与 stderr 各自独立跨 chunk 解码不混流", () => {
    // 验证两条流各自维护流式 decoder，即使多字节字符同时跨 chunk 也不互相污染。
    const out = Buffer.from("你\n", "utf-8");
    const err = Buffer.from("好\n", "utf-8");
    const acc = new ShellOutputAccumulator();
    acc.push(chunk("stdout", 0, out.subarray(0, 2)));
    acc.push(chunk("stderr", 1, err.subarray(0, 2)));
    acc.push(chunk("stdout", 2, out.subarray(2)));
    acc.push(chunk("stderr", 3, err.subarray(2)));
    expect(acc.text()).toBe("你\n好\n");
  });

  it("按 push 调用顺序（即 seq 顺序）交错合并双流", () => {
    // 验证交错输出按到达顺序合并，不按流分组。
    const acc = new ShellOutputAccumulator();
    push(acc, "out1\n");
    push(acc, "err1\n", "stderr");
    push(acc, "out2\n");
    expect(acc.text()).toBe("out1\nerr1\nout2\n");
  });

  it("跨 chunk 的 CSI ANSI 序列被完整清理", () => {
    // 验证 \x1b[31m...\x1b[0m 的 CSI 序列被切到多个 chunk 时仍被整段移除。
    const acc = new ShellOutputAccumulator();
    push(acc, "\x1b[3");
    push(acc, "1mred\x1b[0m");
    expect(acc.text()).toBe("red");
  });

  it("跨 chunk 的 OSC ANSI 序列（BEL 与 ST 结尾）被完整清理", () => {
    // 验证 \x1b]0;title 的 OSC 序列以 BEL 或 ESC\ 结尾且跨 chunk 时被整段移除。
    const acc = new ShellOutputAccumulator();
    push(acc, "\x1b]0;my title\x07");
    push(acc, "content");
    expect(acc.text()).toBe("content");
    const acc2 = new ShellOutputAccumulator();
    push(acc2, "\x1b]2;tab\x1b\\");
    push(acc2, "next");
    expect(acc2.text()).toBe("next");
  });

  it("移除 CR、DEL、其他 C0/C1 控制字符并保留 LF 与 tab", () => {
    // 验证清理保留换行与制表符，移除回车、删除符及其余 C0/C1 与 ANSI 序列。
    const acc = new ShellOutputAccumulator();
    push(acc, "a\x00\x08\x1b[A\rb\tc\x7f\x9b1;1Hd\x1b5");
    expect(acc.text()).toBe("ab\tcd");
  });

  it("CRLF 因移除 CR 而归一化为 LF", () => {
    // 验证 "a\r\nb" 中的 CR 被移除后得到 "a\nb"。
    const acc = new ShellOutputAccumulator();
    push(acc, "a\r\nb\r\n");
    expect(acc.text()).toBe("a\nb\n");
  });

  it("空输出计为 0 行", () => {
    // 验证没有任何文本时 totalLines 为 0。
    const acc = new ShellOutputAccumulator();
    expect(acc.totalLines()).toBe(0);
  });

  it("末尾换行不新增空行、无末尾换行的最后一段计一行", () => {
    // 验证行统计边界："a\n" 为 1 行，"a\nb" 为 2 行，"a\n\n" 为 2 行。
    const acc = new ShellOutputAccumulator();
    push(acc, "a\n");
    expect(acc.totalLines()).toBe(1);
    const acc2 = new ShellOutputAccumulator();
    push(acc2, "a\nb");
    expect(acc2.totalLines()).toBe(2);
    const acc3 = new ShellOutputAccumulator();
    push(acc3, "a\n\n");
    expect(acc3.totalLines()).toBe(2);
  });

  it("tail 有界：超过 maxLines 行只保留尾部，totalLines 仍完整", () => {
    // 验证累加器只保留最近 maxLines 行文本，但完整行数统计不丢失。
    const acc = new ShellOutputAccumulator({ maxLines: 3 });
    push(acc, "a\nb\nc\nd\ne\n");
    expect(acc.tailText()).toBe("c\nd\ne\n");
    expect(acc.totalLines()).toBe(5);
  });

  it("extractFullText 返回全部已累积文本并清空，此后只维护尾部", () => {
    // 验证首次接管把从命令开始的全部清理文本交给日志，之后累积器不再保留完整文本。
    const acc = new ShellOutputAccumulator({ maxLines: 2 });
    push(acc, "a\nb\nc\n");
    expect(acc.extractFullText()).toBe("a\nb\nc\n");
    push(acc, "d\ne\n");
    expect(acc.extractFullText()).toBe("");
    expect(acc.tailText()).toBe("d\ne\n");
    expect(acc.totalLines()).toBe(5);
  });

  it("maxLines 注入超过协议上限被拒绝", () => {
    // 验证 Runtime 只能降低行数上限，不能提高协议硬上限。
    expect(() => new ShellOutputAccumulator({ maxLines: 2_001 })).toThrow(TypeError);
  });
});

describe("computeShellTail", () => {
  const emptyFields = { command: "echo hi", exitCode: 0 };

  it("行数与预算内未截断", () => {
    // 验证完整输出不超过行限制与 JSON 预算时不截断，无 truncation 元数据。
    const result = computeShellTail({
      text: "a\nb\nc\n",
      fields: emptyFields,
      maxLines: 2_000,
      maxSerializedCharacters: 24_000,
    });
    expect(result.output).toBe("a\nb\nc\n");
    expect(result.truncated).toBe(false);
    expect(result.truncation).toBeUndefined();
  });

  it("空文本未截断且 0 行", () => {
    // 验证空输出返回空字符串、0 行且不截断。
    const result = computeShellTail({
      text: "",
      fields: emptyFields,
      maxLines: 2_000,
      maxSerializedCharacters: 24_000,
    });
    expect(result.output).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("行截断保留尾部并报告准确元数据", () => {
    // 验证超过 maxLines 时只保留最后 maxLines 行，truncatedBy 为 lines，行数准确。
    const result = computeShellTail({
      text: "a\nb\nc\nd\ne\n",
      fields: emptyFields,
      maxLines: 3,
      maxSerializedCharacters: 24_000,
    });
    expect(result.output).toBe("c\nd\ne\n");
    expect(result.truncated).toBe(true);
    expect(result.truncation).toEqual({
      truncatedBy: "lines",
      totalLines: 5,
      returnedLines: 3,
    });
  });

  it("行未超但 JSON 预算超时按 output_limit 截断", () => {
    // 验证仅序列化预算不足时保留尾部并标记 truncatedBy 为 output_limit。
    const text = "abcdefghij\n".repeat(10);
    const result = computeShellTail({
      text,
      fields: emptyFields,
      maxLines: 2_000,
      maxSerializedCharacters: 175,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncation?.truncatedBy).toBe("output_limit");
    expect(text.endsWith(result.output)).toBe(true);
    expect(result.output.length).toBeLessThan(text.length);
  });

  it("行截断后 JSON 仍超时 truncatedBy 为 output_limit", () => {
    // 验证先应用行限制、JSON 预算继续缩短时以后者为准。
    const text = "abcdefghij\n".repeat(10);
    const result = computeShellTail({
      text,
      fields: emptyFields,
      maxLines: 3,
      maxSerializedCharacters: 175,
    });
    expect(result.truncation?.truncatedBy).toBe("output_limit");
    expect(result.truncation?.totalLines).toBe(10);
    expect(result.output.length).toBeLessThan(33);
  });

  it("超长单行按 Unicode 尾部截取且不产生孤立 surrogate", () => {
    // 验证 emoji（surrogate 对）尾部截取不切开代理对，结果无孤立 surrogate 且是合法 JSON。
    const text = "😀".repeat(50);
    const result = computeShellTail({
      text,
      fields: emptyFields,
      maxLines: 2_000,
      maxSerializedCharacters: 200,
    });
    expect(hasLoneSurrogate(result.output)).toBe(false);
    expect(
      JSON.stringify({ ok: true, data: { ...emptyFields, output: result.output } }).length,
    ).toBeLessThanOrEqual(200);
  });

  it("所有结果序列化长度均不超过预算", () => {
    // 验证含全角截断信息与完整路径时，最终 JSON 长度仍不超过预算。
    const text = "line-".repeat(5_000);
    const result = computeShellTail({
      text,
      fields: { command: "cd x && make", exitCode: 1, fullOutputPath: "/tmp/session/out.log" },
      maxLines: 2_000,
      maxSerializedCharacters: 4_000,
    });
    const payload = {
      ok: true,
      data: {
        command: "cd x && make",
        exitCode: 1,
        output: result.output,
        truncated: result.truncated,
        ...(result.truncation === undefined ? {} : { truncation: result.truncation }),
        fullOutputPath: "/tmp/session/out.log",
      },
    };
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(4_000);
  });
});

// 检查一个字符串是否包含孤立的高/低 surrogate（未配对的 UTF-16 半个码元）。
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
