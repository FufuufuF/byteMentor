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
  | "edit_no_change"
  | "tool_cancelled"
  | "command_cancelled";

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

// 单次工具调用的动态控制信息；signal 是只读单向通知，不进入由 Registry 静态持有的 context。
export interface ToolExecutionOptions {
  signal?: AbortSignal;
}

export interface AgentTool extends ToolDefinition {
  concurrency?: "safe";

  /** 使用模型提供的参数、Registry 注入的工作区环境和单次执行控制选项执行工具，返回可安全序列化的结构化结果。 */
  execute(
    args: unknown,
    context: ToolExecutionContext,
    options?: ToolExecutionOptions,
  ): Promise<ToolResult>;
}
