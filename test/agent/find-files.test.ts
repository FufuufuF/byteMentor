import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

interface FileMatchData {
  name: string;
  path: string;
  type: "file" | "symbolic_link";
  sizeBytes: number;
  targetType?: "file";
}

interface FindFilesData {
  path: string;
  query: string;
  caseSensitive: boolean;
  matches: FileMatchData[];
  pagination: {
    offset: number;
    limit: number;
    returned: number;
    hasMore: boolean;
    nextOffset?: number;
    truncatedBy?: "output_limit";
  };
}

const temporaryPaths = new Set<string>();

// 每个用例结束后删除真实工作区、外部目标和符号链接，避免递归遍历状态跨测试泄漏。
afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  temporaryPaths.clear();
});

// 创建并登记真实临时目录，使遍历、文件大小和 canonical 符号链接行为来自实际文件系统。
async function createTemporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.add(path);
  return path;
}

// 从包公共入口取得 find_files Tool，使缺少 Batch 4 导出时以明确断言进入 RED。
function getFindFilesTool(): AgentTool {
  const candidate = (agentExports as Record<string, unknown>)["findFilesTool"];
  expect(candidate).toBeTypeOf("object");
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("findFilesTool is not exported");
  }
  return candidate as AgentTool;
}

// 用同一 Policy 组装 Reader 与 Registry，确保遍历和最终序列化共享调用方配置的硬上限。
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
  registry.register(getFindFilesTool());
  return registry;
}

// 通过 Registry 执行 find_files，返回对象结果与 ToolMessage JSON 供成功、失败和预算断言复用。
async function executeFindFiles(
  workspaceRoot: string,
  args: unknown,
  overrides?: WorkspaceAccessPolicyOverrides,
): Promise<ToolExecutionOutput> {
  return createRegistry(workspaceRoot, overrides).execute("find_files", args);
}

// 确认 Tool 成功后取得 find_files payload，集中处理 ToolResult 判别，保持各用例聚焦业务行为。
function readSuccessData(output: ToolExecutionOutput): FindFilesData {
  expect(output.result.ok).toBe(true);
  if (!output.result.ok) {
    throw new Error(`expected success, received ${output.result.error.code}`);
  }
  return output.result.data as unknown as FindFilesData;
}

describe("find_files literal matching", () => {
  // 查询应同时匹配文件名和完整工作区相对路径；默认参数从根目录执行大小写不敏感搜索并返回文件元数据。
  it("matches file names and workspace-relative paths", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    await mkdir(join(root, "src"));
    await mkdir(join(root, "docs", "chapter-one"), { recursive: true });
    await mkdir(join(root, "chapter-one-empty"));
    await writeFile(join(root, "src", "Guide.TS"), "guide");
    await writeFile(join(root, "docs", "chapter-one", "note.md"), "note");

    const nameMatch = readSuccessData(await executeFindFiles(root, { query: "guide" }));
    expect(nameMatch).toEqual({
      path: ".",
      query: "guide",
      caseSensitive: false,
      matches: [
        {
          name: "Guide.TS",
          path: "src/Guide.TS",
          type: "file",
          sizeBytes: 5,
        },
      ],
      pagination: { offset: 0, limit: 50, returned: 1, hasMore: false },
    });

    const pathMatch = readSuccessData(
      await executeFindFiles(root, { query: "chapter-one", path: "docs" }),
    );
    expect(pathMatch.matches).toEqual([
      {
        name: "note.md",
        path: "docs/chapter-one/note.md",
        type: "file",
        sizeBytes: 4,
      },
    ]);
  });

  // 文件正文包含查询词但文件名和路径均不包含时不能命中，确保 find_files 没有混入内容搜索职责。
  it("does not search file contents", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    await writeFile(join(root, "plain.txt"), "unique needle inside content");

    const data = readSuccessData(await executeFindFiles(root, { query: "needle" }));

    expect(data.matches).toEqual([]);
    expect(data.pagination).toEqual({
      offset: 0,
      limit: 50,
      returned: 0,
      hasMore: false,
    });
  });

  // 默认搜索忽略大小写，显式开启 caseSensitive 后同一小写查询不能匹配含大写字母的文件名。
  it("honors the caseSensitive option", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    await writeFile(join(root, "Report.TS"), "report");

    const insensitive = readSuccessData(await executeFindFiles(root, { query: "report" }));
    const sensitive = readSuccessData(
      await executeFindFiles(root, { query: "report", caseSensitive: true }),
    );

    expect(insensitive.matches.map((match) => match.path)).toEqual(["Report.TS"]);
    expect(sensitive.matches).toEqual([]);
  });
});

