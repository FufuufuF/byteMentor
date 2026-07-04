# Agent Base 开发进度

## 当前分支

`feat/agent-base`

## 总体进度

按 `.agents/.plan/agent-base-implementation-plan.md` 推进，共 6 个 commit。

- [x] Commit 1: Core runtime contracts
- [x] Commit 2: In-memory session store
- [x] Commit 3: Provider and tool registry
- [x] Commit 4: AgentRunner
- [x] Commit 5: ContextBuilder and AgentLoop
- [ ] Commit 6: Public API and final integration

## Commit 1: Core runtime contracts（已完成）

### 新增文件

- `packages/core/src/ids.ts` — ID brand 类型与工厂（SessionId / MessageId / ToolCallId / TurnId）
- `packages/core/src/messages.ts` — Message 判别联合（UserMessage | AssistantMessage | ToolMessage）、ToolCall、StopReason
- `packages/core/src/runtime-event.ts` — RuntimeEvent 9 变体联合
- `packages/core/src/index.ts` — 公共导出（ids + messages + runtime-event）

### 测试

- `test/core/ids.test.ts` — 4 tests
- `test/core/messages.test.ts` — 8 tests
- `test/core/runtime-event.test.ts` — 12 tests

合计 24 个测试，全部通过。

### 基础设施补丁

- `tsconfig.base.json` 加 `"types": ["node"]`（让 `node:crypto` 等模块类型可用）
- `tsconfig.test.json`（新增）— 包含 `test/**/*.ts`，paths 映射到各包 src/index.ts
- `package.json` 的 `typecheck` 脚本改为 `tsc -b --pretty false && tsc -p tsconfig.test.json --noEmit`

### 已确认的契约（Phase 1 输出，后续 commit 依据）

#### 类型契约

- Message: 判别联合 `UserMessage | AssistantMessage | ToolMessage`，按 `role` 收窄
- Message.content: string
- ID: brand 类型（SessionId / MessageId / ToolCallId / TurnId），由产生者用 `crypto.randomUUID()` 生成
- RuntimeEvent: 公共基 `{ type, turnId, ts:number }`，9 个变体
- StopReason: `"completed" | "failed" | "max_iterations" | "tool_calls"`
- 错误模型: 工具用 `Result` 类型，provider 用 throw（由 AgentRunner 捕获并转为 stopReason='failed'）

#### 接口签名（后续 commit 落地）

- SessionStore: `create()` / `get(id)` / `appendMessages(id, messages)` / `getHistory(id)`；Session 仅 `{ id }`
- ModelProvider: `invoke(req)` → `{ message, stopReason }`；req `{ messages, tools? }`
- AgentTool: `{ name, description, parametersJsonSchema?, execute(args):Promise<ToolResult> }`
- ToolResult = `{ ok:true; result:string } | { ok:false; error:ToolError }`
- ToolError = `{ kind:'unknown_tool'|'invalid_args'|'execution_failed'; message:string }`
- ToolRegistry: `register` / `list():ToolDefinition[]` / `execute(name, args)`
- AgentRunner: `new AgentRunner(provider).run({ turnId, messages, tools:ToolRegistry, maxIterations? })` → `{ newMessages, stopReason, events }`；`newMessages` 只包含本轮增量消息；events 含 model/tool
- ContextBuilder: 异步返回 `Promise<Message[]>`，本分支同步实现包 Promise；不注入 system prompt
- AgentLoop: `runTurn({ sessionId?, userMessage })` → `{ sessionId, finalMessage, newMessages, stopReason, events }`

#### 行为语义

- SessionStore.appendMessages 调用时机: turn 开始时写 userMessage，turn 结束时写 assistant/tool messages（分两次）
- maxIterations 默认 10，计 provider 调用次数
- provider 返回空 content + 空 toolCalls → 当作空 content 完成
- ToolRegistry.list() 按 name 字典序稳定排序
- ID 生成归属: TurnId 由 AgentLoop；MessageId 由产生者（userMessage 由 AgentLoop、assistant/tool message 由 AgentRunner）；ToolCallId 由 provider 在 AssistantMessage.toolCalls 里自带；SessionId 由 SessionStore.create()

### RuntimeEvent 9 变体字段集

```
turn.started      { sessionId }
context.built     { messageCount }
model.requested   { messageCount, toolCount }
model.responded    { messageId, stopReason }
tool.started       { toolCallId, toolName }
tool.completed     { toolCallId, result }
tool.failed        { toolCallId, message }
turn.completed     { sessionId, messageId, stopReason }
turn.failed        { sessionId, message }
```

