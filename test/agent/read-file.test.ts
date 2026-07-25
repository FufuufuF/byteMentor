import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agentExports from "@byte-mentor/agent";
import {
  ToolRegistry,
  WorkspaceAccessPolicy,
  WorkspaceReader,
  type AgentTool,
  type ToolExecutionOutput,
  type WorkspaceAccessPolicyOverrides,
} from "@byte-mentor/agent";

interface ReadFileData {
  path: string;
  encoding: "utf-8";
  bom: boolean;
  content: string;
  range: null | {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  eof: boolean;
  truncated: boolean;
  truncatedBy?: "line_limit" | "character_limit";
  nextPosition?: {
    line: number;
    column: number;
  };
}

const temporaryPaths = new Set<string>();

// 删除每个用例创建的真实工作区，避免文件内容和权限状态跨测试泄漏。
afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  temporaryPaths.clear();
});

// 创建并登记一个真实临时工作区，使编码、字节扫描和路径行为来自 Node 文件系统。
async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "byte-mentor-read-"));
  temporaryPaths.add(path);
  return path;
}

// 从包公共入口取得 read_file Tool，使 Batch 5 缺少导出时以明确断言进入 RED。
function getReadFileTool(): AgentTool {
  const candidate = (agentExports as Record<string, unknown>)["readFileTool"];
  expect(candidate).toBeTypeOf("object");
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("readFileTool is not exported");
  }
  return candidate as AgentTool;
}

// 使用同一 Policy 组装 Reader 与 Registry，使读取窗口和最终序列化共享调用方上限。
function createRegistry(
  workspaceRoot: string,
  overrides?: WorkspaceAccessPolicyOverrides,
): ToolRegistry {
  const policy = new WorkspaceAccessPolicy(overrides);
  const workspaceReader = new WorkspaceReader({ workspaceRoot, policy });
  const registry = new ToolRegistry({
    context: { workspaceReader },
    maxSerializedToolResultCharacters: policy.limits.maxSerializedToolResultCharacters,
  });
  registry.register(getReadFileTool());
  return registry;
}

// 经 Registry 执行 read_file，保留结构化结果与 ToolMessage JSON 供契约断言复用。
async function executeReadFile(
  workspaceRoot: string,
  args: unknown,
  overrides?: WorkspaceAccessPolicyOverrides,
): Promise<ToolExecutionOutput> {
  return createRegistry(workspaceRoot, overrides).execute("read_file", args);
}

// 确认 Tool 成功后取得读取 payload，让各测试只描述窗口与续读语义。
function readSuccessData(output: ToolExecutionOutput): ReadFileData {
  expect(output.result.ok).toBe(true);
  if (!output.result.ok) {
    throw new Error(`expected success, received ${output.result.error.code}`);
  }
  expect(JSON.parse(output.content)).toEqual(output.result);
  return output.result.data as unknown as ReadFileData;
}

