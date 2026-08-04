import { randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { WorkspaceError, WorkspacePathResolver } from "./workspace-path-resolver.js";
import type { WorkspaceAccessPolicy } from "./workspace-policy.js";

export interface WorkspaceEditableSnapshot {
  path: string;
  content: string;
  bom: boolean;
}

// 可编辑文件原始字节的协议硬上限，运行时只能通过 Policy 降低、不能提高。
const PROTOCOL_MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;

export class WorkspaceEditor {
  readonly workspaceRoot: string;
  readonly policy: WorkspaceAccessPolicy;
  private readonly resolver: WorkspacePathResolver;

  // 固定显式工作区根目录和访问策略，并复用共享解析器执行所有路径边界校验。
  constructor(input: { workspaceRoot: string; policy: WorkspaceAccessPolicy }) {
    this.workspaceRoot = resolve(input.workspaceRoot);
    this.policy = input.policy;
    this.resolver = new WorkspacePathResolver({
      workspaceRoot: this.workspaceRoot,
      policy: input.policy,
    });
  }

  // 读取一个工作区内可编辑文本文件的完整快照，剥离 BOM 并执行严格文本与大小校验。
  async readTextSnapshot(path: string): Promise<WorkspaceEditableSnapshot> {
    const resolved = await this.resolver.resolveAccessiblePath(path);
    if (resolved.type !== "file") {
      throw new WorkspaceError(
        "wrong_path_type",
        `workspace path is not a file: ${resolved.relativePath}`,
      );
    }

    const fileLimit = this.editableFileLimit();
    let metadata;
    try {
      metadata = await stat(resolved.absolutePath);
    } catch (error) {
      throw normalizeEditorError(error);
    }
    if (metadata.size > fileLimit) {
      throw new WorkspaceError(
        "resource_limit",
        `file exceeds the ${fileLimit} byte edit limit: ${resolved.relativePath}`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(resolved.absolutePath);
    } catch (error) {
      throw normalizeEditorError(error);
    }
    if (bytes.length > fileLimit) {
      throw new WorkspaceError(
        "resource_limit",
        `file exceeds the ${fileLimit} byte edit limit: ${resolved.relativePath}`,
      );
    }
    if (bytes.includes(0)) {
      throw new WorkspaceError("unsupported_content", "file contains NUL binary content");
    }

    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const contentBytes = bom ? bytes.subarray(3) : bytes;
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
    } catch {
      throw new WorkspaceError("unsupported_content", "file is not valid UTF-8 text");
    }
    return { path: resolved.relativePath, content, bom };
  }

  // 原子替换一个工作区内文本文件的完整内容：同目录临时文件加 rename，成功保留原文件权限。
  async writeTextAtomically(path: string, content: string): Promise<void> {
    const resolved = await this.resolver.resolveAccessiblePath(path);
    if (resolved.type !== "file") {
      throw new WorkspaceError(
        "wrong_path_type",
        `workspace path is not a file: ${resolved.relativePath}`,
      );
    }

    // 编辑链接时以真实目标为写入对象并保留链接目录项，临时文件与 rename 都围绕真实目标。
    const writeTarget = resolved.isSymbolicLink ? resolved.canonicalTarget : resolved.absolutePath;
    const fileLimit = this.editableFileLimit();
    if (Buffer.byteLength(content, "utf-8") > fileLimit) {
      throw new WorkspaceError(
        "resource_limit",
        `file content exceeds the ${fileLimit} byte edit limit: ${resolved.relativePath}`,
      );
    }

    let targetMode: number;
    try {
      const targetMetadata = await stat(writeTarget);
      if (targetMetadata.size > fileLimit) {
        throw new WorkspaceError(
          "resource_limit",
          `file exceeds the ${fileLimit} byte edit limit: ${resolved.relativePath}`,
        );
      }
      targetMode = targetMetadata.mode & 0o777;
    } catch (error) {
      if (error instanceof WorkspaceError) {
        throw error;
      }
      throw normalizeEditorError(error);
    }

    let tempPath: string | undefined;
    try {
      tempPath = await createExclusiveTempFile(dirname(writeTarget));
      await writeFile(tempPath, content);
      await chmod(tempPath, targetMode);
      await rename(tempPath, writeTarget);
      tempPath = undefined;
    } catch (error) {
      if (tempPath !== undefined) {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
      throw normalizeEditorError(error);
    }
  }

  // 返回实际可编辑文件大小上限，运行时配置只能把协议硬上限降得更低。
  private editableFileLimit(): number {
    return Math.min(this.policy.limits.maxEditableFileBytes, PROTOCOL_MAX_EDITABLE_FILE_BYTES);
  }
}

// 以不可预测随机名称和 exclusive create 在指定目录创建一个 mode 0600 的临时文件，避开名称碰撞。
async function createExclusiveTempFile(directory: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(directory, `.byte-mentor-tmp-${randomBytes(16).toString("hex")}`);
    try {
      const handle = await open(candidate, "wx", 0o600);
      await handle.close();
      return candidate;
    } catch (error) {
      if (isFileExistsError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new WorkspaceError("execution_failed", "unable to create a unique temporary file");
}

// 把底层文件系统错误归一化为稳定工作区错误码，未预期错误保持原样交给 Registry 兜底。
function normalizeEditorError(error: unknown): unknown {
  if (error instanceof WorkspaceError) {
    return error;
  }
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return error;
  }
  if (error.code === "EACCES" || error.code === "EPERM") {
    return new WorkspaceError("access_denied", "workspace file is not readable or writable");
  }
  if (error.code === "ENOENT" || error.code === "ENOTDIR") {
    return new WorkspaceError("path_not_found", "workspace path does not exist");
  }
  if (error.code === "EISDIR") {
    return new WorkspaceError("wrong_path_type", "workspace path is not a file");
  }
  return error;
}

// 识别 exclusive create 的目标已存在错误，使临时文件命名碰撞时换名重试而不覆盖既有文件。
function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
