import type { AgentTool, JsonObject, ToolResult } from "../contracts.js";
import { WorkspaceError, type WorkspaceTextWindow } from "../workspace/workspace-reader.js";

interface ReadFileArguments {
  path: string;
  startLine?: number;
  startColumn?: number;
  lineLimit?: number;
}

const parametersJsonSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: 'Workspace-relative UTF-8 file to read. Example: "src/index.ts".',
    },
    startLine: {
      type: "integer",
      minimum: 1,
      default: 1,
      description: "One-based starting line. Defaults to 1. Example: 201.",
    },
    startColumn: {
      type: "integer",
      minimum: 1,
      default: 1,
      description: "One-based Unicode code point column. Defaults to 1. Example: 25.",
    },
    lineLimit: {
      type: "integer",
      minimum: 1,
      maximum: 500,
      default: 200,
      description: "Maximum logical lines to read. Defaults to 200, range 1-500. Example: 100.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

export const readFileTool: AgentTool = {
  name: "read_file",
  description: [
    "Use when: You need an exact UTF-8 text window from a workspace file.",
    "Do not use when: You need binary data, other encodings, file discovery, or content search.",
    "Returns: Original text and line endings with a precise range, truncation reason, and continuation position.",
    'Example: {"path":"src/index.ts","startLine":1,"startColumn":1,"lineLimit":200}',
  ].join("\n"),
  parametersJsonSchema,
  concurrency: "safe",

  // 将模型行列参数映射到 Reader 的有界文本窗口，并保留 Workspace 结构化错误。
  async execute(args, context): Promise<ToolResult> {
    const input = args as ReadFileArguments;
    const policy = context.workspaceReader.policy;
    const lineLimit = input.lineLimit ?? policy.limits.defaultReadLines;
    if (lineLimit > policy.limits.maxReadLines) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: `lineLimit must not exceed the configured maximum of ${policy.limits.maxReadLines}`,
        },
      };
    }

    try {
      const window = await context.workspaceReader.readTextWindow(input.path, {
        startLine: input.startLine ?? 1,
        startColumn: input.startColumn ?? 1,
        lineLimit,
        maxCharacters: policy.limits.maxOutputCharacters,
      });
      return { ok: true, data: toJsonTextWindow(window) };
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

// 将 Reader 窗口投影为严格 JsonObject，并只在截断时公开原因与续读位置。
function toJsonTextWindow(window: WorkspaceTextWindow): JsonObject {
  return {
    path: window.path,
    encoding: window.encoding,
    bom: window.bom,
    content: window.content,
    range:
      window.range === null
        ? null
        : {
            startLine: window.range.startLine,
            startColumn: window.range.startColumn,
            endLine: window.range.endLine,
            endColumn: window.range.endColumn,
          },
    eof: window.eof,
    truncated: window.truncated,
    ...(window.truncatedBy === undefined ? {} : { truncatedBy: window.truncatedBy }),
    ...(window.nextPosition === undefined
      ? {}
      : {
          nextPosition: {
            line: window.nextPosition.line,
            column: window.nextPosition.column,
          },
        }),
  };
}
