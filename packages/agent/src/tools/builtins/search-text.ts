import type { AgentTool, JsonObject, ToolResult } from "../contracts.js";
import {
  WorkspaceError,
  type WorkspaceSkippedFile,
  type WorkspaceTextSearchMatch,
} from "../workspace/workspace-reader.js";

interface SearchTextArguments {
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
        'Literal text to find within individual lines. Length 1-256. Example: "ToolRegistry".',
    },
    path: {
      type: "string",
      default: ".",
      description:
        'Workspace-relative file or directory to search. Defaults to ".". Example: "src".',
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
      description: "Zero-based matching-line offset. Defaults to 0. Example: 50.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 50,
      description: "Maximum matching lines to return. Defaults to 50, range 1-200. Example: 25.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

export const searchTextTool: AgentTool = {
  name: "search_text",
  description: [
    "Use when: You need matching lines for a literal text query in one file or a workspace directory.",
    "Do not use when: You need file-name discovery, regular expressions, glob patterns, or cross-line matches.",
    "Returns: Stable matching-line previews, occurrence metadata, pagination, and bounded skipped-file details.",
    'Example: {"query":"ToolRegistry","path":"packages/agent/src","caseSensitive":true,"limit":50}',
  ].join("\n"),
  parametersJsonSchema,
  concurrency: "safe",

  // 将模型参数映射到 Workspace 文本搜索，再应用无状态分页与完整成功 envelope 预算。
  async execute(args, context): Promise<ToolResult> {
    const input = args as SearchTextArguments;
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
      const search = await context.workspaceReader.searchText(path, {
        query: input.query,
        caseSensitive,
      });
      return createPaginatedResult(
        search.path,
        input.query,
        caseSensitive,
        search.matches,
        search.skippedFileCount,
        search.skippedFiles,
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

// 构造请求页并逐步缩短匹配数量，保证完整成功 envelope 不超过序列化预算。
function createPaginatedResult(
  path: string,
  query: string,
  caseSensitive: boolean,
  allMatches: WorkspaceTextSearchMatch[],
  skippedFileCount: number,
  skippedFiles: WorkspaceSkippedFile[],
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
    skippedFileCount,
    skippedFiles,
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
      skippedFileCount,
      skippedFiles,
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
      message: "the next text match cannot fit within the serialized output limit",
    },
  };
}

// 生成不含匹配总数的 search_text payload，并保留完整跳过计数与受限详情。
function createPayload(
  path: string,
  query: string,
  caseSensitive: boolean,
  matchCount: number,
  skippedFileCount: number,
  skippedFiles: WorkspaceSkippedFile[],
  offset: number,
  limit: number,
  matches: WorkspaceTextSearchMatch[],
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
    matches: matches.map(toJsonSearchMatch),
    pagination,
    skippedFileCount,
    skippedFiles: skippedFiles.map((file) => ({ path: file.path, reason: file.reason })),
  };
}

// 将 Reader 匹配投影为严格 JSON，并显式展开预览列范围。
function toJsonSearchMatch(match: WorkspaceTextSearchMatch): JsonObject {
  return {
    path: match.path,
    line: match.line,
    firstMatchColumn: match.firstMatchColumn,
    occurrenceCount: match.occurrenceCount,
    preview: match.preview,
    previewRange: {
      startColumn: match.previewRange.startColumn,
      endColumn: match.previewRange.endColumn,
    },
    previewTruncated: match.previewTruncated,
  };
}

// 计算 Registry 最终写入 ToolMessage 的完整成功 envelope 字符数。
function serializedSuccessLength(data: JsonObject): number {
  return JSON.stringify({ ok: true, data }).length;
}
