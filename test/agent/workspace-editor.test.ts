import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as agentExports from "@byte-mentor/agent";
import type {
  WorkspaceAccessPolicy,
  WorkspaceAccessPolicyOverrides,
  WorkspaceEditor,
} from "@byte-mentor/agent";

type WorkspaceAccessPolicyConstructor = new (
  overrides?: WorkspaceAccessPolicyOverrides,
) => WorkspaceAccessPolicy;
type WorkspaceEditorConstructor = new (input: {
  workspaceRoot: string;
  policy: WorkspaceAccessPolicy;
}) => WorkspaceEditor;

const temporaryPaths = new Set<string>();

// 每个测试后删除它创建的真实目录、链接目标和特殊文件，避免文件系统状态跨用例泄漏。
afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  temporaryPaths.clear();
});

// 创建一个真实临时工作区并登记清理，供快照与写入边界测试使用。
async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "byte-mentor-workspace-"));
  temporaryPaths.add(root);
  return root;
}

// 从包公共入口创建 Policy，可传入 limits 覆盖来验证运行时只能降低编辑上限。
function createPolicy(overrides?: WorkspaceAccessPolicyOverrides): WorkspaceAccessPolicy {
  const candidate = (agentExports as Record<string, unknown>)["WorkspaceAccessPolicy"];
  expect(candidate).toBeTypeOf("function");
  if (typeof candidate !== "function") {
    throw new Error("WorkspaceAccessPolicy is not exported");
  }
  return new (candidate as WorkspaceAccessPolicyConstructor)(overrides);
}

// 从包公共入口创建 Editor，并固定显式 workspaceRoot，测试期间不依赖 process.cwd()。
function createEditor(
  workspaceRoot: string,
  overrides?: WorkspaceAccessPolicyOverrides,
): WorkspaceEditor {
  const candidate = (agentExports as Record<string, unknown>)["WorkspaceEditor"];
  expect(candidate).toBeTypeOf("function");
  if (typeof candidate !== "function") {
    throw new Error("WorkspaceEditor is not exported");
  }
  return new (candidate as WorkspaceEditorConstructor)({
    workspaceRoot,
    policy: createPolicy(overrides),
  });
}

// 统一断言 Editor 的预期失败携带稳定 WorkspaceError 名称和结构化错误码。
async function expectWorkspaceError(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ name: "WorkspaceError", code });
}