describe("find_files traversal boundaries", () => {
  // 默认递归应完全跳过敏感路径和高噪声目录；指向被排除真实目录的别名也不能绕过 canonical 目标策略。
  it("excludes denied and noisy paths", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    await mkdir(join(root, "src"));
    for (const directory of ["node_modules", "dist", "build", "coverage", ".git", ".byte-mentor"]) {
      await mkdir(join(root, directory));
      await writeFile(join(root, directory, "hidden-match.js"), directory);
    }
    await writeFile(join(root, "src", "visible-match.ts"), "visible");
    await writeFile(join(root, ".env.match"), "secret");
    await symlink("node_modules", join(root, "vendor-alias"));

    const data = readSuccessData(await executeFindFiles(root, { query: "match" }));

    expect(data.matches.map((match) => match.path)).toEqual(["src/visible-match.ts"]);
  });

  // 目录真实路径只遍历一次：稳定顺序先到的别名提供结果路径，循环、重复目录及外部或断裂链接均被安全跳过。
  it("deduplicates canonical directories and skips unsafe links", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    const outside = await createTemporaryDirectory("byte-mentor-outside-");
    await mkdir(join(root, "shared"));
    await writeFile(join(root, "shared", "target.ts"), "abc");
    await writeFile(join(outside, "outside.ts"), "outside");
    await symlink("shared", join(root, "alias"));
    await symlink(".", join(root, "loop"));
    await symlink("shared/target.ts", join(root, "target-link.ts"));
    await symlink("missing.ts", join(root, "broken.ts"));
    await symlink(join(outside, "outside.ts"), join(root, "external-file.ts"));
    await symlink(outside, join(root, "external-directory"));

    const data = readSuccessData(await executeFindFiles(root, { query: ".ts" }));

    expect(data.matches).toEqual([
      {
        name: "target.ts",
        path: "alias/target.ts",
        type: "file",
        sizeBytes: 3,
      },
      {
        name: "target-link.ts",
        path: "target-link.ts",
        type: "symbolic_link",
        sizeBytes: 3,
        targetType: "file",
      },
    ]);
  });

  // Tool 参数不能越过 workspaceRoot；真实父目录和指向外部目录的工作区链接都必须返回 access_denied，而非扫描其内容。
  it("rejects directories outside the workspace", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    const outside = await createTemporaryDirectory("byte-mentor-outside-");
    await writeFile(join(outside, "secret.ts"), "outside");
    await symlink(outside, join(root, "outside-directory"));

    for (const path of [relative(root, outside), "outside-directory"]) {
      const output = await executeFindFiles(root, { query: ".ts", path });
      expect(output.result).toMatchObject({
        ok: false,
        error: { code: "access_denied" },
      });
    }
  });

  // 递归访问的目录项超过 Policy 硬上限时必须返回 resource_limit，不能把已找到的部分文件包装成成功结果。
  it("fails when traversal exceeds the hard entry limit", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(root, `file-${index}.ts`), "x");
    }

    const output = await executeFindFiles(
      root,
      { query: "file" },
      { limits: { maxTraversalEntries: 3 } },
    );

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "resource_limit" },
    });
  });
});