describe("read_file text windows", () => {
  // 带 BOM 的混合行尾文本应去除 BOM、保留 LF/CRLF/CR，并按 Unicode code point 解释起始列。
  it("preserves UTF-8 text and original line endings", async () => {
    const root = await createTemporaryDirectory();
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("甲😀乙\r\n次行\r末行\n", "utf8"),
    ]);
    await writeFile(join(root, "mixed.txt"), bytes);

    const first = readSuccessData(
      await executeReadFile(root, {
        path: "mixed.txt",
        startLine: 1,
        startColumn: 2,
        lineLimit: 2,
      }),
    );

    expect(first).toEqual({
      path: "mixed.txt",
      encoding: "utf-8",
      bom: true,
      content: "😀乙\r\n次行\r",
      range: { startLine: 1, startColumn: 2, endLine: 2, endColumn: 3 },
      eof: false,
      truncated: true,
      truncatedBy: "line_limit",
      nextPosition: { line: 3, column: 1 },
    });

    const second = readSuccessData(
      await executeReadFile(root, {
        path: "mixed.txt",
        startLine: first.nextPosition?.line,
        startColumn: first.nextPosition?.column,
      }),
    );
    expect(second.content).toBe("末行\n");
    expect(second.eof).toBe(true);
    expect(second.truncated).toBe(false);
  });

  // 未提供位置和行数时应从 1:1 开始，并采用 Policy 的默认读取行数而不是 schema 常量。
  it("uses policy defaults for the initial window", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "lines.txt"), "one\ntwo\nthree");

    const data = readSuccessData(
      await executeReadFile(root, { path: "lines.txt" }, { limits: { defaultReadLines: 2 } }),
    );

    expect(data.content).toBe("one\ntwo\n");
    expect(data.range).toEqual({ startLine: 1, startColumn: 1, endLine: 2, endColumn: 4 });
    expect(data).toMatchObject({
      eof: false,
      truncated: true,
      truncatedBy: "line_limit",
      nextPosition: { line: 3, column: 1 },
    });
  });

  // 字符硬上限按 Unicode code point 计数；续读位置必须紧接首个窗口且不重复、不遗漏非 BMP 字符。
  it("continues exactly after a character-limited window", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "long.txt"), "a😀bcdef");

    const first = readSuccessData(
      await executeReadFile(root, { path: "long.txt" }, { limits: { maxOutputCharacters: 4 } }),
    );
    expect(first).toEqual({
      path: "long.txt",
      encoding: "utf-8",
      bom: false,
      content: "a😀bc",
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
      eof: false,
      truncated: true,
      truncatedBy: "character_limit",
      nextPosition: { line: 1, column: 5 },
    });

    const second = readSuccessData(
      await executeReadFile(root, {
        path: "long.txt",
        startLine: first.nextPosition?.line,
        startColumn: first.nextPosition?.column,
      }),
    );
    expect(first.content + second.content).toBe("a😀bcdef");
    expect(second.range).toEqual({ startLine: 1, startColumn: 5, endLine: 1, endColumn: 7 });
    expect(second.eof).toBe(true);
  });

  // 连续按一行窗口读取时，每个 nextPosition 应落在下一行 1:1，拼接后完整复原原始文件。
  it("continues exactly across line-limited windows", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "pages.txt"), "a\r\nb\rc\nend");

    const contents: string[] = [];
    let position = { line: 1, column: 1 };
    let eof = false;
    while (!eof) {
      const page = readSuccessData(
        await executeReadFile(root, {
          path: "pages.txt",
          startLine: position.line,
          startColumn: position.column,
          lineLimit: 1,
        }),
      );
      contents.push(page.content);
      eof = page.eof;
      if (!eof) {
        expect(page.nextPosition).toBeDefined();
        position = page.nextPosition!;
      }
    }

    expect(contents.join("")).toBe("a\r\nb\rc\nend");
    expect(contents).toEqual(["a\r\n", "b\r", "c\n", "end"]);
  });
});

describe("read_file empty and boundary positions", () => {
  // 空文件没有可表示的字符范围，应返回空内容、range null 和已到 EOF。
  it("returns an empty EOF window for an empty file", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "empty.txt"), "");

    const data = readSuccessData(await executeReadFile(root, { path: "empty.txt" }));

    expect(data).toEqual({
      path: "empty.txt",
      encoding: "utf-8",
      bom: false,
      content: "",
      range: null,
      eof: true,
      truncated: false,
    });
  });

  // 起始行超过文件最后一行时应视为已到 EOF，而不是路径或参数错误。
  it("returns an empty EOF window beyond the last line", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "short.txt"), "one\ntwo");

    const data = readSuccessData(await executeReadFile(root, { path: "short.txt", startLine: 10 }));

    expect(data.content).toBe("");
    expect(data.range).toBeNull();
    expect(data.eof).toBe(true);
    expect(data.truncated).toBe(false);
  });

  // 行末后一列是读取行尾的合法位置；再向后一列则必须返回 invalid_arguments。
  it("validates the start column against the target line", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "column.txt"), "abc\nnext");

    const valid = readSuccessData(
      await executeReadFile(root, {
        path: "column.txt",
        startLine: 1,
        startColumn: 4,
        lineLimit: 1,
      }),
    );
    expect(valid.content).toBe("\n");
    expect(valid.range).toEqual({ startLine: 1, startColumn: 4, endLine: 1, endColumn: 4 });
    expect(valid.nextPosition).toEqual({ line: 2, column: 1 });

    const invalid = await executeReadFile(root, {
      path: "column.txt",
      startLine: 1,
      startColumn: 5,
    });
    expect(invalid.result).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });
});

