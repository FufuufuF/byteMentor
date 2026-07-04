import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import type { AgentTool, ToolDefinition, ToolResult } from "./provider.js";

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

  async execute(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return {
        ok: false,
        error: { kind: "unknown_tool", message: `tool not registered: ${name}` },
      };
    }
    const invalidArgsMessage = this.validateArgs(tool, args);
    if (invalidArgsMessage !== undefined) {
      return {
        ok: false,
        error: { kind: "invalid_args", message: invalidArgsMessage },
      };
    }
    try {
      return await tool.execute(args);
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: "execution_failed",
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  private validateArgs(tool: AgentTool, args: unknown): string | undefined {
    if (tool.parametersJsonSchema === undefined) {
      if (args !== null && !isObjectArgs(args)) {
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

function isObjectArgs(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}