describe("WorkspaceEditor.readTextSnapshot", () => {
  // 读取普通 UTF-8 文本文件应返回工作区相对路径、原始正文和 BOM 标志，content 保留换行。
  it("reads a plain UTF-8 text file", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "inside.txt"), "hello\nworld\n");
    const editor = createEditor(root);

    const snapshot = await editor.readTextSnapshot("inside.txt");
    expect(snapshot).toEqual({
      path: "inside.txt",
      content: "hello\nworld\n",
      bom: false,
    });
  });

  // 带 UTF-8 BOM 的文件应把 BOM 从 content 中剥离，并通过 bom 标志告知调用方原始状态。
  it("detects and strips a UTF-8 BOM", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "inside.txt"), "\uFEFFhello\nworld\n");
    const editor = createEditor(root);

    const snapshot = await editor.readTextSnapshot("inside.txt");
    expect(snapshot).toEqual({
      path: "inside.txt",
      content: "hello\nworld\n",
      bom: true,
    });
  });

  // NUL 字节说明文件不是受支持的 UTF-8 文本，快照读取应返回 unsupported_content。
  it("rejects NUL binary content", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "bin.bin"), Buffer.from([0x61, 0x00, 0x62]));
    const editor = createEditor(root);

    await expectWorkspaceError(editor.readTextSnapshot("bin.bin"), "unsupported_content");
  });

  // 非法 UTF-8 字节序列不猜测其他编码，应返回 unsupported_content。
  it("rejects invalid UTF-8", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "bad.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
    const editor = createEditor(root);

    await expectWorkspaceError(editor.readTextSnapshot("bad.txt"), "unsupported_content");
  });

  // 目录不是可编辑文本文件，读取快照应返回 wrong_path_type。
  it("rejects directories as edit targets", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "dir"));
    const editor = createEditor(root);

    await expectWorkspaceError(editor.readTextSnapshot("dir"), "wrong_path_type");
  });

  // FIFO 等特殊文件既不是目录也不是可编辑普通文件，应返回 wrong_path_type。
  it("rejects special files such as FIFOs", async () => {
    const root = await createWorkspace();
    execFileSync("mkfifo", [join(root, "pipe")]);
    const editor = createEditor(root);

    await expectWorkspaceError(editor.readTextSnapshot("pipe"), "wrong_path_type");
  });

  // Editor 只接受工作区相对路径，绝对路径在访问文件系统前被拒绝。
  it("rejects absolute paths", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "x");
    const editor = createEditor(root);

    await expectWorkspaceError(editor.readTextSnapshot(resolve(root, "f.txt")), "access_denied");
  });

  // 词法 .. 越界路径不因字符串前缀合法而放行，应返回 access_denied。
  it("rejects parent-relative traversal", async () => {
    const root = await createWorkspace();
    const editor = createEditor(root);

    await expectWorkspaceError(editor.readTextSnapshot("../outside.txt"), "access_denied");
  });

  // 敏感路径与直接访问策略一样作用于 Editor，.env 应返回 access_denied。
  it("rejects denied paths", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, ".env"), "TOKEN=secret");
    const editor = createEditor(root);

    await expectWorkspaceError(editor.readTextSnapshot(".env"), "access_denied");
  });

  // 断裂符号链接没有可编辑目标，应返回 path_not_found。
  it("rejects broken symbolic links", async () => {
    const root = await createWorkspace();
    await symlink("missing-target.txt", join(root, "broken-link"));
    const editor = createEditor(root);

    await expectWorkspaceError(editor.readTextSnapshot("broken-link"), "path_not_found");
  });

  // 指向工作区外的链接按 canonical realpath 边界拒绝，不能通过别名读取外部文件。
  it("rejects symbolic links to external targets", async () => {
    const root = await createWorkspace();
    const outside = `${root}-outside`;
    temporaryPaths.add(outside);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "external-link"));
    const editor = createEditor(root);

    await expectWorkspaceError(editor.readTextSnapshot("external-link"), "access_denied");
  });

  // 指向工作区内文件的链接允许读取，快照 path 保留链接别名，content 来自真实目标。
  it("reads through an allowed symbolic link", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "real.txt"), "linked");
    await symlink("src/real.txt", join(root, "file-link"));
    const editor = createEditor(root);

    const snapshot = await editor.readTextSnapshot("file-link");
    expect(snapshot.path).toBe("file-link");
    expect(snapshot.content).toBe("linked");
    expect(snapshot.bom).toBe(false);
  });

  // 没有读权限但路径合法的文件应归一化为 access_denied，不泄漏底层权限错误。
  it("maps unreadable files to access_denied", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "locked.txt"), "secret");
    await chmod(join(root, "locked.txt"), 0o000);
    const editor = createEditor(root);

    await expectWorkspaceError(editor.readTextSnapshot("locked.txt"), "access_denied");
  });

  // 恰好达到 2 MiB 协议上限的文件应允许读取，不产生多余错误或截断。
  it("allows a file exactly at the 2 MiB protocol limit", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "exact.txt"), Buffer.alloc(2 * 1024 * 1024, 0x61));
    const editor = createEditor(root);

    const snapshot = await editor.readTextSnapshot("exact.txt");
    expect(snapshot.bom).toBe(false);
    expect(snapshot.content.length).toBe(2 * 1024 * 1024);
  });

  // 超过 2 MiB 协议上限的文件在读取前即返回 resource_limit。
  it("rejects a file over the 2 MiB protocol limit", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "too-big.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const editor = createEditor(root);

    await expectWorkspaceError(editor.readTextSnapshot("too-big.txt"), "resource_limit");
  });

  // 运行时可把编辑上限降到协议值以下，超过该运行时上限的文件同样被拒绝。
  it("honors a lower runtime edit limit", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "medium.txt"), "x".repeat(2048));
    const editor = createEditor(root, { limits: { maxEditableFileBytes: 1024 } });

    await expectWorkspaceError(editor.readTextSnapshot("medium.txt"), "resource_limit");
  });

  // 运行时即使把上限配置得高于协议 2 MiB，编辑器也钳制到协议硬上限，不能突破。
  it("clamps a runtime limit above the protocol hard cap", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "big.txt"), Buffer.alloc(3 * 1024 * 1024, 0x61));
    const editor = createEditor(root, { limits: { maxEditableFileBytes: 4 * 1024 * 1024 } });

    await expectWorkspaceError(editor.readTextSnapshot("big.txt"), "resource_limit");
  });

  // 文件在 stat 检查与读取之间增长到上限以上时，读取后的字节检查仍返回 resource_limit。
  it("rejects a file that grows past the limit after the initial stat", async () => {
    const root = await createWorkspace();
    const editor = createEditor(root, {
      limits: { maxEditableFileBytes: 8 * 1024 * 1024 },
    });
    await writeFile(join(root, "grow.txt"), Buffer.alloc(8 * 1024 * 1024, 0x61));

    const pending = editor.readTextSnapshot("grow.txt");
    const growth = setInterval(async () => {
      await appendFile(join(root, "grow.txt"), Buffer.alloc(64 * 1024, 0x62));
    }, 1);
    try {
      await expectWorkspaceError(pending, "resource_limit");
    } finally {
      clearInterval(growth);
    }
  });
});