公共基: `{ type, turnId, ts:number }`

## Commit 2: In-memory session store（已完成）

### 新增文件

- `packages/session/src/in-memory-session-store.ts` — Session 接口 + SessionStore 接口 + InMemorySessionStore 实现
- `packages/session/src/index.ts` — 公共导出

### 测试

- `test/session/session-store.test.ts` — 6 tests（create / get）
- `test/session/session-store-history.test.ts` — 6 tests（appendMessages / getHistory）

合计 12 个测试，全部通过。

### 实现要点

- `Session` 接口仅 `{ id: SessionId }`，messages 不在 Session 上
- `SessionStore` 接口 4 个方法：`create` / `get` / `appendMessages` / `getHistory`
- `InMemorySessionStore` 用 `Map<SessionId, Message[]>` 存储
- `appendMessages` 对未知 sessionId 抛错
- `getHistory` 返回副本（`[...history]`），避免外部修改内部状态
- `getHistory` 对未知 sessionId 返回空数组

### 完成状态

- pnpm test: 36 passed（累计）
- pnpm typecheck: 通过
- pnpm lint: 通过

## Commit 3: Provider and tool registry（已完成）

### 新增文件

- `packages/agent/src/provider.ts` — ModelProvider / ProviderRequest / ProviderResponse / AgentTool / ToolDefinition / ToolResult / ToolError 契约
- `packages/agent/src/tool-registry.ts` — ToolRegistry 注册、列表、执行、参数校验和受控失败
- `test/agent/tool-contracts.test.ts` — provider/tool 类型契约测试
- `test/agent/tool-registry.test.ts` — register/list/sort 测试
- `test/agent/tool-registry-execute.test.ts` — execute 成功、未知工具、非法参数、schema 校验、工具异常测试

### 修改文件

- `packages/agent/src/index.ts` — 导出 provider 和 tool-registry public API
- `packages/agent/package.json` — 新增 `ajv`
- `pnpm-lock.yaml` — 锁定 `ajv@8.20.0`

### 测试

- `test/agent/tool-contracts.test.ts` — 10 tests
- `test/agent/tool-registry.test.ts` — 6 tests
- `test/agent/tool-registry-execute.test.ts` — 10 tests

合计 26 个 agent 测试，全部通过。

### 实现要点

- `ToolRegistry.list()` 返回 `ToolDefinition[]`，不泄漏 `execute`
- `ToolRegistry.list()` 按 name 字典序稳定排序
- `ToolRegistry.execute()` 对未知工具返回 `unknown_tool`
- `ToolRegistry.execute()` 对工具异常返回 `execution_failed`
- 无 `parametersJsonSchema` 时允许 `null` 表达 no-arg tool
- 无 `parametersJsonSchema` 且有参数时，参数必须是非数组 object
- 有 `parametersJsonSchema` 时使用 Ajv 显式校验参数
- JSON Schema 可选参数语义: 不在 `required` 的字段可缺省；字段出现时必须符合 schema
- schema 校验失败返回 `invalid_args`

### 完成状态

- pnpm test test/agent: 26 passed
- pnpm test: 62 passed（累计）
- pnpm typecheck: 通过
- pnpm lint: 通过

## Commit 4: AgentRunner（已完成）

### 新增文件

- `packages/agent/src/agent-runner.ts` — AgentRunner provider/tool loop 实现
- `test/agent/agent-runner.test.ts` — AgentRunner 无工具、单工具调用、事件、maxIterations 测试

### 修改文件

- `packages/agent/src/index.ts` — 导出 AgentRunner public API
- `packages/agent/src/provider.ts` — ModelProvider 方法名从 `complete` 调整为 `invoke`
- `test/agent/tool-contracts.test.ts` — 同步 ModelProvider `invoke` 契约测试

### 测试

- `test/agent/agent-runner.test.ts` — 5 tests

### 实现要点

