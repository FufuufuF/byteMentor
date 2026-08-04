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

interface DirectoryEntryData {
  name: string;
  path: string;
  type: "file" | "directory" | "symbolic_link" | "other";
  access: "allowed" | "denied";
  sizeBytes?: number;
  targetType?: "file" | "directory" | "other" | "missing";
}

interface ListDirectoryData {
  path: string;
  entries: DirectoryEntryData[];
  pagination: {
    offset: number;
    limit: number;
    returned: number;
    total: number;
    hasMore: boolean;
    nextOffset?: number;
    truncatedBy?: "output_limit";
  };
}

const temporaryPaths = new Set<string>();

// 每个用例后删除真实工作区及外部符号链接目标，防止文件系统状态影响后续测试。
afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  temporaryPaths.clear();
});

// 创建并登记一个真实临时目录，使目录项元数据和符号链接行为由 Node 文件系统实际提供。
async function createTemporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.add(path);
  return path;
}

// 从包公共入口取得 list_directory Tool，使未实现导出时以明确断言进入 RED。
function getListDirectoryTool(): AgentTool {
  const candidate = (agentExports as Record<string, unknown>)["listDirectoryTool"];
  expect(candidate).toBeTypeOf("object");
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("listDirectoryTool is not exported");
  }
  return candidate as AgentTool;
}

// 使用显式 Policy、Reader 和 Registry 组装真实 Tool 执行路径，并让二者共享同一序列化上限。
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
  registry.register(getListDirectoryTool());
  return registry;
}

// 执行 list_directory 并返回 Registry 的对象结果与 JSON content，供成功、失败和输出预算断言复用。
async function executeListDirectory(
  workspaceRoot: string,
  args: unknown,
  overrides?: WorkspaceAccessPolicyOverrides,
): Promise<ToolExecutionOutput> {
  return createRegistry(workspaceRoot, overrides).execute("list_directory", args);
}

// 确认 Tool 成功后取得 list_directory payload，避免每个测试重复判别 ToolResult 联合类型。
function readSuccessData(output: ToolExecutionOutput): ListDirectoryData {
  expect(output.result.ok).toBe(true);
  if (!output.result.ok) {
    throw new Error(`expected success, received ${output.result.error.code}`);
  }
  return output.result.data as unknown as ListDirectoryData;
}

describe("list_directory entries", () => {
  // 在规范化后的子目录中列举普通文件和目录，验证只返回直接子项、文件字节数、稳定名称顺序和正斜杠路径。
  it("lists direct entries with stable paths and metadata", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");
    await mkdir(join(root, "src", "Alpha"), { recursive: true });
    await writeFile(join(root, "src", "Alpha", "nested.txt"), "not listed");
    await writeFile(join(root, "src", "zeta.txt"), "abc");
    await writeFile(join(root, "src", "éclair.txt"), "é");

    const data = readSuccessData(await executeListDirectory(root, { path: "src/../src" }));

    expect(data.path).toBe("src");
    expect(data.entries).toEqual([
      { name: "Alpha", path: "src/Alpha", type: "directory", access: "allowed" },
      { name: "zeta.txt", path: "src/zeta.txt", type: "file", access: "allowed", sizeBytes: 3 },
      {
        name: "éclair.txt",
        path: "src/éclair.txt",
        type: "file",
        access: "allowed",
        sizeBytes: 2,
      },
    ]);
  });

  // 工作区内文件和目录链接应显示真实目标类型；断裂链接仍可见，但明确标记 missing 供模型判断。
  it("reports allowed and broken symbolic-link targets", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");
    await mkdir(join(root, "targets"));
    await writeFile(join(root, "targets", "file.txt"), "target");
    await symlink("targets/file.txt", join(root, "file-link"));
    await symlink("targets", join(root, "directory-link"));
    await symlink("missing.txt", join(root, "broken-link"));

    const data = readSuccessData(await executeListDirectory(root, {}));

    expect(data.entries.find((entry) => entry.name === "file-link")).toEqual({
      name: "file-link",
      path: "file-link",
      type: "symbolic_link",
      access: "allowed",
      targetType: "file",
    });
    expect(data.entries.find((entry) => entry.name === "directory-link")).toEqual({
      name: "directory-link",
      path: "directory-link",
      type: "symbolic_link",
      access: "allowed",
      targetType: "directory",
    });
    expect(data.entries.find((entry) => entry.name === "broken-link")).toEqual({
      name: "broken-link",
      path: "broken-link",
      type: "symbolic_link",
      access: "allowed",
      targetType: "missing",
    });
  });

  // 敏感子项及指向敏感或外部目标的链接只能显示名称、路径、类型和 denied；再次进入敏感目录必须失败。
  it("minimizes denied entries and prevents entering them", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");
    const outside = await createTemporaryDirectory("byte-mentor-outside-");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "secret");
    await writeFile(join(root, ".env"), "TOKEN=secret\n");
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(".env", join(root, "env-link"));
    await symlink(join(outside, "secret.txt"), join(root, "external-link"));

    const rootOutput = await executeListDirectory(root, {});
    const entries = readSuccessData(rootOutput).entries;

    expect(entries.find((entry) => entry.name === ".git")).toEqual({
      name: ".git",
      path: ".git",
      type: "directory",
      access: "denied",
    });
    expect(entries.find((entry) => entry.name === ".env")).toEqual({
      name: ".env",
      path: ".env",
      type: "file",
      access: "denied",
    });
    expect(entries.find((entry) => entry.name === "env-link")).toEqual({
      name: "env-link",
      path: "env-link",
      type: "symbolic_link",
      access: "denied",
    });
    expect(entries.find((entry) => entry.name === "external-link")).toEqual({
      name: "external-link",
      path: "external-link",
      type: "symbolic_link",
      access: "denied",
    });

    const deniedOutput = await executeListDirectory(root, { path: ".git" });
    expect(deniedOutput.result).toMatchObject({
      ok: false,
      error: { code: "access_denied" },
    });
  });
});

