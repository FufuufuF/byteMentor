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
import { ByteMentorTui } from "@byte-mentor/tui";
import type { ByteMentorTuiOptions } from "@byte-mentor/tui";
import type { CliConfig } from "./config.js";
import {
  InteractiveChatController,
  type InteractiveChatView,
} from "./interactive-chat-controller.js";

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
  createView?: (options: ByteMentorTuiOptions) => InteractiveChatView;
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
  let controller: InteractiveChatController | undefined;
  try {
    runtime = (deps.createLoop ?? createRuntime)(config);
    const createView = deps.createView ?? ((options) => new ByteMentorTui(options));
    const view = createView({
      model: config.model,
      workspaceRoot: config.workspaceRoot,
      onSubmit(text) {
        void controller?.submit(text);
      },
      onExit() {
        controller?.requestExit();
      },
    });
    controller = new InteractiveChatController({
      loop: runtime.loop,
      view,
      close: runtime.close,
    });
    await controller.start(config.initialMessage);
    return await controller.waitForExit();
  } catch (error) {
    io.stderr.write(`${errorMessage(error)}\n`);
    if (controller !== undefined) {
      return await controller.waitForExit();
    }
    await runtime?.close();
    return 1;
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
