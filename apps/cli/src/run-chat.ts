import {
  AgentLoop,
  AgentRunner,
  ContextBuilder,
  findFilesTool,
  listDirectoryTool,
  OpenAIChatProvider,
  readFileTool,
  searchTextTool,
  ToolRegistry,
  WorkspaceAccessPolicy,
  WorkspaceReader,
} from "@byte-mentor/agent";
import type { ModelProvider } from "@byte-mentor/agent";
import { SqliteSessionStore } from "@byte-mentor/session";
import type { SessionStore } from "@byte-mentor/session";
import type { CliConfig } from "./config.js";

export interface RunChatIO {
  stdout: {
    write(text: string): void;
  };
  stderr: {
    write(text: string): void;
  };
}

export interface RunChatRuntime {
  loop: Pick<AgentLoop, "runTurn">;
  close(): Promise<void>;
}

export interface RunChatDeps {
  createLoop?: (config: CliConfig) => RunChatRuntime;
}

export interface CreateRuntimeDeps {
  provider?: ModelProvider;
  sessionStore?: SessionStore;
}

export async function runChat(
  config: CliConfig,
  io: RunChatIO,
  deps: RunChatDeps = {},
): Promise<number> {
  let runtime: RunChatRuntime | undefined;
  try {
    runtime = (deps.createLoop ?? createRuntime)(config);
    const result = await runtime.loop.runTurn(
      { userMessage: config.userMessage },
      {
        onStreamEvent(event) {
          if (event.type === "content_delta") {
            io.stdout.write(event.text);
          }
        },
      },
    );
    io.stdout.write("\n");

    if (result.status !== "completed") {
      io.stderr.write(`Agent turn did not complete: ${result.error.message}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    io.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  } finally {
    await runtime?.close();
  }
}

// 以启动时固定的工作区组装完整 Agent Runtime；可选依赖让本地嵌入和测试复用同一条链路。
export function createRuntime(config: CliConfig, deps: CreateRuntimeDeps = {}): RunChatRuntime {
  const sessionStore = deps.sessionStore ?? new SqliteSessionStore({ dbPath: config.dbPath });
  const provider =
    deps.provider ??
    new OpenAIChatProvider({
      apiKey: config.openaiApiKey,
      model: config.model,
      ...(config.openaiBaseURL !== undefined ? { baseURL: config.openaiBaseURL } : {}),
    });
  const policy = new WorkspaceAccessPolicy();
  const workspaceReader = new WorkspaceReader({
    workspaceRoot: config.workspaceRoot,
    policy,
  });
  const tools = new ToolRegistry({
    context: { workspaceReader },
    maxSerializedToolResultCharacters: policy.limits.maxSerializedToolResultCharacters,
  });
  tools.register(listDirectoryTool);
  tools.register(findFilesTool);
  tools.register(searchTextTool);
  tools.register(readFileTool);
  const runner = new AgentRunner(provider);
  const loop = new AgentLoop({
    sessionStore,
    contextBuilder: new ContextBuilder(),
    runner,
    tools,
  });

  return {
    loop,
    close: () => sessionStore.close(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
