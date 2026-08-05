import type { AgentTool, JsonObject, ToolErrorCode, ToolResult } from "../contracts.js";
import { WorkspaceError } from "../workspace/workspace-path-resolver.js";
import { applyEdits, type EditDiffError, type EditDiffSuccess } from "./edit-diff.js";

interface EditFileArguments {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

const PROTOCOL_MAX_PATH_CHARACTERS = 4096;
const PROTOCOL_MAX_EDIT_FIELD_CHARACTERS = 65_536;
const PROTOCOL_MAX_EDIT_TOTAL_CHARACTERS = 262_144;

const parametersJsonSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: 'Workspace-relative UTF-8 text file to edit. Example: "src/index.ts".',
    },
    edits: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      description:
        "One to sixty-four exact replacements, all matched against the original file snapshot.",
      items: {
        type: "object",
        properties: {
          oldText: {
            type: "string",
            minLength: 1,
            description:
              "A unique snippet of the current file content. Keep it short but unique in the file.",
          },
          newText: {
            type: "string",
            description: "The replacement text. Empty string deletes the matched snippet.",
          },
        },
        required: ["oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
  required: ["path", "edits"],
  additionalProperties: false,
} as const;

export const editFileTool: AgentTool = {
  name: "edit_file",
  description: [
    "Use when: You need to apply one or more precise text replacements to an existing UTF-8 workspace file.",
    "Do not use when: Creating or deleting files, binary files, or directory operations.",
    "All oldText values are matched against the original file snapshot and must be unique.",
    "Overlapping or nested edits must be merged into a single edit.",
    'Example: {"path":"src/index.ts","edits":[{"oldText":"const a = 1;","newText":"const a = 10;"}]}',
  ].join("\n"),
  parametersJsonSchema,

  // 校验协议字符上限后读取快照，先完成全部匹配与预算检查，再通过 Editor 原子写回；
  // 取消检查发生在提交点之前，rename 成功后的迟到 abort 不追溯改写成功结果。
  async execute(args, context, options): Promise<ToolResult> {
    const input = args as EditFileArguments;
    const editor = context.workspaceEditor;
    const invalidMessage = validateEditArguments(input);
    if (invalidMessage !== undefined) {
      return { ok: false, error: { code: "invalid_arguments", message: invalidMessage } };
    }
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: { code: "tool_cancelled", message: "edit cancelled before any file I/O" },
      };
    }

    try {
      const snapshot = await editor.readTextSnapshot(input.path);
      const applied = applyEdits(snapshot.content, input.edits);
      if (!applied.ok) {
        return { ok: false, error: toEditError(applied.error, snapshot.path) };
      }
      const payload = buildSuccessPayload(snapshot.path, applied);
      const serialized = JSON.stringify({ ok: true, data: payload });
      if (serialized.length > editor.policy.limits.maxSerializedToolResultCharacters) {
        return {
          ok: false,
          error: {
            code: "resource_limit",
            message: "edit result exceeds the serialized tool result limit",
          },
        };
      }
      const content = snapshot.bom ? `\uFEFF${applied.text}` : applied.text;
      await editor.writeTextAtomically(input.path, content, { signal: options?.signal });
      return { ok: true, data: payload };
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

// 在读取文件前校验协议硬上限：path 与单个字段按 Unicode 字符计数，聚合字符数单独限制。
function validateEditArguments(input: EditFileArguments): string | undefined {
  if (Array.from(input.path).length > PROTOCOL_MAX_PATH_CHARACTERS) {
    return `path must not exceed ${PROTOCOL_MAX_PATH_CHARACTERS} Unicode characters`;
  }
  let totalCharacters = 0;
  for (const edit of input.edits) {
    const oldLength = Array.from(edit.oldText).length;
    const newLength = Array.from(edit.newText).length;
    if (oldLength > PROTOCOL_MAX_EDIT_FIELD_CHARACTERS) {
      return `oldText must not exceed ${PROTOCOL_MAX_EDIT_FIELD_CHARACTERS} Unicode characters`;
    }
    if (newLength > PROTOCOL_MAX_EDIT_FIELD_CHARACTERS) {
      return `newText must not exceed ${PROTOCOL_MAX_EDIT_FIELD_CHARACTERS} Unicode characters`;
    }
    totalCharacters += oldLength + newLength;
  }
  if (totalCharacters > PROTOCOL_MAX_EDIT_TOTAL_CHARACTERS) {
    return `combined edit text must not exceed ${PROTOCOL_MAX_EDIT_TOTAL_CHARACTERS} Unicode characters`;
  }
  return undefined;
}

// 把 edit-diff 的结构化失败转换为带 path、editIndex 和 occurrences 详情的稳定 Tool 错误。
function toEditError(
  error: EditDiffError,
  path: string,
): {
  code: ToolErrorCode;
  message: string;
  details: JsonObject;
} {
  return {
    code: error.code,
    message: error.message,
    details: {
      path,
      ...(error.editIndex === undefined ? {} : { editIndex: error.editIndex }),
      ...(error.occurrences === undefined ? {} : { occurrences: error.occurrences }),
    },
  };
}

// 组装成功 payload：规范化路径、替换块数量、展示 diff、unified patch 和首个变化行号。
function buildSuccessPayload(path: string, result: EditDiffSuccess): JsonObject {
  return {
    path,
    replacements: result.replacements,
    diff: result.diff,
    patch: result.patch,
    ...(result.firstChangedLine === undefined ? {} : { firstChangedLine: result.firstChangedLine }),
  };
}