describe("WorkspaceEditor.writeTextAtomically", () => {
  // 原子写入用完整新内容替换旧内容，读取到的应是新内容而不是部分写入结果。
  it("atomically replaces file content", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "old content");
    const editor = createEditor(root);

    await editor.writeTextAtomically("f.txt", "new content");
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("new content");
  });

  // 原子替换成功后保留原文件的权限 mode，不因临时文件初始 0600 而丢失权限。
  it("preserves the target file mode", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "old");
    await chmod(join(root, "f.txt"), 0o640);
    const editor = createEditor(root);

    await editor.writeTextAtomically("f.txt", "new");
    expect((await stat(join(root, "f.txt"))).mode & 0o777).toBe(0o640);
  });

  // 编辑工作区内符号链接时写入真实目标并保留链接目录项，不用普通文件替换链接本身。
  it("preserves a workspace symlink and edits its real target", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "real.txt"), "old");
    await symlink("real.txt", join(root, "link.txt"));
    const editor = createEditor(root);

    await editor.writeTextAtomically("link.txt", "updated");
    expect(await readFile(join(root, "real.txt"), "utf8")).toBe("updated");
    expect((await lstat(join(root, "link.txt"))).isSymbolicLink()).toBe(true);
  });

  // 目录目标不进入写入阶段，应返回 wrong_path_type 且目录内容保持不变。
  it("rejects directory targets without writing", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "inside.txt"), "keep");
    const editor = createEditor(root);

    await expectWorkspaceError(editor.writeTextAtomically("dir", "data"), "wrong_path_type");
    expect(await readFile(join(root, "dir", "inside.txt"), "utf8")).toBe("keep");
  });

  // 目录不可写时临时文件创建失败，目标文件保持原内容且不留下任何临时文件。
  it("cleans up the temp file and keeps the target on write failure", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "original");
    await chmod(root, 0o555);
    const editor = createEditor(root);
    try {
      await expectWorkspaceError(editor.writeTextAtomically("f.txt", "new"), "access_denied");
    } finally {
      await chmod(root, 0o755);
    }
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("original");
    expect(await readdir(root)).not.toContainEqual(expect.stringMatching(/^\.byte-mentor-tmp-/));
  });

  // 成功写入只影响目标文件，目录中的其他文件包括临时名前缀文件都保持原内容。
  it("does not overwrite other files including temp-prefixed names", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "old");
    await writeFile(join(root, ".byte-mentor-tmp-stale"), "stale");
    const editor = createEditor(root);

    await editor.writeTextAtomically("f.txt", "new");
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("new");
    expect(await readFile(join(root, ".byte-mentor-tmp-stale"), "utf8")).toBe("stale");
  });

  // 超过可编辑上限的内容在创建临时文件前即返回 resource_limit，目标文件保持不变。
  it("rejects oversized content without modifying the target", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "old");
    const editor = createEditor(root);

    await expectWorkspaceError(
      editor.writeTextAtomically("f.txt", "x".repeat(2 * 1024 * 1024 + 1)),
      "resource_limit",
    );
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("old");
  });

  // 成功写入后临时文件应已被 rename 走，目标目录不残留任何临时文件。
  it("leaves no temp file after a successful write", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "old");
    const editor = createEditor(root);

    await editor.writeTextAtomically("f.txt", "new");
    expect(await readdir(root)).not.toContainEqual(expect.stringMatching(/^\.byte-mentor-tmp-/));
  });
});
