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
  // 调用未注册名称时，Registry 应返回 unknown_tool 对象，并生成内容完全相同的 JSON 供 ToolMessage 使用。
  it("returns a serialized unknown_tool error when the tool is not registered", async () => {
    const registry = new ToolRegistry();
    const output = await registry.execute("nonexistent", {});
    const r = output.result;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unknown_tool");
      expect(typeof r.error.message).toBe("string");
      expect(r.error.message.length).toBeGreaterThan(0);
    }
    expect(JSON.parse(output.content)).toEqual(output.result);
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

    const missingRequiredOutput = await registry.execute("search", {});
    const missingRequired = missingRequiredOutput.result;
    expect(missingRequired.ok).toBe(false);
    if (!missingRequired.ok) {
      expect(missingRequired.error.code).toBe("invalid_arguments");
    }
    expect(JSON.parse(missingRequiredOutput.content)).toEqual(missingRequired);

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
      expect(invalidOptional.error.code).toBe("invalid_arguments");
    }
  });

  // 验证没有参数 schema 的工具仍拒绝字符串参数，避免把非对象参数传入工具实现。
  it("returns invalid_arguments when args is not an object", async () => {
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
      expect(r.error.code).toBe("invalid_arguments");
    }
  });

  // 即使工具没有声明 schema，参数仍必须是对象；这里验证 null 会被拒绝，而不会执行工具。
  it("returns invalid_arguments for null without a parametersJsonSchema", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "t",
      description: "t",
      async execute() {
        return { ok: true, data: "no args" };
      },
    });
    const r = (await registry.execute("t", null)).result;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid_arguments");
    }
  });

  // 声明对象 schema 后，null 同样不能被当成空对象；这里验证它返回 invalid_arguments。
  it("returns invalid_arguments for null when tool has parametersJsonSchema", async () => {
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
      expect(r.error.code).toBe("invalid_arguments");
    }
  });

  // 验证数组不会绕过“工具参数必须是对象”的边界。
  it("returns invalid_arguments when args is an array", async () => {
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
      expect(r.error.code).toBe("invalid_arguments");
    }
  });
});

describe("ToolRegistry.execute tool throws", () => {
  // 工具抛出 Error 时，Registry 应返回 execution_failed、保留原消息，并生成等价 JSON，而不是 reject。
  it("returns a serialized execution_failed error when tool.execute throws", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "boom",
      description: "throws",
      async execute() {
        throw new Error("kaboom");
      },
    });
    const output = await registry.execute("boom", {});
    const r = output.result;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("execution_failed");
      expect(r.error.message).toContain("kaboom");
    }
    expect(JSON.parse(output.content)).toEqual(output.result);
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
      expect(r.error.code).toBe("execution_failed");
      expect(typeof r.error.message).toBe("string");
    }
  });
});
