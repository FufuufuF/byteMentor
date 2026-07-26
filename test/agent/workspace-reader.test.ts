import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as agentExports from "@byte-mentor/agent";
import type {
  WorkspaceAccessPolicy,
  WorkspaceReader,
  WorkspaceResolvedPath,
} from "@byte-mentor/agent";

type WorkspaceAccessPolicyConstructor = new () => WorkspaceAccessPolicy;
type WorkspaceReaderConstructor = new (input: {
  workspaceRoot: string;
  policy: WorkspaceAccessPolicy;
}) => WorkspaceReader;

const temporaryPaths = new Set<string>();

// 每个测试后删除它创建的真实目录和符号链接目标，避免文件系统状态跨用例泄漏。
afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  temporaryPaths.clear();
});

// 创建一个真实临时工作区并登记清理，供路径和符号链接边界测试使用。
async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "byte-mentor-workspace-"));
  temporaryPaths.add(root);
  return root;
}

// 从包公共入口创建默认 Policy，使尚未实现导出时产生可读的 RED 失败。
function createPolicy(): WorkspaceAccessPolicy {
  const candidate = (agentExports as Record<string, unknown>)["WorkspaceAccessPolicy"];
  expect(candidate).toBeTypeOf("function");
  if (typeof candidate !== "function") {
    throw new Error("WorkspaceAccessPolicy is not exported");
  }
  return new (candidate as WorkspaceAccessPolicyConstructor)();
}

// 从包公共入口创建 Reader，并固定显式 workspaceRoot，测试期间不依赖 process.cwd()。
function createReader(workspaceRoot: string): WorkspaceReader {
  const candidate = (agentExports as Record<string, unknown>)["WorkspaceReader"];
  expect(candidate).toBeTypeOf("function");
  if (typeof candidate !== "function") {
    throw new Error("WorkspaceReader is not exported");
  }
  return new (candidate as WorkspaceReaderConstructor)({
    workspaceRoot,
    policy: createPolicy(),
  });
}

// 统一断言 Reader 的预期失败携带稳定 WorkspaceError 名称和结构化错误码。
async function expectWorkspaceError(
  operation: Promise<WorkspaceResolvedPath>,
  code: string,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: "WorkspaceError",
    code,
  });
}

describe("WorkspaceReader.resolvePath", () => {
  // 普通相对路径和点路径应解析为平台无关相对路径，并返回真实目标类型而不暴露绝对路径。
  it("resolves allowed relative files and directories", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export {};\n");
    const reader = createReader(root);

    await expect(reader.resolvePath(".")).resolves.toEqual({
      path: ".",
      type: "directory",
      isSymbolicLink: false,
    });
    await expect(reader.resolvePath("src/../src/index.ts")).resolves.toEqual({
      path: "src/index.ts",
      type: "file",
      isSymbolicLink: false,
    });
  });

  // Tool 只接受工作区相对路径；这里验证绝对路径和词法 .. 越界在访问文件系统前被拒绝。
  it("rejects absolute paths and parent traversal", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "inside.txt"), "inside");
    const reader = createReader(root);

    await expectWorkspaceError(reader.resolvePath(resolve(root, "inside.txt")), "access_denied");
    await expectWorkspaceError(reader.resolvePath("../outside.txt"), "access_denied");
  });

  // 不存在的普通路径和断裂符号链接都应返回 path_not_found，避免泄漏底层 Node 错误格式。
  it("normalizes missing paths and broken symbolic links", async () => {
    const root = await createWorkspace();
    await symlink("missing-target.txt", join(root, "broken-link"));
    const reader = createReader(root);

    await expectWorkspaceError(reader.resolvePath("missing.txt"), "path_not_found");
    await expectWorkspaceError(reader.resolvePath("broken-link"), "path_not_found");
  });

  // 指向工作区内部的文件和目录链接允许访问，但返回路径仍保留调用方使用的工作区相对别名。
  it("allows symbolic links whose real targets stay inside the workspace", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export {};\n");
    await symlink("src/index.ts", join(root, "file-link"));
    await symlink("src", join(root, "directory-link"));
    const reader = createReader(root);

    await expect(reader.resolvePath("file-link")).resolves.toEqual({
      path: "file-link",
      type: "file",
      isSymbolicLink: true,
    });
    await expect(reader.resolvePath("directory-link")).resolves.toEqual({
      path: "directory-link",
      type: "directory",
      isSymbolicLink: true,
    });
  });

  // 外部目录故意使用工作区路径作为前缀；这里验证边界基于 canonical realpath，而不是易绕过的字符串 startsWith。
  it("rejects symbolic links whose real targets are outside the workspace", async () => {
    const root = await createWorkspace();
    const outside = `${root}-outside`;
    temporaryPaths.add(outside);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "external-link"));
    const reader = createReader(root);

    await expectWorkspaceError(reader.resolvePath("external-link"), "access_denied");
  });

  // 敏感目标不能通过工作区内的别名绕过；.env.example 则保持设计确认的显式例外。
  it("enforces denied paths on direct paths and symbolic-link targets", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "secret");
    await writeFile(join(root, ".env"), "TOKEN=secret\n");
    await writeFile(join(root, ".env.example"), "TOKEN=example\n");
    await symlink(".git/config", join(root, "git-config-link"));
    const reader = createReader(root);

    await expectWorkspaceError(reader.resolvePath(".git/config"), "access_denied");
    await expectWorkspaceError(reader.resolvePath(".env"), "access_denied");
    await expectWorkspaceError(reader.resolvePath("git-config-link"), "access_denied");
    await expect(reader.resolvePath(".env.example")).resolves.toEqual({
      path: ".env.example",
      type: "file",
      isSymbolicLink: false,
    });
  });
});
