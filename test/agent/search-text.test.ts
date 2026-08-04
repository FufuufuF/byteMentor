import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agentExports from "@byte-mentor/agent";
import {
  ToolRegistry,
  WorkspaceAccessPolicy,
  WorkspaceEditor,
  WorkspaceReader,
  type AgentTool,
  type ToolExecutionOutput,
  type WorkspaceAccessPolicyOverrides,
} from "@byte-mentor/agent";

interface SearchMatchData {
  path: string;
  line: number;
  firstMatchColumn: number;
  occurrenceCount: number;
  preview: string;
  previewRange: {
    startColumn: number;
    endColumn: number;
  };
  previewTruncated: boolean;
}

interface SearchTextData {
  path: string;
  query: string;
  caseSensitive: boolean;
  matches: SearchMatchData[];
  pagination: {
    offset: number;
    limit: number;
    returned: number;
    hasMore: boolean;
    nextOffset?: number;
    truncatedBy?: "output_limit";
  };
  skippedFileCount: number;
  skippedFiles: Array<{
    path: string;
    reason: "binary" | "invalid_utf8" | "file_too_large" | "unreadable";
  }>;
}

const temporaryPaths = new Set<string>();

// 删除每个用例创建的真实工作区，保证扫描字节、遍历计数和跳过详情彼此隔离。
afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  temporaryPaths.clear();
});

// 创建并登记真实临时工作区，使目录遍历、编码检测和文件大小均走生产文件系统路径。
async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "byte-mentor-search-"));
  temporaryPaths.add(path);
  return path;
}

// 从包公共入口取得 search_text Tool，使 Batch 6 缺少导出时以明确断言进入 RED。
function getSearchTextTool(): AgentTool {
  const candidate = (agentExports as Record<string, unknown>)["searchTextTool"];
  expect(candidate).toBeTypeOf("object");
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("searchTextTool is not exported");
  }
  return candidate as AgentTool;
}

// 使用同一 Policy 创建 Reader 与 Registry，使搜索、分页和序列化共享所有调用方硬上限。
function createRegistry(
  workspaceRoot: string,
  overrides?: WorkspaceAccessPolicyOverrides,
): ToolRegistry {
  const policy = new WorkspaceAccessPolicy(overrides);
  const workspaceReader = new WorkspaceReader({ workspaceRoot, policy });
  const workspaceEditor = new WorkspaceEditor({ workspaceRoot, policy });
  const registry = new ToolRegistry({
    context: { workspaceReader, workspaceEditor },
    maxSerializedToolResultCharacters: policy.limits.maxSerializedToolResultCharacters,
  });
  registry.register(getSearchTextTool());
  return registry;
}

// 经 Registry 执行 search_text，返回结构化结果与 ToolMessage JSON 供成功和失败断言复用。
async function executeSearchText(
  workspaceRoot: string,
  args: unknown,
  overrides?: WorkspaceAccessPolicyOverrides,
): Promise<ToolExecutionOutput> {
  return createRegistry(workspaceRoot, overrides).execute("search_text", args);
}

// 确认 Tool 成功后取得搜索 payload，并验证最终 ToolMessage 始终是等价完整 JSON。
function readSuccessData(output: ToolExecutionOutput): SearchTextData {
  expect(output.result.ok).toBe(true);
  if (!output.result.ok) {
    throw new Error(`expected success, received ${output.result.error.code}`);
  }
  expect(JSON.parse(output.content)).toEqual(output.result);
  return output.result.data as unknown as SearchTextData;
}

describe("search_text literal matching", () => {
  // 单文件搜索每条匹配行只返回一项，并按 Unicode code point 给出首次列与同行非重叠出现次数。
  it("searches one file with Unicode columns and occurrence counts", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "sample.txt"), "😀 Alpha alpha ALPHA\nnone\n");

    const insensitive = readSuccessData(
      await executeSearchText(root, { query: "alpha", path: "sample.txt" }),
    );
    expect(insensitive).toEqual({
      path: "sample.txt",
      query: "alpha",
      caseSensitive: false,
      matches: [
        {
          path: "sample.txt",
          line: 1,
          firstMatchColumn: 3,
          occurrenceCount: 3,
          preview: "😀 Alpha alpha ALPHA",
          previewRange: { startColumn: 1, endColumn: 19 },
          previewTruncated: false,
        },
      ],
      pagination: { offset: 0, limit: 50, returned: 1, hasMore: false },
      skippedFileCount: 0,
      skippedFiles: [],
    });

    const sensitive = readSuccessData(
      await executeSearchText(root, {
        query: "Alpha",
        path: "sample.txt",
        caseSensitive: true,
      }),
    );
    expect(sensitive.matches[0]).toMatchObject({ firstMatchColumn: 3, occurrenceCount: 1 });
  });

  // 目录搜索应递归扫描允许文件，跳过默认 denied/searchExcludes，并按路径、行号稳定排序结果。
  it("searches directories in stable path and line order", async () => {
    const root = await createTemporaryDirectory();
    await mkdir(join(root, "a"));
    await mkdir(join(root, "z"));
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "z", "last.txt"), "needle on z line 1\nneedle on z line 2");
    await writeFile(join(root, "a", "first.txt"), "before\nneedle on a line 2");
    await writeFile(join(root, "node_modules", "hidden.txt"), "needle");
    await writeFile(join(root, ".git", "secret.txt"), "needle");

    const data = readSuccessData(await executeSearchText(root, { query: "needle" }));

    expect(data.path).toBe(".");
    expect(data.matches.map((match) => [match.path, match.line])).toEqual([
      ["a/first.txt", 2],
      ["z/last.txt", 1],
      ["z/last.txt", 2],
    ]);
    expect(data.skippedFileCount).toBe(0);
  });

  // 查询只匹配同一逻辑行内的字面量，不能跨越 CRLF、LF 或 CR 行边界拼接命中。
  it("does not match across line endings", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "lines.txt"), "ab\r\ncd\nef\rgh");

    const data = readSuccessData(await executeSearchText(root, { query: "bc", path: "lines.txt" }));

    expect(data.matches).toEqual([]);
  });
});

