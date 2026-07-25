import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import type { ToolDefinition } from "../providers/provider.js";
import type { AgentTool, ToolExecutionOutput, ToolResult } from "./contracts.js";

const ajv = new Ajv({ allErrors: true });

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  private readonly validators = new WeakMap<AgentTool, ValidateFunction>();

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
      .map((t) => ({
        name: t.name,
        description: t.description,
        ...(t.parametersJsonSchema !== undefined
          ? { parametersJsonSchema: t.parametersJsonSchema }
          : {}),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // 执行一个已注册工具，同时返回供 Runtime 判断状态的对象结果和供 ToolMessage 使用的 JSON 字符串。
  async execute(name: string, args: unknown): Promise<ToolExecutionOutput> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return toExecutionOutput({
        ok: false,
        error: { kind: "unknown_tool", message: `tool not registered: ${name}` },
      });
    }
    const invalidArgsMessage = this.validateArgs(tool, args);
    if (invalidArgsMessage !== undefined) {
      return toExecutionOutput({
        ok: false,
        error: { kind: "invalid_args", message: invalidArgsMessage },
      });
    }
    try {
      return toExecutionOutput(await tool.execute(args));
    } catch (e) {
      return toExecutionOutput({
        ok: false,
        error: {
          kind: "execution_failed",
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  private validateArgs(tool: AgentTool, args: unknown): string | undefined {
    if (tool.parametersJsonSchema === undefined) {
      if (args !== null && !isObjectArgs(args)) {
        return `args must be an object, got ${typeof args}`;
      }
      return undefined;
    }

    try {
      const validate = this.getValidator(tool);
      if (!validate(args)) {
        return `args do not match parametersJsonSchema: ${ajv.errorsText(validate.errors)}`;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return `invalid parametersJsonSchema: ${message}`;
    }
    return undefined;
  }

  private getValidator(tool: AgentTool): ValidateFunction {
    const cached = this.validators.get(tool);
    if (cached !== undefined) {
      return cached;
    }
    const validate = ajv.compile(tool.parametersJsonSchema as AnySchema);
    this.validators.set(tool, validate);
    return validate;
  }
}

// 把归一化结果统一序列化一次，确保 Runtime 读取的对象与 ToolMessage 携带的字符串表达同一份数据。
function toExecutionOutput(result: ToolResult): ToolExecutionOutput {
  return {
    result,
    content: JSON.stringify(result),
  };
}

function isObjectArgs(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}
