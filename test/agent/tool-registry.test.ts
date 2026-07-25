import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@byte-mentor/agent";
import type { AgentTool } from "@byte-mentor/agent";

// 创建只返回自身名称的最小工具，供 Registry 注册和排序测试复用。
function makeTool(name: string): AgentTool {
  return {
    name,
    description: `${name} tool`,
    async execute() {
      return { ok: true, data: name };
    },
  };
}

// 执行一次注册并确认它抛出指定类型的配置错误；如果没有抛错，本身就构成测试失败。
function expectRegistrationError(register: () => void, expectedErrorName: string): void {
  let thrown: unknown;
  try {
    register();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).toMatchObject({ name: expectedErrorName });
}

describe("ToolRegistry.register", () => {
  it("register makes a tool available via list", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("search"));
    const defs = registry.list();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe("search");
  });

  it("list returns ToolDefinition shape (no execute function leaked)", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("search"));
    const defs = registry.list();
    expect(defs[0]).toEqual({
      name: "search",
      description: "search tool",
    });
  });

  it("register multiple tools all appear in list", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("alpha"));
    registry.register(makeTool("beta"));
    registry.register(makeTool("gamma"));
    expect(registry.list().length).toBe(3);
  });

  // 工具名称会进入模型调用协议；这里验证大写开头、非法分隔符、非法首字符和超长名称都会在启动期被拒绝。
  it("rejects tool names outside the runtime naming contract", () => {
    for (const name of ["Search", "search-tool", "_search", "a".repeat(65)]) {
      const registry = new ToolRegistry();
      expectRegistrationError(
        () => registry.register(makeTool(name)),
        "InvalidToolDefinitionError",
      );
    }
  });

  // 空白说明无法帮助模型选择工具；这里验证 Registry 在注册时拒绝 trim 后为空的 description。
  it("rejects an empty tool description", () => {
    const registry = new ToolRegistry();
    expectRegistrationError(
      () => registry.register({ ...makeTool("search"), description: "   " }),
      "InvalidToolDefinitionError",
    );
  });

  // 参数 schema 属于开发期配置；这里验证无法被 Ajv 编译的 schema 在注册时立即暴露，而不是延迟到模型调用后。
  it("rejects an invalid parameters schema during registration", () => {
    const registry = new ToolRegistry();
    expectRegistrationError(
      () =>
        registry.register({
          ...makeTool("search"),
          parametersJsonSchema: "not-a-schema",
        }),
      "InvalidToolDefinitionError",
    );
  });

  // 同名工具会让实际执行目标不明确；这里验证第二次注册不会静默覆盖第一次注册。
  it("rejects a duplicate tool name", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("search"));
    expectRegistrationError(() => registry.register(makeTool("search")), "DuplicateToolError");
  });
});

describe("ToolRegistry.list sort order", () => {
  it("list returns tools sorted by name in dictionary order", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("zebra"));
    registry.register(makeTool("alpha"));
    registry.register(makeTool("mango"));
    const names = registry.list().map((d) => d.name);
    expect(names).toEqual(["alpha", "mango", "zebra"]);
  });

  it("list sort is stable across multiple calls", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("c"));
    registry.register(makeTool("a"));
    registry.register(makeTool("b"));
    const first = registry.list().map((d) => d.name);
    const second = registry.list().map((d) => d.name);
    expect(first).toEqual(["a", "b", "c"]);
    expect(second).toEqual(["a", "b", "c"]);
  });

  it("list returns empty array for an empty registry", () => {
    const registry = new ToolRegistry();
    expect(registry.list()).toEqual([]);
  });
});

describe("ToolRegistry runtime metadata boundary", () => {
  // concurrency 只供 Runner 决定调度方式；这里验证 Registry 能读取该属性，但 list() 给模型的定义不会泄露它或其他运行时字段。
  it("keeps concurrency and runtime fields out of model-visible definitions", () => {
    const registry = new ToolRegistry();
    const tool = {
      ...makeTool("search"),
      concurrency: "safe" as const,
      runtimeContext: { secret: true },
    };
    registry.register(tool);

    expect(registry.getConcurrency("search")).toBe("safe");
    expect(registry.list()).toEqual([
      {
        name: "search",
        description: "search tool",
      },
    ]);
  });

  // 未声明并发资格的工具以及未知名称都必须采用保守串行策略，避免未来写入工具被意外并发执行。
  it("treats undeclared and unknown tools as serial", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("search"));

    expect(registry.getConcurrency("search")).toBe("serial");
    expect(registry.getConcurrency("missing")).toBe("serial");
  });
});