describe("list_directory pagination", () => {
  // offset 和 limit 应在稳定排序后选取页面；有后续条目时 nextOffset 指向下一项，越过末尾则返回无续页空页。
  it("paginates entries and returns an empty page beyond the end", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      await writeFile(join(root, name), name);
    }

    const page = readSuccessData(
      await executeListDirectory(root, { path: ".", offset: 1, limit: 2 }),
    );
    expect(page.entries.map((entry) => entry.name)).toEqual(["b.txt", "c.txt"]);
    expect(page.pagination).toEqual({
      offset: 1,
      limit: 2,
      returned: 2,
      total: 4,
      hasMore: true,
      nextOffset: 3,
    });

    const emptyPage = readSuccessData(
      await executeListDirectory(root, { path: ".", offset: 10, limit: 2 }),
    );
    expect(emptyPage.entries).toEqual([]);
    expect(emptyPage.pagination).toEqual({
      offset: 10,
      limit: 2,
      returned: 0,
      total: 4,
      hasMore: false,
    });
  });

  // 完全省略参数时应浏览工作区根目录，并从 Policy 读取默认 offset 0 和 limit 50。
  it("uses root-path and policy pagination defaults", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");
    await writeFile(join(root, "readme.md"), "docs");

    const data = readSuccessData(await executeListDirectory(root, {}));

    expect(data.path).toBe(".");
    expect(data.pagination).toEqual({
      offset: 0,
      limit: 50,
      returned: 1,
      total: 1,
      hasMore: false,
    });
  });

  // 当下一条目录项会让完整成功 envelope 超过字符预算时，应提前结束本页并提供可继续的 nextOffset，而非返回破损 JSON。
  it("truncates a page before exceeding the serialized output budget", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(root, `entry-${index}-${"x".repeat(40)}.txt`), "x");
    }

    const output = await executeListDirectory(
      root,
      { limit: 10 },
      { limits: { maxSerializedToolResultCharacters: 500 } },
    );
    const data = readSuccessData(output);

    expect(data.pagination.returned).toBeGreaterThan(0);
    expect(data.pagination.returned).toBeLessThan(data.pagination.total);
    expect(data.pagination).toMatchObject({
      offset: 0,
      limit: 10,
      total: 8,
      hasMore: true,
      nextOffset: data.pagination.returned,
      truncatedBy: "output_limit",
    });
    expect(JSON.parse(output.content)).toEqual(output.result);
    expect(output.content.length).toBeLessThanOrEqual(500);
  });
});

describe("list_directory errors", () => {
  // 即使工作区外目录真实存在，调用方用 .. 指向它时也必须在读取目录内容前返回 access_denied。
  it("rejects a parent-relative directory outside the workspace", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");
    const outside = await createTemporaryDirectory("byte-mentor-outside-");
    await writeFile(join(outside, "secret.txt"), "outside");

    const output = await executeListDirectory(root, { path: relative(root, outside) });

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "access_denied" },
    });
  });

  // 工作区内的目录链接不能成为边界绕过入口；链接最终指向外部目录时，直接列举该链接必须失败。
  it("rejects an external directory reached through a symbolic link", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");
    const outside = await createTemporaryDirectory("byte-mentor-outside-");
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(root, "outside-directory"));

    const output = await executeListDirectory(root, { path: "outside-directory" });

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "access_denied" },
    });
  });

  // Registry schema 应在执行前拒绝零 limit、超过全局 200 上限的 limit 和未声明字段，统一返回 invalid_arguments。
  it("rejects invalid schema arguments", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");
    const registry = createRegistry(root);

    for (const args of [{ limit: 0 }, { limit: 201 }, { recursive: true }]) {
      await expect(registry.execute("list_directory", args)).resolves.toMatchObject({
        result: { ok: false, error: { code: "invalid_arguments" } },
      });
    }
  });

  // Policy 可把部署环境的结果上限收紧到 schema 上限以内；Tool 必须拒绝更大的请求，不能只依赖静态 schema。
  it("rejects a limit above the configured policy maximum", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");

    const output = await executeListDirectory(
      root,
      { limit: 3 },
      { limits: { maxResultLimit: 2 } },
    );

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });

  // list_directory 只能浏览目录；传入普通文件时应返回可修正的 wrong_path_type，而不是底层 ENOTDIR 或 execution_failed。
  it("returns wrong_path_type for a file path", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");
    await writeFile(join(root, "file.txt"), "content");

    const output = await executeListDirectory(root, { path: "file.txt" });

    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "wrong_path_type" },
    });
  });
});

describe("list_directory model definition", () => {
  // 模型说明必须明确适用场景、反例、返回结构和示例；schema 同时固定默认值、范围与未知字段拒绝规则。
  it("publishes complete guidance and parameter schema", async () => {
    const root = await createTemporaryDirectory("byte-mentor-list-");
    const registry = createRegistry(root);
    const definition = registry.list()[0];

    expect(definition?.name).toBe("list_directory");
    expect(definition?.description).toContain("Use when:");
    expect(definition?.description).toContain("Do not use when:");
    expect(definition?.description).toContain("Returns:");
    expect(definition?.description).toContain("Example:");
    expect(definition?.parametersJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", default: "." },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    });
    expect(registry.getConcurrency("list_directory")).toBe("safe");
  });
});
