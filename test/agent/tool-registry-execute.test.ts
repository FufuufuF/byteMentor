import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@byte-mentor/agent";
import type { AgentTool } from "@byte-mentor/agent";

describe("ToolRegistry.execute known tool", () => {
  it("executes a registered tool and returns success result", async () => {
    const registry = new ToolRegistry();
    const tool: AgentTool = {
      name: "echo",
      description: "echo back",
      async execute(args: unknown) {
        const a = args as { text: string };
        return { ok: true, result: a.text };
      },
    };
    registry.register(tool);
    const r = await registry.execute("echo", { text: "hi" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result).toBe("hi");
    }
  });

  it("execute passes args through to tool.execute", async () => {
    const registry = new ToolRegistry();
    let captured: unknown = null;
    registry.register({
      name: "capture",
      description: "capture args",
      async execute(args: unknown) {
        captured = args;
        return { ok: true, result: "" };
      },
    });
    await registry.execute("capture", { x: 1, y: [2, 3] });
    expect(captured).toEqual({ x: 1, y: [2, 3] });
  });
});

describe("ToolRegistry.execute unknown tool", () => {
  it("returns ToolError with kind unknown_tool when tool is not registered", async () => {
    const registry = new ToolRegistry();
    const r = await registry.execute("nonexistent", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("unknown_tool");
      expect(typeof r.error.message).toBe("string");
      expect(r.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("ToolRegistry.execute invalid args", () => {
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
        return { ok: true, result: `${a.query}:${a.limit ?? "default"}` };
      },
    });

    const missingRequired = await registry.execute("search", {});
    expect(missingRequired.ok).toBe(false);
    if (!missingRequired.ok) {
      expect(missingRequired.error.kind).toBe("invalid_args");
    }

    const optionalAbsent = await registry.execute("search", { query: "docs" });
    expect(optionalAbsent.ok).toBe(true);
    if (optionalAbsent.ok) {
      expect(optionalAbsent.result).toBe("docs:default");
    }

    const invalidOptional = await registry.execute("search", {
      query: "docs",
      limit: "many",
    });
    expect(invalidOptional.ok).toBe(false);
    if (!invalidOptional.ok) {
      expect(invalidOptional.error.kind).toBe("invalid_args");
    }
  });

  it("returns ToolError with kind invalid_args when args is not an object", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "t",
      description: "t",
      async execute() {
        return { ok: true, result: "" };
      },
    });
    const r = await registry.execute("t", "string-not-object");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid_args");
    }
  });

  it("accepts null for a tool with no parametersJsonSchema", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "t",
      description: "t",
      async execute() {
        return { ok: true, result: "no args" };
      },
    });
    const r = await registry.execute("t", null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result).toBe("no args");
    }
  });

  it("returns invalid_args for null when tool has parametersJsonSchema", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "t",
      description: "t",
      parametersJsonSchema: { type: "object" },
      async execute() {
        return { ok: true, result: "" };
      },
    });
    const r = await registry.execute("t", null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid_args");
    }
  });

  it("returns invalid_args when args is an array", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "t",
      description: "t",
      async execute() {
        return { ok: true, result: "ok" };
      },
    });
    const r = await registry.execute("t", [1, 2, 3]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid_args");
    }
  });

  it("returns invalid_args instead of rejecting when parametersJsonSchema is invalid", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "bad-schema",
      description: "bad schema",
      parametersJsonSchema: "not-an-object",
      async execute() {
        return { ok: true, result: "should not run" };
      },
    });

    const r = await registry.execute("bad-schema", {});

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid_args");
      expect(r.error.message).toContain("invalid parametersJsonSchema");
    }
  });
});

describe("ToolRegistry.execute tool throws", () => {
  it("returns ToolError with kind execution_failed when tool.execute throws", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "boom",
      description: "throws",
      async execute() {
        throw new Error("kaboom");
      },
    });
    const r = await registry.execute("boom", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("execution_failed");
      expect(r.error.message).toContain("kaboom");
    }
  });

  it("returns execution_failed when tool.execute throws non-Error", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "boom2",
      description: "throws",
      async execute() {
        throw "string error";
      },
    });
    const r = await registry.execute("boom2", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("execution_failed");
      expect(typeof r.error.message).toBe("string");
    }
  });
});
