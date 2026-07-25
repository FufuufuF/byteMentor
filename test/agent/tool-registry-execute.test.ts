import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@byte-mentor/agent";

describe("ToolRegistry.execute known tool", () => {
  // 工具执行成功后，Registry 需要同时提供两种表示：result 保留对象，方便运行时代码读取字段；
  // content 则把相同数据转成 JSON 字符串，供只接受字符串的 ToolMessage 使用。这里验证两者没有丢失或改变数据。
  it("serializes a successful structured tool result", async () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "echo",
      description: "echo back",
      async execute() {
        return {
          ok: true as const,
          data: { message: "hi", count: 1 },
        };
      },
    };
    registry.register(tool);
    const output = await registry.execute("echo", {});

    expect(output.result).toEqual({
      ok: true,
      data: { message: "hi", count: 1 },
    });
    expect(output.content).toBe('{"ok":true,"data":{"message":"hi","count":1}}');
    expect(JSON.parse(output.content)).toEqual(output.result);
  });

  // 验证 Registry 不修改已经通过校验的参数，而是把同一个对象交给工具执行函数。
  it("execute passes args through to tool.execute", async () => {
    const registry = new ToolRegistry();
    let captured: unknown = null;
    registry.register({
      name: "capture",
      description: "capture args",
      async execute(args: unknown) {
        captured = args;
        return { ok: true, data: "" };
      },
    });
    await registry.execute("capture", { x: 1, y: [2, 3] });
    expect(captured).toEqual({ x: 1, y: [2, 3] });
  });
});

describe("ToolRegistry.execute unknown tool", () => {
  // 验证调用未注册名称时不会抛异常，而是返回可供模型处理的 unknown_tool 失败结果。
  it("returns ToolError with kind unknown_tool when tool is not registered", async () => {
    const registry = new ToolRegistry();
    const r = (await registry.execute("nonexistent", {})).result;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("unknown_tool");
      expect(typeof r.error.message).toBe("string");
      expect(r.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("ToolRegistry.execute invalid args", () => {
  // 验证 Registry 在执行前使用工具 schema 拒绝缺失或类型错误的参数，同时允许合法的可选字段缺省。
  it("validates args with parametersJsonSchema", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "search",
      description: "search docs",
      parametersJsonSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(args: unknown) {
        const a = args as { query: string; limit?: number };
        return { ok: true, data: `${a.query}:${a.limit ?? "default"}` };
      },
    });

    const missingRequired = (await registry.execute("search", {})).result;
    expect(missingRequired.ok).toBe(false);
    if (!missingRequired.ok) {
      expect(missingRequired.error.kind).toBe("invalid_args");
    }

    const optionalAbsent = (await registry.execute("search", { query: "docs" })).result;
    expect(optionalAbsent.ok).toBe(true);
    if (optionalAbsent.ok) {
      expect(optionalAbsent.data).toBe("docs:default");
    }

    const invalidOptional = (
      await registry.execute("search", {
        query: "docs",
        limit: "many",
      })
    ).result;
    expect(invalidOptional.ok).toBe(false);
    if (!invalidOptional.ok) {
      expect(invalidOptional.error.kind).toBe("invalid_args");
    }
  });

  // 验证没有参数 schema 的工具仍拒绝字符串参数，避免把非对象参数传入工具实现。
  it("returns ToolError with kind invalid_args when args is not an object", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "t",
      description: "t",
      async execute() {
        return { ok: true, data: "" };
      },
    });
    const r = (await registry.execute("t", "string-not-object")).result;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid_args");
    }
  });

  // 验证当前兼容行为：没有参数 schema 的工具可以用 null 表示没有参数，并正常返回结果。
  it("accepts null for a tool with no parametersJsonSchema", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "t",
      description: "t",
      async execute() {
        return { ok: true, data: "no args" };
      },
    });
    const r = (await registry.execute("t", null)).result;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toBe("no args");
    }
  });

  // 验证声明对象 schema 后，null 不会被当成空对象，而会返回 invalid_args。
  it("returns invalid_args for null when tool has parametersJsonSchema", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "t",
      description: "t",
      parametersJsonSchema: { type: "object" },
      async execute() {
        return { ok: true, data: "" };
      },
    });
    const r = (await registry.execute("t", null)).result;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid_args");
    }
  });

  // 验证数组不会绕过“工具参数必须是对象”的边界。
  it("returns invalid_args when args is an array", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "t",
      description: "t",
      async execute() {
        return { ok: true, data: "ok" };
      },
    });
    const r = (await registry.execute("t", [1, 2, 3])).result;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid_args");
    }
  });

  // 验证当前兼容行为：无效 schema 在执行时被归一化为 invalid_args，而不是让 Promise reject。
  it("returns invalid_args instead of rejecting when parametersJsonSchema is invalid", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "bad-schema",
      description: "bad schema",
      parametersJsonSchema: "not-an-object",
      async execute() {
        return { ok: true, data: "should not run" };
      },
    });

    const r = (await registry.execute("bad-schema", {})).result;

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid_args");
      expect(r.error.message).toContain("invalid parametersJsonSchema");
    }
  });
});

describe("ToolRegistry.execute tool throws", () => {
  // 验证工具抛出 Error 时，Registry 返回 execution_failed，并保留可读的原始错误消息。
  it("returns ToolError with kind execution_failed when tool.execute throws", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "boom",
      description: "throws",
      async execute() {
        throw new Error("kaboom");
      },
    });
    const r = (await registry.execute("boom", {})).result;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("execution_failed");
      expect(r.error.message).toContain("kaboom");
    }
  });

  // 验证工具抛出字符串等非 Error 值时，Registry 仍能生成稳定的 execution_failed 结果。
  it("returns execution_failed when tool.execute throws non-Error", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "boom2",
      description: "throws",
      async execute() {
        throw "string error";
      },
    });
    const r = (await registry.execute("boom2", {})).result;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("execution_failed");
      expect(typeof r.error.message).toBe("string");
    }
  });
});
