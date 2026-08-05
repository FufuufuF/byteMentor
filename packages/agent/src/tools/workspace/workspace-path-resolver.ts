import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { JsonObject, ToolErrorCode } from "../contracts.js";
import type { WorkspaceAccessPolicy } from "./workspace-policy.js";

export interface WorkspaceAccessiblePath {
  relativePath: string;
  absolutePath: string;
  canonicalTarget: string;
  canonicalRelativePath: string;
  type: "file" | "directory" | "other";
  isSymbolicLink: boolean;
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

export class WorkspacePathResolver {
  readonly workspaceRoot: string;
  readonly policy: WorkspaceAccessPolicy;
  readonly canonicalWorkspaceRoot: Promise<string>;

  // 固定显式工作区根目录和访问策略，并预先启动根目录真实路径解析供所有访问复用。
  constructor(input: { workspaceRoot: string; policy: WorkspaceAccessPolicy }) {
    this.workspaceRoot = resolve(input.workspaceRoot);
    this.policy = input.policy;
    this.canonicalWorkspaceRoot = realpath(this.workspaceRoot);
  }

  // 解析并校验一个工作区相对路径，返回稳定的相对别名、绝对访问路径和真实目标元数据。
  async resolveAccessiblePath(path: string): Promise<WorkspaceAccessiblePath> {
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
      relativePath: requestedPath.relativePath,
      absolutePath: requestedPath.absolutePath,
      canonicalTarget,
      canonicalRelativePath: normalizedTargetPath,
      type: targetMetadata.isFile() ? "file" : targetMetadata.isDirectory() ? "directory" : "other",
      isSymbolicLink: pathMetadata.isSymbolicLink(),
    };
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
}

// 判断 path.relative 的结果是否位于基准目录之外，并避免字符串前缀碰撞。
export function isOutsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

// 把平台路径转换为 Tool 使用的正斜杠相对路径，并用点表示工作区根目录。
export function toWorkspacePath(path: string): string {
  return path.length === 0 ? "." : path.split(sep).join("/");
}

// 识别不存在的目标、断裂链接和路径中间段类型错误，统一映射为 path_not_found。
export function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
