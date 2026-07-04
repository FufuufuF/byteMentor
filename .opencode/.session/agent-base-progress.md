# Agent Base 开发进度

## 当前分支

`feat/agent-base`

## 总体进度

按 `.agents/.plan/agent-base-implementation-plan.md` 推进，共 6 个 commit。

- [x] Commit 1: Core runtime contracts
- [x] Commit 2: In-memory session store
- [x] Commit 3: Provider and tool registry
- [ ] Commit 4: AgentRunner
- [ ] Commit 5: ContextBuilder and AgentLoop
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
- ModelProvider: `complete(req)` → `{ message, stopReason }`；req `{ messages, tools? }`
- AgentTool: `{ name, description, parametersJsonSchema?, execute(args):Promise<ToolResult> }`
- ToolResult = `{ ok:true; result:string } | { ok:false; error:ToolError }`
- ToolError = `{ kind:'unknown_tool'|'invalid_args'|'execution_failed'; message:string }`
- ToolRegistry: `register` / `list():ToolDefinition[]` / `execute(name, args)`
- AgentRunner: `run({ messages, tools:ToolRegistry, provider, maxIterations? })` → `{ messages, finalMessage, stopReason, events }`；events 含 model/tool
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

## 下一步

进入 Commit 4: AgentRunner 的 Phase 2 步骤拆分。
