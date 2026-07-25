import type { AgentTool, JsonObject, ToolResult } from "../contracts.js";
import { WorkspaceError, type WorkspaceDirectoryEntry } from "../workspace/workspace-reader.js";

interface ListDirectoryArguments {
  path?: string;
  offset?: number;
  limit?: number;
}

const parametersJsonSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      default: ".",
      description: 'Workspace-relative directory to browse. Defaults to ".". Example: "src".',
    },
    offset: {
      type: "integer",
      minimum: 0,
      default: 0,
      description: "Zero-based directory-entry offset. Defaults to 0. Example: 50.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 50,
      description: "Maximum entries to return. Defaults to 50, range 1-200. Example: 25.",
    },
  },
  additionalProperties: false,
} as const;

export const listDirectoryTool: AgentTool = {
  name: "list_directory",
  description: [
    "Use when: You need to inspect the direct children of one workspace directory.",
    "Do not use when: You need recursive file discovery or file contents.",
    "Returns: Stable entry metadata plus offset pagination and explicit output truncation.",
    'Example: {"path":"src","offset":0,"limit":50}',
  ].join("\n"),
  parametersJsonSchema,
  concurrency: "safe",

  // 将模型参数映射到 WorkspaceReader，并在成功结果上应用 Policy 默认值、分页和序列化预算。
  async execute(args, context): Promise<ToolResult> {
    const input = args as ListDirectoryArguments;
    const path = input.path ?? ".";
    const offset = input.offset ?? 0;
    const limit = input.limit ?? context.workspaceReader.policy.limits.defaultResultLimit;
    const policy = context.workspaceReader.policy;

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
      const listing = await context.workspaceReader.listDirectory(path);
      return createPaginatedResult(
        listing.path,
        listing.entries,
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

// 构造请求页并逐步缩小条目数量，保证完整成功 envelope 不超过工作区序列化预算。
function createPaginatedResult(
  path: string,
  allEntries: WorkspaceDirectoryEntry[],
  offset: number,
  limit: number,
  maxSerializedCharacters: number,
): ToolResult {
  const requestedEntries = allEntries.slice(offset, offset + limit);
  const regularData = createPayload(
    path,
    allEntries.length,
    offset,
    limit,
    requestedEntries,
    false,
  );
  if (serializedSuccessLength(regularData) <= maxSerializedCharacters) {
    return { ok: true, data: regularData };
  }

  for (let returned = requestedEntries.length - 1; returned >= 1; returned -= 1) {
    const truncatedData = createPayload(
      path,
      allEntries.length,
      offset,
      limit,
      requestedEntries.slice(0, returned),
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
      message: "the next directory entry cannot fit within the serialized output limit",
    },
  };
}

// 生成 list_directory 的 JSON payload，并根据总数和截断原因设置可继续的分页字段。
function createPayload(
  path: string,
  total: number,
  offset: number,
  limit: number,
  entries: WorkspaceDirectoryEntry[],
  truncatedByOutput: boolean,
): JsonObject {
  const returned = entries.length;
  const hasMore = offset + returned < total;
  const pagination: JsonObject = {
    offset,
    limit,
    returned,
    total,
    hasMore,
    ...(hasMore ? { nextOffset: offset + returned } : {}),
    ...(truncatedByOutput ? { truncatedBy: "output_limit" } : {}),
  };
  return {
    path,
    entries: entries.map(toJsonDirectoryEntry),
    pagination,
  };
}

// 把 Reader 的目录项转换为严格 JsonObject，保留允许当前访问级别公开的可选元数据。
function toJsonDirectoryEntry(entry: WorkspaceDirectoryEntry): JsonObject {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    access: entry.access,
    ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
    ...(entry.targetType === undefined ? {} : { targetType: entry.targetType }),
  };
}

// 计算 Registry 最终写入 ToolMessage 的完整成功 envelope 字符数，避免只预算 data 而低估输出。
function serializedSuccessLength(data: JsonObject): number {
  return JSON.stringify({ ok: true, data }).length;
}