- `AgentRunner` 构造器只持有 `provider`
- `run()` 入参携带 `turnId`、`messages`、`tools`、`maxIterations?`
- `AgentRunnerResult` 返回 `{ newMessages, stopReason, events }`
- `newMessages` 只包含本轮增量消息，不返回输入 history
- 无工具路径直接返回 final assistant 增量消息
- 单工具路径返回 assistant tool-call、tool result、final assistant 三条增量消息
- Runner 内部维护 working messages，用于将 tool result 回填给下一次 provider 请求
- RuntimeEvent 覆盖 `model.requested`、`model.responded`、`tool.started`、`tool.completed`、`tool.failed`
- RuntimeEvent 使用外部传入的 `turnId`
- `maxIterations` 默认 10，计 provider 调用次数
- 达到 provider 调用上限后返回 `stopReason: "max_iterations"`
- Provider 抛错时返回 `stopReason: "failed"`，保留已产生的 `model.requested` event，不向外 reject
- Provider 错误详情暂不落入 RuntimeEvent，已留 TODO，后续接入 OpenAI SDK 或其他真实 Provider 时补齐

### 完成状态

- pnpm test test/agent/agent-runner.test.ts: 5 passed
- pnpm test: 67 passed（provider-error-catch 补丁后累计）
- pnpm typecheck: 通过
- pnpm lint: 通过

### 补充提交

- `9259a4f feat: add provider-error-catch` — 修复进度文件中已确认但代码缺失的 Provider throw → failed result 契约。

## Commit 5: ContextBuilder and AgentLoop（已完成）

### 新增文件

- `packages/agent/src/context-builder.ts` — ContextBuilder 最小实现，将 session history 与本轮 user message 拼接为模型输入消息。
- `packages/agent/src/agent-loop.ts` — AgentLoop / HeadlessTurnInput / HeadlessTurnResult / AgentLoopInput，实现通用 headless turn 编排。
- `test/agent/context-builder.test.ts` — ContextBuilder 行为测试。
- `test/agent/agent-loop.test.ts` — AgentLoop 新 session、已有 session、工具 trace、RuntimeEvent 测试。

### 修改文件

- `packages/agent/src/index.ts` — 导出 `AgentLoop` 与 `ContextBuilder` public API。
- `eslint.config.mjs` — 增加 `**/dist/**` ignore，避免 `tsc -b` 生成的 package dist 声明文件被 lint。

### 测试

- `test/agent/context-builder.test.ts` — 1 test
- `test/agent/agent-loop.test.ts` — 4 tests

合计 5 个新增测试，全部通过。

### 实现要点

- `ContextBuilder.build({ history, userMessage })` 返回 `[...history, userMessage]`，不注入 system prompt。
- `AgentLoop` 构造器使用对象参数：`{ sessionStore, contextBuilder, runner }`。
- `AgentLoop.runTurn({ sessionId?, userMessage })` 是 headless turn API，输入 user message string，由 loop 生成 `UserMessage` 与 `MessageId`。
- 无 `sessionId` 时创建新 session；有 `sessionId` 时复用已有 session 并读取 history。
- turn 开始先 `appendMessages(sessionId, [userMessage])`；runner 完成后再保存 assistant/tool 增量 messages。
- `AgentLoop` 内部创建并持有 `readonly tools = new ToolRegistry()`，外部通过 `loop.tools.register(tool)` 注册工具，和 nanobot 的 `self.tools = ToolRegistry()` 方向一致。
- `AgentLoop` 调用 `ContextBuilder` 生成完整 runner input messages，再调用 `AgentRunner.run({ turnId, messages, tools })`。
- 工具调用场景下 session 保存完整 trace：user、assistant tool-call、tool result、final assistant。
- `HeadlessTurnResult.newMessages` 返回本轮完整新增 messages：user + runner newMessages。
- `RuntimeEvent` 序列包含 loop 层事件和 runner 层事件：`turn.started`、`context.built`、`model.*`、`tool.*`、`turn.completed`。
- 同一 turn 内所有 RuntimeEvent 共用 `AgentLoop` 生成的 `turnId`。

### 完成状态

- pnpm test: 72 passed（累计）
- pnpm typecheck: 通过
- pnpm lint: 通过

### Plan 范围核对

- Plan 范围内文件：`packages/agent/src/context-builder.ts`、`packages/agent/src/agent-loop.ts`、`packages/agent/src/index.ts`、`test/agent/agent-loop.test.ts`。
- 额外测试文件：`test/agent/context-builder.test.ts`，用于将 ContextBuilder 独立小步 TDD 化。
- Plan 范围外补丁：`82d16f0 chore(lint): ignore package dist outputs`，仅用于忽略 package dist 构建产物，保证 `pnpm lint` 在 `pnpm typecheck` 后仍稳定通过。
- 未触及 CLI / TUI / Knowledge / 真实 Provider / 文件持久化。

## 下一步

进入 Commit 6: Public API and final integration。
