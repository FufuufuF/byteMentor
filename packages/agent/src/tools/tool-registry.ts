import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import type { ToolDefinition } from "../providers/provider.js";
import type { AgentTool, JsonValue, ToolExecutionOutput, ToolResult } from "./contracts.js";

const ajv = new Ajv({ allErrors: true });
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export class InvalidToolDefinitionError extends Error {
  // 创建一个启动期配置错误，指出工具定义中无法注册的字段或 schema。
  constructor(message: string) {
    super(message);
    this.name = "InvalidToolDefinitionError";
  }
}

export class DuplicateToolError extends Error {
  // 创建一个重名错误，阻止后注册的工具静默替换已有执行目标。
  constructor(toolName: string) {
    super(`tool already registered: ${toolName}`);
    this.name = "DuplicateToolError";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  private readonly validators = new WeakMap<AgentTool, ValidateFunction>();

  // 在保存工具前校验模型可见元数据、重名和参数 schema，确保配置错误在启动期暴露。
  register(tool: AgentTool): void {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new InvalidToolDefinitionError(`invalid tool name: ${tool.name}`);
    }
    if (tool.description.trim().length === 0) {
      throw new InvalidToolDefinitionError(`tool description must not be empty: ${tool.name}`);
    }
    if (this.tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name);
    }
    if (tool.parametersJsonSchema !== undefined) {
      try {
        this.getValidator(tool);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new InvalidToolDefinitionError(
          `invalid parametersJsonSchema for ${tool.name}: ${message}`,
        );
      }
    }
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
        error: { code: "unknown_tool", message: `tool not registered: ${name}` },
      });
    }
    const invalidArgsMessage = this.validateArgs(tool, args);
    if (invalidArgsMessage !== undefined) {
      return toExecutionOutput({
        ok: false,
        error: { code: "invalid_arguments", message: invalidArgsMessage },
      });
    }
    try {
      return toExecutionOutput(await tool.execute(args));
    } catch (e) {
      return toExecutionOutput({
        ok: false,
        error: {
          code: "execution_failed",
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  // 在工具执行前验证参数必须是对象，并在有 schema 时返回具体的 Ajv 校验错误。
  private validateArgs(tool: AgentTool, args: unknown): string | undefined {
    if (tool.parametersJsonSchema === undefined) {
      if (!isObjectArgs(args)) {
        return `args must be an object, got ${typeof args}`;
      }
      return undefined;
    }

    const validate = this.getValidator(tool);
    if (!validate(args)) {
      return `args do not match parametersJsonSchema: ${ajv.errorsText(validate.errors)}`;
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

// 校验并序列化归一化结果；违规 payload 会先替换为稳定的 execution_failed，避免 JSON 静默改值或丢字段。
function toExecutionOutput(result: ToolResult): ToolExecutionOutput {
  const safeResult: ToolResult = isJsonValue(result)
    ? result
    : {
        ok: false,
        error: {
          code: "execution_failed",
          message: "tool returned a result that is not JSON-compatible",
        },
      };
  return {
    result: safeResult,
    content: JSON.stringify(safeResult),
  };
}

// 递归确认一个值只包含 JSON 能无损表达的 primitive、密集数组和普通对象，并拒绝循环引用。
function isJsonValue(value: unknown, ancestors = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          return false;
        }
        if (!isJsonValue(descriptor.value, ancestors)) {
          return false;
        }
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return false;
      }
      if (!isJsonValue(descriptor.value, ancestors)) {
        return false;
      }
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

function isObjectArgs(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}