describe("find_files pagination", () => {
  // 匹配结果先按完整相对路径稳定排序再应用 offset；成功分页不泄露总数，只在确有后续结果时返回 nextOffset。
  it("returns stable pages without a total count", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    await mkdir(join(root, "m"));
    await writeFile(join(root, "z.ts"), "z");
    await writeFile(join(root, "a.ts"), "a");
    await writeFile(join(root, "m", "n.ts"), "n");

    const page = readSuccessData(
      await executeFindFiles(root, { query: ".ts", offset: 1, limit: 1 }),
    );
    expect(page.matches.map((match) => match.path)).toEqual(["m/n.ts"]);
    expect(page.pagination).toEqual({
      offset: 1,
      limit: 1,
      returned: 1,
      hasMore: true,
      nextOffset: 2,
    });
    expect(page.pagination).not.toHaveProperty("total");

    const emptyPage = readSuccessData(
      await executeFindFiles(root, { query: ".ts", offset: 10, limit: 2 }),
    );
    expect(emptyPage.matches).toEqual([]);
    expect(emptyPage.pagination).toEqual({
      offset: 10,
      limit: 2,
      returned: 0,
      hasMore: false,
    });
  });

  // 若下一条匹配会让完整成功 envelope 超出字符预算，应缩短当前页并返回 output_limit 与可继续的 nextOffset。
  it("truncates a page before exceeding the serialized output budget", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(root, `entry-${index}-${"x".repeat(40)}.txt`), "x");
    }

    const output = await executeFindFiles(
      root,
      { query: "entry", limit: 10 },
      { limits: { maxSerializedToolResultCharacters: 500 } },
    );
    const data = readSuccessData(output);

    expect(data.pagination.returned).toBeGreaterThan(0);
    expect(data.pagination.returned).toBeLessThan(8);
    expect(data.pagination).toMatchObject({
      offset: 0,
      limit: 10,
      hasMore: true,
      nextOffset: data.pagination.returned,
      truncatedBy: "output_limit",
    });
    expect(data.pagination).not.toHaveProperty("total");
    expect(JSON.parse(output.content)).toEqual(output.result);
    expect(output.content.length).toBeLessThanOrEqual(500);
  });
});

describe("find_files errors", () => {
  // find_files 的起点必须是目录；传入普通文件时应返回 wrong_path_type，而不是底层 ENOTDIR 或 execution_failed。
  it("returns wrong_path_type for a file path", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    await writeFile(join(root, "file.ts"), "content");

    const output = await executeFindFiles(root, { query: ".ts", path: "file.ts" });

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "wrong_path_type" },
    });
  });

  // Registry schema 应拒绝缺失或越界 query、错误选项类型、非法分页值和未声明字段，统一返回 invalid_arguments。
  it("rejects invalid schema arguments", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    const registry = createRegistry(root);
    const invalidArgs = [
      {},
      { query: "" },
      { query: "x".repeat(257) },
      { query: "x", caseSensitive: "yes" },
      { query: "x", offset: -1 },
      { query: "x", limit: 0 },
      { query: "x", limit: 201 },
      { query: "x", recursive: true },
    ];

    for (const args of invalidArgs) {
      await expect(registry.execute("find_files", args)).resolves.toMatchObject({
        result: { ok: false, error: { code: "invalid_arguments" } },
      });
    }
  });

  // Policy 可以把部署环境结果上限收紧到 schema 上限以内；Tool 必须拒绝超过该配置的 limit。
  it("rejects a limit above the configured policy maximum", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");

    const output = await executeFindFiles(
      root,
      { query: "x", limit: 3 },
      { limits: { maxResultLimit: 2 } },
    );

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });
});

describe("find_files model definition", () => {
  // 模型说明必须区分文件路径查找与内容搜索；schema 固定查询长度、默认值、范围和未知字段拒绝规则。
  it("publishes complete guidance and parameter schema", async () => {
    const root = await createTemporaryDirectory("byte-mentor-find-");
    const registry = createRegistry(root);
    const definition = registry.list()[0];

    expect(definition?.name).toBe("find_files");
    expect(definition?.description).toContain("Use when:");
    expect(definition?.description).toContain("Do not use when:");
    expect(definition?.description).toContain("Returns:");
    expect(definition?.description).toContain("Example:");
    expect(definition?.parametersJsonSchema).toMatchObject({
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 256 },
        path: { type: "string", default: "." },
        caseSensitive: { type: "boolean", default: false },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    });
    expect(registry.getConcurrency("find_files")).toBe("safe");
  });
});