describe("search_text previews", () => {
  // 超过 300 code point 的匹配行应返回首次命中前最多 150 字符的有界预览及精确原行列范围。
  it("centers a bounded preview around the first match", async () => {
    const root = await createTemporaryDirectory();
    const line = `${"前".repeat(200)}NEEDLE${"后".repeat(200)}`;
    await writeFile(join(root, "long.txt"), line);

    const data = readSuccessData(
      await executeSearchText(root, { query: "NEEDLE", path: "long.txt" }),
    );
    const match = data.matches[0]!;

    expect(Array.from(match.preview)).toHaveLength(300);
    expect(match.preview).toContain("NEEDLE");
    expect(match.previewRange).toEqual({ startColumn: 51, endColumn: 350 });
    expect(match.firstMatchColumn).toBe(201);
    expect(match.previewTruncated).toBe(true);
  });
});

describe("search_text skipped files", () => {
  // 目录搜索应完整统计二进制、非法 UTF-8 和过大文件，同时按 Policy 限制可见跳过详情数量。
  it("reports bounded skip details for unsupported directory files", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "binary.txt"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(root, "invalid.txt"), Buffer.from([0x61, 0x80, 0x62]));
    await writeFile(join(root, "large.txt"), "x".repeat(30));
    await writeFile(join(root, "valid.txt"), "needle");

    const data = readSuccessData(
      await executeSearchText(
        root,
        { query: "needle" },
        { limits: { maxSearchFileBytes: 20, maxSkippedFileDetails: 2 } },
      ),
    );

    expect(data.matches.map((match) => match.path)).toEqual(["valid.txt"]);
    expect(data.skippedFileCount).toBe(3);
    expect(data.skippedFiles).toEqual([
      { path: "binary.txt", reason: "binary" },
      { path: "invalid.txt", reason: "invalid_utf8" },
    ]);
  });

  // 对单文件搜索时不能把不支持内容伪装成零匹配：二进制和非法编码直接失败，过大文件返回资源错误。
  it("fails directly for unsupported single files", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "binary.txt"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(root, "invalid.txt"), Buffer.from([0x61, 0x80, 0x62]));
    await writeFile(join(root, "large.txt"), "x".repeat(30));

    for (const path of ["binary.txt", "invalid.txt"]) {
      const output = await executeSearchText(root, { query: "x", path });
      expect(output.result).toMatchObject({
        ok: false,
        error: { code: "unsupported_content" },
      });
    }
    const large = await executeSearchText(
      root,
      { query: "x", path: "large.txt" },
      { limits: { maxSearchFileBytes: 20 } },
    );
    expect(large.result).toMatchObject({
      ok: false,
      error: { code: "resource_limit" },
    });
  });

  // 同一不可读文件在目录搜索中应计入 unreadable 跳过详情，显式单文件搜索则直接返回 access_denied。
  it("reports unreadable files according to search scope", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "unreadable.txt"), "needle");
    await writeFile(join(root, "visible.txt"), "needle");
    await chmod(join(root, "unreadable.txt"), 0);

    const directory = readSuccessData(await executeSearchText(root, { query: "needle" }));
    expect(directory.matches.map((match) => match.path)).toEqual(["visible.txt"]);
    expect(directory.skippedFileCount).toBe(1);
    expect(directory.skippedFiles).toEqual([{ path: "unreadable.txt", reason: "unreadable" }]);

    const single = await executeSearchText(root, {
      query: "needle",
      path: "unreadable.txt",
    });
    expect(single.result).toMatchObject({
      ok: false,
      error: { code: "access_denied" },
    });
  });
});

