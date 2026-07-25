import { describe, expect, it } from "vitest";
import type {
  AgentTool,
  ModelProvider,
  ProviderStreamEvent,
  ToolDefinition,
  ToolError,
  ToolExecutionContext,
  ToolResult,
} from "@byte-mentor/agent";
import type { AssistantMessage, Message, StopReason } from "@byte-mentor/core";

describe("agent tool type contracts", () => {
  // 验证 Registry 可以用 unknown_tool code 表达调用名称不存在，并附带模型可读消息。
  it("ToolError can express unknown_tool code", () => {
    const err: ToolError = { code: "unknown_tool", message: "no such tool" };
    expect(err.code).toBe("unknown_tool");
    expect(err.message).toBe("no such tool");
  });

  // 验证参数不符合工具 schema 时使用完整的 invalid_arguments code，而不是旧缩写。
  it("ToolError can express invalid_arguments code", () => {
    const err: ToolError = { code: "invalid_arguments", message: "args must be object" };
    expect(err.code).toBe("invalid_arguments");
  });

  // 验证未预期的工具异常可以用 execution_failed code 与正常失败结果统一传递。
  it("ToolError can express execution_failed code", () => {
    const err: ToolError = { code: "execution_failed", message: "tool threw" };
    expect(err.code).toBe("execution_failed");
  });

  // 验证成功结果把可序列化的数据放在 data 字段，供 Registry 统一包装和序列化。
  it("ToolResult success variant carries JSON-compatible data", () => {
    const r: ToolResult = { ok: true, data: "42" };
    expect(r.ok).toBe(true);
    expect(r.data).toBe("42");
  });

  // 验证失败 ToolResult 通过 error 字段携带结构化 code 和消息。
  it("ToolResult failure variant carries ToolError", () => {
    const r: ToolResult = { ok: false, error: { code: "unknown_tool", message: "x" } };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("unknown_tool");
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
    const r = await tool.execute({}, { workspaceReader: {} as never });
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

  // 并发资格只描述 Runtime 调度能力；这里验证 AgentTool 可以显式声明 safe，供 Registry 查询。
  it("AgentTool can declare runtime-only safe concurrency", () => {
    const tool: AgentTool = {
      name: "lookup",
      description: "lookup docs",
      concurrency: "safe",
      async execute() {
        return { ok: true, data: [] };
      },
    };

    expect(tool.concurrency).toBe("safe");
  });

  // Tool 不读取全局 cwd；这里验证执行契约显式接收由 Registry 持有的统一 Workspace 上下文。
  it("AgentTool receives an explicit ToolExecutionContext", async () => {
    const context = { workspaceReader: {} as never } satisfies ToolExecutionContext;
    let receivedContext: ToolExecutionContext | undefined;
    const tool: AgentTool = {
      name: "capture_context",
      description: "captures context",
      async execute(_args: unknown, executionContext: ToolExecutionContext) {
        receivedContext = executionContext;
        return { ok: true, data: null };
      },
    };

    await tool.execute({}, context);

    expect(receivedContext).toBe(context);
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
