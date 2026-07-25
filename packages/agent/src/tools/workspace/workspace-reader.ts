import type { Stats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { JsonObject, ToolErrorCode } from "../contracts.js";
import type { WorkspaceAccessPolicy } from "./workspace-policy.js";

export interface WorkspaceResolvedPath {
  path: string;
  type: "file" | "directory" | "other";
  isSymbolicLink: boolean;
}

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symbolic_link" | "other";
  access: "allowed" | "denied";
  sizeBytes?: number;
  targetType?: "file" | "directory" | "other" | "missing";
}

export interface WorkspaceDirectoryListing {
  path: string;
  entries: WorkspaceDirectoryEntry[];
}

export class WorkspaceError extends Error {
  readonly code: ToolErrorCode;
  readonly details?: JsonObject;

  // 创建一个带稳定错误码和可选 JSON 详情的预期工作区失败，屏蔽底层文件系统错误格式。
  constructor(code: ToolErrorCode, message: string, details?: JsonObject) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.details = details;
  }
}

export class WorkspaceReader {
  readonly workspaceRoot: string;
  readonly policy: WorkspaceAccessPolicy;
  private readonly canonicalWorkspaceRoot: Promise<string>;

  // 固定显式工作区根目录和访问策略，并预先启动根目录真实路径解析供所有访问复用。
  constructor(input: { workspaceRoot: string; policy: WorkspaceAccessPolicy }) {
    this.workspaceRoot = resolve(input.workspaceRoot);
    this.policy = input.policy;
    this.canonicalWorkspaceRoot = realpath(this.workspaceRoot);
  }

  // 解析并校验一个工作区相对路径，返回稳定的相对别名、真实目标类型和链接属性。
  async resolvePath(path: string): Promise<WorkspaceResolvedPath> {
    const requestedPath = this.resolveLexicalPath(path);
    if (this.policy.isDenied(requestedPath.relativePath)) {
      throw new WorkspaceError(
        "access_denied",
        `workspace path is denied: ${requestedPath.relativePath}`,
      );
    }

    let pathMetadata;
    let canonicalTarget;
    try {
      [pathMetadata, canonicalTarget] = await Promise.all([
        lstat(requestedPath.absolutePath),
        realpath(requestedPath.absolutePath),
      ]);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new WorkspaceError(
          "path_not_found",
          `workspace path does not exist: ${requestedPath.relativePath}`,
        );
      }
      throw error;
    }

    const canonicalRoot = await this.canonicalWorkspaceRoot;
    const targetRelativePath = relative(canonicalRoot, canonicalTarget);
    if (isOutsideRoot(targetRelativePath)) {
      throw new WorkspaceError(
        "access_denied",
        `workspace path resolves outside the workspace: ${requestedPath.relativePath}`,
      );
    }

    const normalizedTargetPath = toWorkspacePath(targetRelativePath);
    if (this.policy.isDenied(normalizedTargetPath)) {
      throw new WorkspaceError(
        "access_denied",
        `workspace path resolves to a denied target: ${requestedPath.relativePath}`,
      );
    }

    const targetMetadata = await stat(canonicalTarget);
    return {
      path: requestedPath.relativePath,
      type: targetMetadata.isFile() ? "file" : targetMetadata.isDirectory() ? "directory" : "other",
      isSymbolicLink: pathMetadata.isSymbolicLink(),
    };
  }

  // 列举一个允许访问目录的直接子项，并集中处理稳定排序、链接目标和 denied 最小元数据。
  async listDirectory(path: string): Promise<WorkspaceDirectoryListing> {
    const resolvedDirectory = await this.resolvePath(path);
    if (resolvedDirectory.type !== "directory") {
      throw new WorkspaceError(
        "wrong_path_type",
        `workspace path is not a directory: ${resolvedDirectory.path}`,
      );
    }

    const absoluteDirectory = resolve(this.workspaceRoot, resolvedDirectory.path);
    const directoryEntries = await readdir(absoluteDirectory);
    const entries: WorkspaceDirectoryEntry[] = [];
    for (const name of directoryEntries) {
      entries.push(await this.describeDirectoryEntry(resolvedDirectory.path, name));
    }
    entries.sort(compareDirectoryEntries);
    return { path: resolvedDirectory.path, entries };
  }

  // 拒绝绝对路径和词法越界，再生成位于工作区根目录内的绝对访问目标与规范相对路径。
  private resolveLexicalPath(path: string): { absolutePath: string; relativePath: string } {
    if (isAbsolute(path)) {
      throw new WorkspaceError("access_denied", "workspace paths must be relative");
    }

    const absolutePath = resolve(this.workspaceRoot, path);
    const relativePath = relative(this.workspaceRoot, absolutePath);
    if (isOutsideRoot(relativePath)) {
      throw new WorkspaceError("access_denied", `workspace path escapes the root: ${path}`);
    }
    return { absolutePath, relativePath: toWorkspacePath(relativePath) };
  }

  // 读取单个直接子项的安全元数据；被拒绝的路径仅保留名称、路径、类型和访问状态。
  private async describeDirectoryEntry(
    directoryPath: string,
    name: string,
  ): Promise<WorkspaceDirectoryEntry> {
    const path = directoryPath === "." ? name : `${directoryPath}/${name}`;
    const metadata = await lstat(resolve(this.workspaceRoot, path));
    const type = toDirectoryEntryType(metadata);

    try {
      const resolvedEntry = await this.resolvePath(path);
      if (type === "symbolic_link") {
        return {
          name,
          path,
          type,
          access: "allowed",
          targetType: resolvedEntry.type,
        };
      }
      return {
        name,
        path,
        type,
        access: "allowed",
        ...(type === "file" ? { sizeBytes: metadata.size } : {}),
      };
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "access_denied") {
        return { name, path, type, access: "denied" };
      }
      if (
        type === "symbolic_link" &&
        error instanceof WorkspaceError &&
        error.code === "path_not_found"
      ) {
        return { name, path, type, access: "allowed", targetType: "missing" };
      }
      throw error;
    }
  }
}

// 将 lstat 元数据归一化为模型可见的目录项类型，并保留符号链接自身而不是目标类型。
function toDirectoryEntryType(metadata: Stats): WorkspaceDirectoryEntry["type"] {
  if (metadata.isSymbolicLink()) {
    return "symbolic_link";
  }
  if (metadata.isFile()) {
    return "file";
  }
  if (metadata.isDirectory()) {
    return "directory";
  }
  return "other";
}

// 使用 JavaScript Unicode 字符串顺序比较名称，避免依赖平台或进程 locale 的排序差异。
function compareDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

// 判断 path.relative 的结果是否位于基准目录之外，并避免字符串前缀碰撞。
function isOutsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

// 把平台路径转换为 Tool 使用的正斜杠相对路径，并用点表示工作区根目录。
function toWorkspacePath(path: string): string {
  return path.length === 0 ? "." : path.split(sep).join("/");
}

// 识别不存在的目标、断裂链接和路径中间段类型错误，统一映射为 path_not_found。
function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
