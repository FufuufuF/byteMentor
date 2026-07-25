import { describe, expect, it } from "vitest";
import type {
  AgentTool,
  ModelProvider,
  ProviderStreamEvent,
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

  // 验证成功结果把可序列化的数据放在 data 字段，供 Registry 统一包装和序列化。
  it("ToolResult success variant carries JSON-compatible data", () => {
    const r: ToolResult = { ok: true, data: "42" };
    expect(r.ok).toBe(true);
    expect(r.data).toBe("42");
  });

  it("ToolResult failure variant carries ToolError", () => {
    const r: ToolResult = { ok: false, error: { kind: "unknown_tool", message: "x" } };
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe("unknown_tool");
  });

  // 验证 AgentTool 同时提供模型可见定义和返回结构化 ToolResult 的执行函数。
  it("AgentTool shape: name, description, optional schema, execute(args) -> Promise<ToolResult>", async () => {
    const tool: AgentTool = {
      name: "ping",
      description: "pong back",
      async execute(_args: unknown) {
        return { ok: true, data: "pong" };
      },
    };
    expect(tool.name).toBe("ping");
    expect(tool.description).toBe("pong back");
    expect(tool.parametersJsonSchema).toBeUndefined();
    const r = await tool.execute({});
    expect(r).toEqual({ ok: true, data: "pong" });
  });

  // 验证 AgentTool 可以携带由 Registry 编译、Provider 原样映射的参数 schema。
  it("AgentTool can carry parametersJsonSchema as unknown", () => {
    const tool: AgentTool = {
      name: "calc",
      description: "calc",
      parametersJsonSchema: { type: "object", properties: { x: { type: "number" } } },
      async execute() {
        return { ok: true, data: "" };
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
  it("ModelProvider is an interface with invoke(req): Promise<ProviderResponse>", async () => {
    const fake: ModelProvider = {
      async invoke(_req) {
        const message: AssistantMessage = {
          role: "assistant",
          content: "hi",
        };
        return { message, stopReason: "completed" as StopReason };
      },
      async *invokeStream() {
        yield {
          type: "done",
          message: { role: "assistant", content: "hi" },
          stopReason: "completed" as StopReason,
        };
      },
    };
    const messages: Message[] = [{ role: "user", content: "q" }];
    const res = await fake.invoke({ messages });
    expect(res.message.role).toBe("assistant");
    expect(res.stopReason).toBe("completed");
  });

  it("ProviderRequest carries optional tools field", async () => {
    const seen: { tools?: ToolDefinition[] }[] = [];
    const fake: ModelProvider = {
      async invoke(req) {
        seen.push(req);
        return {
          message: { role: "assistant", content: "ok" },
          stopReason: "completed",
        };
      },
      async *invokeStream(req) {
        seen.push(req);
        yield {
          type: "done",
          message: { role: "assistant", content: "ok" },
          stopReason: "completed",
        };
      },
    };
    await fake.invoke({ messages: [] });
    await fake.invoke({
      messages: [],
      tools: [{ name: "t", description: "d" }],
    });
    expect(seen[0]?.tools).toBeUndefined();
    expect(seen[1]?.tools?.length).toBe(1);
  });

  it("ModelProvider can stream content deltas before a done event", async () => {
    const fake: ModelProvider = {
      async invoke() {
        return {
          message: { role: "assistant", content: "hello world" },
          stopReason: "completed",
        };
      },
      async *invokeStream() {
        const events: ProviderStreamEvent[] = [
          { type: "content_delta", text: "hello " },
          { type: "content_delta", text: "world" },
          {
            type: "done",
            message: { role: "assistant", content: "hello world" },
            stopReason: "completed",
          },
        ];
        yield* events;
      },
    };

    const events: ProviderStreamEvent[] = [];
    for await (const event of fake.invokeStream({ messages: [] })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["content_delta", "content_delta", "done"]);
  });
});
