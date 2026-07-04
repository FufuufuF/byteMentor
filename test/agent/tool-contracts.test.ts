import { describe, expect, it } from "vitest";
import type {
  AgentTool,
  ModelProvider,
  ToolDefinition,
  ToolError,
  ToolResult,
} from "@byte-mentor/agent";
import type { AssistantMessage, Message, StopReason } from "@byte-mentor/core";

describe("agent tool type contracts", () => {
  it("ToolError can express unknown_tool kind", () => {
    const err: ToolError = { kind: "unknown_tool", message: "no such tool" };
    expect(err.kind).toBe("unknown_tool");
    expect(err.message).toBe("no such tool");
  });

  it("ToolError can express invalid_args kind", () => {
    const err: ToolError = { kind: "invalid_args", message: "args must be object" };
    expect(err.kind).toBe("invalid_args");
  });

  it("ToolError can express execution_failed kind", () => {
    const err: ToolError = { kind: "execution_failed", message: "tool threw" };
    expect(err.kind).toBe("execution_failed");
  });

  it("ToolResult success variant carries result string", () => {
    const r: ToolResult = { ok: true, result: "42" };
    expect(r.ok).toBe(true);
    expect(r.result).toBe("42");
  });

  it("ToolResult failure variant carries ToolError", () => {
    const r: ToolResult = { ok: false, error: { kind: "unknown_tool", message: "x" } };
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe("unknown_tool");
  });

  it("AgentTool shape: name, description, optional schema, execute(args) -> Promise<ToolResult>", async () => {
    const tool: AgentTool = {
      name: "ping",
      description: "pong back",
      async execute(_args: unknown) {
        return { ok: true, result: "pong" };
      },
    };
    expect(tool.name).toBe("ping");
    expect(tool.description).toBe("pong back");
    expect(tool.parametersJsonSchema).toBeUndefined();
    const r = await tool.execute({});
    expect(r).toEqual({ ok: true, result: "pong" });
  });

  it("AgentTool can carry parametersJsonSchema as unknown", () => {
    const tool: AgentTool = {
      name: "calc",
      description: "calc",
      parametersJsonSchema: { type: "object", properties: { x: { type: "number" } } },
      async execute() {
        return { ok: true, result: "" };
      },
    };
    expect(tool.parametersJsonSchema).toBeDefined();
  });

  it("ToolDefinition exposes name, description, optional schema", () => {
    const def: ToolDefinition = {
      name: "search",
      description: "search docs",
      parametersJsonSchema: { type: "object" },
    };
    expect(def.name).toBe("search");
    expect(def.parametersJsonSchema).toBeDefined();
  });
});

describe("ModelProvider contract", () => {
  it("ModelProvider is an interface with complete(req): Promise<ProviderResponse>", async () => {
    const fake: ModelProvider = {
      async complete(_req) {
        const message: AssistantMessage = {
          role: "assistant",
          content: "hi",
        };
        return { message, stopReason: "completed" as StopReason };
      },
    };
    const messages: Message[] = [{ role: "user", content: "q" }];
    const res = await fake.complete({ messages });
    expect(res.message.role).toBe("assistant");
    expect(res.stopReason).toBe("completed");
  });

  it("ProviderRequest carries optional tools field", async () => {
    const seen: { tools?: ToolDefinition[] }[] = [];
    const fake: ModelProvider = {
      async complete(req) {
        seen.push(req);
        return {
          message: { role: "assistant", content: "ok" },
          stopReason: "completed",
        };
      },
    };
    await fake.complete({ messages: [] });
    await fake.complete({
      messages: [],
      tools: [{ name: "t", description: "d" }],
    });
    expect(seen[0]?.tools).toBeUndefined();
    expect(seen[1]?.tools?.length).toBe(1);
  });
});