describe("read_file content and resource errors", () => {
  // 非法 UTF-8 不能被替换字符静默修复，单文件读取应直接返回 unsupported_content。
  it("rejects invalid UTF-8", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "invalid.txt"), Buffer.from([0x61, 0x80, 0x62]));

    const output = await executeReadFile(root, { path: "invalid.txt" });

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "unsupported_content" },
    });
  });

  // 即使其余字节是合法 UTF-8，包含 NUL 的文件也属于二进制内容并应被明确拒绝。
  it("rejects NUL binary content", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "binary.txt"), Buffer.from([0x61, 0x00, 0x62]));

    const output = await executeReadFile(root, { path: "binary.txt" });

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "unsupported_content" },
    });
  });

  // Reader 应按实际定位扫描量计费：巨大文件前部可读取，定位到预算外的后续行则返回 resource_limit。
  it("enforces the actual scanned-byte limit", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "huge.txt"), `ok\n${"x".repeat(100_000)}`);

    const early = readSuccessData(
      await executeReadFile(
        root,
        { path: "huge.txt", lineLimit: 1 },
        { limits: { maxReadScanBytes: 16 } },
      ),
    );
    expect(early.content).toBe("ok\n");
    expect(early.nextPosition).toEqual({ line: 2, column: 1 });

    const late = await executeReadFile(
      root,
      { path: "huge.txt", startLine: 3 },
      { limits: { maxReadScanBytes: 16 } },
    );
    expect(late.result).toMatchObject({
      ok: false,
      error: { code: "resource_limit" },
    });
  });
});

describe("read_file errors and model contract", () => {
  // 目录、缺失路径和默认敏感路径应分别保留 Workspace 层的稳定结构化错误码。
  it("maps workspace path failures", async () => {
    const root = await createTemporaryDirectory();
    await mkdir(join(root, "folder"));
    await writeFile(join(root, ".env"), "secret");

    const cases = [
      { args: { path: "folder" }, code: "wrong_path_type" },
      { args: { path: "missing.txt" }, code: "path_not_found" },
      { args: { path: ".env" }, code: "access_denied" },
    ];
    for (const testCase of cases) {
      const output = await executeReadFile(root, testCase.args);
      expect(output.result).toMatchObject({
        ok: false,
        error: { code: testCase.code },
      });
    }
  });

  // Registry schema 应拒绝缺失路径、非正位置、超出协议行数和未声明字段。
  it("rejects invalid schema arguments", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "file.txt"), "text");
    const registry = createRegistry(root);
    const invalidArgs = [
      {},
      { path: "file.txt", startLine: 0 },
      { path: "file.txt", startColumn: 0 },
      { path: "file.txt", lineLimit: 0 },
      { path: "file.txt", lineLimit: 501 },
      { path: "file.txt", encoding: "utf-16" },
    ];

    for (const args of invalidArgs) {
      await expect(registry.execute("read_file", args)).resolves.toMatchObject({
        result: { ok: false, error: { code: "invalid_arguments" } },
      });
    }
  });

  // 部署 Policy 可以把行数硬上限收紧到 schema 上限以内，Tool 必须拒绝更大的请求。
  it("rejects a line limit above the configured policy maximum", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "file.txt"), "one\ntwo");

    const output = await executeReadFile(
      root,
      { path: "file.txt", lineLimit: 3 },
      { limits: { maxReadLines: 2 } },
    );

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });

  // 模型只应看到完整 schema 和四段使用说明，并且并发属性不能泄漏到 ToolDefinition。
  it("publishes the read_file model contract", async () => {
    const root = await createTemporaryDirectory();
    const registry = createRegistry(root);
    const definition = registry.list().find((tool) => tool.name === "read_file");

    expect(definition).toEqual({
      name: "read_file",
      description: expect.any(String),
      parametersJsonSchema: expect.objectContaining({
        type: "object",
        required: ["path"],
        additionalProperties: false,
      }),
    });
    expect(definition?.description).toContain("Use when:");
    expect(definition?.description).toContain("Do not use when:");
    expect(definition?.description).toContain("Returns:");
    expect(definition?.description).toContain("Example:");
    expect(registry.getConcurrency("read_file")).toBe("safe");
  });
});