describe("search_text pagination and limits", () => {
  // 匹配先按稳定顺序生成再应用 offset/limit；分页不暴露总数，只在确有后续时给出 nextOffset。
  it("returns stable pages without a total count", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "a.txt"), "needle a1\nneedle a2");
    await writeFile(join(root, "b.txt"), "needle b1\nneedle b2");

    const page = readSuccessData(
      await executeSearchText(root, { query: "needle", offset: 1, limit: 2 }),
    );

    expect(page.matches.map((match) => [match.path, match.line])).toEqual([
      ["a.txt", 2],
      ["b.txt", 1],
    ]);
    expect(page.pagination).toEqual({
      offset: 1,
      limit: 2,
      returned: 2,
      hasMore: true,
      nextOffset: 3,
    });
    expect(page.pagination).not.toHaveProperty("total");
  });

  // 若下一条匹配会让完整成功 envelope 超出预算，应缩短当前页并返回 output_limit 与可继续 offset。
  it("truncates a page before the serialized output limit", async () => {
    const root = await createTemporaryDirectory();
    for (let index = 0; index < 6; index += 1) {
      await writeFile(join(root, `file-${index}.txt`), `${"x".repeat(90)}needle${"y".repeat(90)}`);
    }

    const output = await executeSearchText(
      root,
      { query: "needle", limit: 10 },
      { limits: { maxSerializedToolResultCharacters: 850 } },
    );
    const data = readSuccessData(output);

    expect(data.pagination.returned).toBeGreaterThan(0);
    expect(data.pagination.returned).toBeLessThan(6);
    expect(data.pagination).toMatchObject({
      hasMore: true,
      nextOffset: data.pagination.returned,
      truncatedBy: "output_limit",
    });
    expect(output.content.length).toBeLessThanOrEqual(850);
  });

  // 多文件扫描预计超过总字节硬上限时必须整体返回 resource_limit，不能交付部分匹配。
  it("fails when total scanned bytes exceed the hard limit", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, "a.txt"), "needle");
    await writeFile(join(root, "b.txt"), "needle");

    const output = await executeSearchText(
      root,
      { query: "needle" },
      { limits: { maxSearchTotalBytes: 10 } },
    );

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "resource_limit" },
    });
  });

  // 目录访问项超过遍历硬上限时必须沿用 walkFiles 的 resource_limit，而不是扫描已发现的子集。
  it("fails when traversal exceeds the hard entry limit", async () => {
    const root = await createTemporaryDirectory();
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(root, `file-${index}.txt`), "needle");
    }

    const output = await executeSearchText(
      root,
      { query: "needle" },
      { limits: { maxTraversalEntries: 3 } },
    );

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "resource_limit" },
    });
  });
});

describe("search_text errors and model contract", () => {
  // Registry schema 应拒绝缺失/越界 query、非法分页、错误选项类型和未声明字段。
  it("rejects invalid schema arguments", async () => {
    const root = await createTemporaryDirectory();
    const registry = createRegistry(root);
    const invalidArgs = [
      {},
      { query: "" },
      { query: "x".repeat(257) },
      { query: "x", caseSensitive: "yes" },
      { query: "x", offset: -1 },
      { query: "x", limit: 0 },
      { query: "x", limit: 201 },
      { query: "x", regex: true },
    ];

    for (const args of invalidArgs) {
      await expect(registry.execute("search_text", args)).resolves.toMatchObject({
        result: { ok: false, error: { code: "invalid_arguments" } },
      });
    }
  });

  // 部署 Policy 可以收紧结果上限，且缺失、敏感路径仍应保留 Workspace 的结构化错误。
  it("enforces policy result and path boundaries", async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, ".env"), "needle");

    const excessive = await executeSearchText(
      root,
      { query: "needle", limit: 3 },
      { limits: { maxResultLimit: 2 } },
    );
    expect(excessive.result).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });

    for (const testCase of [
      { path: "missing.txt", code: "path_not_found" },
      { path: ".env", code: "access_denied" },
    ]) {
      const output = await executeSearchText(root, { query: "needle", path: testCase.path });
      expect(output.result).toMatchObject({
        ok: false,
        error: { code: testCase.code },
      });
    }
  });

  // 模型只应看到完整 schema 和四段说明，Runtime 的并发资格不能泄漏到 ToolDefinition。
  it("publishes the search_text model contract", async () => {
    const root = await createTemporaryDirectory();
    const registry = createRegistry(root);
    const definition = registry.list().find((tool) => tool.name === "search_text");

    expect(definition).toEqual({
      name: "search_text",
      description: expect.any(String),
      parametersJsonSchema: expect.objectContaining({
        type: "object",
        required: ["query"],
        additionalProperties: false,
      }),
    });
    expect(definition?.description).toContain("Use when:");
    expect(definition?.description).toContain("Do not use when:");
    expect(definition?.description).toContain("Returns:");
    expect(definition?.description).toContain("Example:");
    expect(registry.getConcurrency("search_text")).toBe("safe");
  });
});
