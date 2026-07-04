import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@byte-mentor/agent";
import type { AgentTool } from "@byte-mentor/agent";

function makeTool(name: string): AgentTool {
  return {
    name,
    description: `${name} tool`,
    async execute() {
      return { ok: true, result: name };
    },
  };
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
