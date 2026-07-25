import type { AgentTool, JsonObject, ToolResult } from "../contracts.js";
import { WorkspaceError, type WorkspaceFileEntry } from "../workspace/workspace-reader.js";

interface FindFilesArguments {
  query: string;
  path?: string;
  caseSensitive?: boolean;
  offset?: number;
  limit?: number;
}

const parametersJsonSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description:
        'Literal substring to find in file names or workspace-relative paths. Length 1-256. Example: "chapter".',
    },
    path: {
      type: "string",
      default: ".",
      description: 'Workspace-relative directory to search. Defaults to ".". Example: "src".',
    },
    caseSensitive: {
      type: "boolean",
      default: false,
      description: "Whether matching preserves letter case. Defaults to false. Example: true.",
    },
    offset: {
      type: "integer",
      minimum: 0,
      default: 0,
      description: "Zero-based matching-file offset. Defaults to 0. Example: 50.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 50,
      description: "Maximum matches to return. Defaults to 50, range 1-200. Example: 25.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

export const findFilesTool: AgentTool = {
  name: "find_files",
  description: [
    "Use when: You need to find files by a literal substring in their name or workspace-relative path.",
    "Do not use when: You need to search file contents, glob patterns, or regular expressions.",
    "Returns: Stable file metadata with offset pagination and explicit output truncation.",
    'Example: {"query":"chapter","path":"src","caseSensitive":false,"limit":50}',
  ].join("\n"),
  parametersJsonSchema,
  concurrency: "safe",

  // 将模型参数映射到安全文件遍历，再执行字面量过滤、分页和完整成功 envelope 预算。
  async execute(args, context): Promise<ToolResult> {
    const input = args as FindFilesArguments;
    const path = input.path ?? ".";
    const caseSensitive = input.caseSensitive ?? false;
    const offset = input.offset ?? 0;
    const policy = context.workspaceReader.policy;
    const limit = input.limit ?? policy.limits.defaultResultLimit;

    if (limit > policy.limits.maxResultLimit) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: `limit must not exceed the configured maximum of ${policy.limits.maxResultLimit}`,
        },
      };
    }

    try {
      const traversal = await context.workspaceReader.walkFiles(path);
      const matches = traversal.files.filter((file) =>
        matchesLiteralQuery(file, input.query, caseSensitive),
      );
      return createPaginatedResult(
        traversal.path,
        input.query,
        caseSensitive,
        matches,
        offset,
        limit,
        policy.limits.maxSerializedToolResultCharacters,
      );
    } catch (error) {
      if (error instanceof WorkspaceError) {
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        };
      }
      throw error;
    }
  },
};

// 判断文件名或完整工作区相对路径是否包含查询字面量，并按选项统一大小写。
function matchesLiteralQuery(
  file: WorkspaceFileEntry,
  query: string,
  caseSensitive: boolean,
): boolean {
  if (caseSensitive) {
    return file.name.includes(query) || file.path.includes(query);
  }
  const normalizedQuery = query.toLowerCase();
  return (
    file.name.toLowerCase().includes(normalizedQuery) ||
    file.path.toLowerCase().includes(normalizedQuery)
  );
}

// 构造请求页并在必要时缩短匹配列表，保证完整成功 envelope 位于序列化字符预算内。
function createPaginatedResult(
  path: string,
  query: string,
  caseSensitive: boolean,
  allMatches: WorkspaceFileEntry[],
  offset: number,
  limit: number,
  maxSerializedCharacters: number,
): ToolResult {
  const requestedMatches = allMatches.slice(offset, offset + limit);
  const regularData = createPayload(
    path,
    query,
    caseSensitive,
    allMatches.length,
    offset,
    limit,
    requestedMatches,
    false,
  );
  if (serializedSuccessLength(regularData) <= maxSerializedCharacters) {
    return { ok: true, data: regularData };
  }

  for (let returned = requestedMatches.length - 1; returned >= 1; returned -= 1) {
    const truncatedData = createPayload(
      path,
      query,
      caseSensitive,
      allMatches.length,
      offset,
      limit,
      requestedMatches.slice(0, returned),
      true,
    );
    if (serializedSuccessLength(truncatedData) <= maxSerializedCharacters) {
      return { ok: true, data: truncatedData };
    }
  }

  return {
    ok: false,
    error: {
      code: "resource_limit",
      message: "the next file match cannot fit within the serialized output limit",
    },
  };
}

// 生成不含总数的 find_files JSON payload，并只在确有后续匹配时提供 nextOffset。
function createPayload(
  path: string,
  query: string,
  caseSensitive: boolean,
  matchCount: number,
  offset: number,
  limit: number,
  matches: WorkspaceFileEntry[],
  truncatedByOutput: boolean,
): JsonObject {
  const returned = matches.length;
  const hasMore = offset + returned < matchCount;
  const pagination: JsonObject = {
    offset,
    limit,
    returned,
    hasMore,
    ...(hasMore ? { nextOffset: offset + returned } : {}),
    ...(truncatedByOutput ? { truncatedBy: "output_limit" } : {}),
  };
  return {
    path,
    query,
    caseSensitive,
    matches: matches.map(toJsonFileMatch),
    pagination,
  };
}

// 把 Reader 文件条目转换为严格 JsonObject，并仅为文件链接公开 targetType。
function toJsonFileMatch(file: WorkspaceFileEntry): JsonObject {
  return {
    name: file.name,
    path: file.path,
    type: file.type,
    sizeBytes: file.sizeBytes,
    ...(file.targetType === undefined ? {} : { targetType: file.targetType }),
  };
}

// 计算 Registry 最终写入 ToolMessage 的完整成功 envelope 字符数，防止低估分页输出。
function serializedSuccessLength(data: JsonObject): number {
  return JSON.stringify({ ok: true, data }).length;
}
