import type { ToolDefinition } from "../providers/provider.js";
import type { WorkspaceEditor } from "./workspace/workspace-editor.js";
import type { WorkspaceReader } from "./workspace/workspace-reader.js";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_arguments"
  | "path_not_found"
  | "access_denied"
  | "wrong_path_type"
  | "unsupported_content"
  | "resource_limit"
  | "execution_failed"
  | "edit_target_not_found"
  | "edit_target_not_unique"
  | "edit_targets_overlap"
  | "edit_no_change";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: JsonObject;
}

export type ToolResult = { ok: true; data: JsonValue } | { ok: false; error: ToolError };

export interface ToolExecutionOutput {
  result: ToolResult;
  content: string;
}

export interface ToolExecutionContext {
  workspaceReader: WorkspaceReader;
  workspaceEditor: WorkspaceEditor;
}

export interface AgentTool extends ToolDefinition {
  concurrency?: "safe";

  /** 使用模型提供的参数和 Registry 注入的工作区环境执行工具，并返回可安全序列化的结构化结果。 */
  execute(args: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}
