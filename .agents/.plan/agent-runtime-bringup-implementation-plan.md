# Agent Runtime Bring-up 实现计划

## 1. 目标

按 `.agents/.design/agent-runtime-bringup-design.md` 实现真实本地可运行的 Agent Runtime Bring-up。

本分支完成后，应能通过最小 CLI 跑通：

```text
用户输入
  -> SQLite session
  -> OpenAI Chat provider
  -> AgentLoop / AgentRunner
  -> 保存消息
  -> 输出 assistant 回复
```

## 2. 实现原则

- 架构边界以 `.agents/.design/agent-runtime-bringup-design.md` 为准。
- 每个提交保持可审阅的小增量。
- 每个提交必须有对应测试，真实 OpenAI API 调用只做手动 smoke。
- 不实现 Knowledge、TUI、streaming、Responses API 或多 provider 注册中心。
- 除非现有契约无法表达 Chat Completions 必需信息，否则不修改 `packages/core/**`。

## 3. 提交拆分

### Commit 0: 前置清理 - 移除 agent 对 knowledge 的未使用依赖

范围：

- 修改 `packages/agent/package.json`（移除 `"@byte-mentor/knowledge": "workspace:*"`）
- 修改 `pnpm-lock.yaml`

目标：

- 移除 `@byte-mentor/agent` 中当前未使用的 `@byte-mentor/knowledge` 依赖。这是 design §6 明确要求的边界（"agent 当前不应依赖 knowledge"），当前是历史遗留。

测试：

- `pnpm test` 全部通过（如已通过则说明该依赖真的未被使用）。
- `pnpm typecheck` 通过。

Review 重点：

- diff 是否只涉及 `package.json` 和 `pnpm-lock.yaml`。
- 移除后 agent 包能正确编译（无 knowledge 类型漏引用）。

### Commit 1: SQLite SessionStore

范围：

- 新增 `packages/session/src/session-store.ts`（从 `in-memory-session-store.ts` 提取 `SessionStore` 接口和 `Session` 类型）
- 修改 `packages/session/src/in-memory-session-store.ts`（移除接口定义，改为从 `session-store.ts` 导入；新增 `close()` no-op 实现）
- 新增 `packages/session/src/sqlite-session-store.ts`
- 修改 `packages/session/src/index.ts`
- 修改 `packages/session/package.json`
- 修改 `package.json`
- 修改 `pnpm-lock.yaml`
- 新增 `test/session/sqlite-session-store.test.ts`

目标：

- 将 `SessionStore` 接口和 `Session` 类型提取到独立文件，使接口与实现解耦。
- 在 `SessionStore` 接口上新增 `close(): Promise<void>` 方法，`InMemorySessionStore` 实现为 no-op。
- 增加 `SessionStore` 的 SQLite 实现。
- 支持创建 session、读取 session、追加 messages、按顺序读取 history。
- 支持关闭数据库连接。
- 覆盖跨 store 实例恢复已有历史。

Schema 契约：

表结构、字段类型、约束、运行时约定（`PRAGMA foreign_keys = ON`、单条 `INSERT ... SELECT MAX+1`、显式事务包裹 `INSERT` + `UPDATE sessions.updated_at`、`role` 列只写不改、`crypto.randomUUID()` 生成 session id）以 `.agents/.design/agent-runtime-bringup-design.md` §7 为准。不在本 plan 重复。

测试：

- 创建 session 后可读取。
- 追加多条 messages 后顺序稳定。
- 重新打开同一个 SQLite 文件后可恢复 history。
- 读取不存在的 session 保持现有语义。
- 外键 CASCADE 生效（删除 session 后其 messages 也被清空）——验证 `PRAGMA foreign_keys = ON` 已启用。
- 复合主键 UNIQUE 约束生效（同 `(session_id, seq)` 二次插入抛错）。
- `SqliteSessionStore.close()` 幂等（连续调用两次不抛错）。
- `SqliteSessionStore` close 后再调用其它方法抛 `SessionStoreClosedError`。
- `InMemorySessionStore.close()` 为 no-op，close 后其它方法仍可用（测试宽容性）。

Review 重点：

- `SessionStore` 接口是否已提取到独立文件，`InMemorySessionStore` 和 `SqliteSessionStore` 均从该文件导入。
- `close()` 是否已加入接口，`InMemorySessionStore` 是否实现为 no-op。
- SQLite 层是否仍然只是通用 session/message 存储。
- schema 是否与 design §7 一致（列名、类型、约束、`WITHOUT ROWID`、外键 CASCADE）。
- store 初始化是否执行 `PRAGMA foreign_keys = ON`。
- append message 是否使用单条 `INSERT ... SELECT MAX+1`，不使用先 SELECT 再 INSERT 两步式写法。
- 是否完整保存现有 `Message` JSON。
- 是否避免把教学、Knowledge 或 UI 语义放入 session。
- 是否没有引入不必要的 migration framework。

### Commit 2a: ToolCall 参数解析失败契约

范围：

- 修改 `packages/core/src/messages.ts`
- 修改 `packages/agent/src/agent-runner.ts`
- 修改 `test/core/**`（如现有 tool call 相关测试需要更新）
- 修改 `test/agent/agent-runner.test.ts`

目标：

- 在 `ToolCall` 上新增可选字段 `argsParseError?: string`，用于表达 provider 层解析 `arguments` 失败。
- `AgentRunner` 在处理 tool call 时，若发现 `argsParseError` 存在：
  - 不调用 `ToolRegistry.execute()`。
  - 合成一条 `ToolMessage`，`content` 描述参数解析失败、包含 raw arguments 和错误信息、提示模型按 schema 重试。
  - 将 assistant message 和这条合成 tool message 一并交给上层保存。
  - 继续下一轮循环（不中断 turn）。

Schema 契约以 `.agents/.design/agent-runtime-bringup-design.md` §5.2 "Chat Completions 映射约定 - `arguments` 解析失败的处理" 为准。

测试：

- Runner 收到带 `argsParseError` 的 `ToolCall` 时不调用工具。
- 合成的 tool message `role` 为 `"tool"`，`toolCallId` 与原 `ToolCall.id` 一致，`content` 包含错误信息和 raw args。
- 循环继续，下一次 provider 调用能看到 assistant message + 合成 tool message。
- 常规（无 `argsParseError`）tool call 行为不变。

Review 重点：

- `ToolCall.argsParseError` 是否为可选字段，不影响未设置该字段的现有代码。
- `AgentRunner` 是否只在 `argsParseError` 存在时走合成分支，其它路径不变。
- 合成 tool message 是否明确告诉模型"参数错了"而不是伪装成 tool 真的执行了。
- 是否没有把这个错误当作 turn 失败（stopReason 不应是 `failed`）。

### Commit 2b: OpenAI Chat Provider

范围：

- 新增 `packages/agent/src/openai-chat-provider.ts`
- 修改 `packages/agent/src/index.ts`
- 修改 `packages/agent/package.json`
- 修改 `package.json`
- 修改 `pnpm-lock.yaml`
- 新增 `test/agent/openai-chat-provider.test.ts`

目标：

- 用官方 OpenAI SDK 实现 `ModelProvider`。
- 完成 `.agents/.design/agent-runtime-bringup-design.md` §5.2 "Chat Completions 映射约定" 中定义的双向映射（请求方向、响应方向、finish_reason 映射表）。
- `arguments` 解析失败时通过 `ToolCall.argsParseError` 传递（依赖 Commit 2a）。
- OpenAI SDK 类型仅在 provider 文件内部使用。

映射契约以 design §5.2 为准，不在本 plan 重复。

测试（使用 fake OpenAI client，不访问真实 API）：

- 单个 user message，OpenAI 返回 `finish_reason: "stop"` + content → `stopReason: "completed"`。
- OpenAI 返回 tool_calls + `finish_reason: "tool_calls"` → `stopReason: "tool_calls"`，`toolCalls` 正确 parse。
- tool_calls 中 `arguments` 是非法 JSON → 返回带 `argsParseError` 的 `ToolCall`，不抛错。
- OpenAI 返回 `content: null` 且无 tool_calls → 受控失败（抛错或 `stopReason: "failed"`，与 runner 语义一致）。
- `finish_reason: "length"` → `stopReason: "failed"`。
- `finish_reason: "content_filter"` → `stopReason: "failed"`。
- 内部 `Message[]` 含 tool message → OpenAI `role: "tool"`，`tool_call_id` 正确。
- 内部 `AssistantMessage` 含 `toolCalls` → OpenAI `tool_calls`，`arguments` 是字符串（`JSON.stringify` 结果）。
- `tools` 为空数组 → 请求中不带 `tools` 字段。
- `parametersJsonSchema` 为 undefined → 请求中不带 `parameters` 字段。
- 一次返回多个 tool_calls → 全部转成内部 `toolCalls`，不筛选。
- OpenAI SDK 抛错（网络、API 错误）→ provider 直接透传抛出。

Review 重点：

- OpenAI SDK 类型是否被限制在 provider 文件内（`openai-chat-provider.ts` 之外无 `openai` import）。
- `openai-chat-provider.ts` 的 export 是否只包含 `OpenAIChatProvider` 类和它的 config 类型。
- `AgentRunner` 和 `AgentLoop` 是否无需知道 OpenAI SDK。
- tool call id、name、args 映射是否稳定。
- `finish_reason` 映射表是否与 design §5.2 完全一致。
- `arguments` parse 失败时是否走 `argsParseError` 路径而非抛错。
- provider 是否没有引入教学或 CLI 语义。
- 是否没有在 provider 内做重试或降级（这些属于装饰器 provider 的职责）。

### Commit 2c: Streaming Support

范围：

- 修改 `packages/agent/src/provider.ts`（`ModelProvider` 接口新增 `invokeStream`，新增 `ProviderStreamEvent` 类型）
- 修改 `packages/agent/src/openai-chat-provider.ts`（实现 `invokeStream`，`invoke` 改为其折叠包装）
- 修改 `packages/agent/src/agent-runner.ts`（内部消费 `invokeStream`，转发 content_delta 事件）
- 修改 `packages/agent/src/agent-loop.ts`（`runTurn` 接受 `onStreamEvent` callback）
- 修改现有 `test/agent/*` 中受影响的测试
- 新增流式相关测试

目标：

- 完成 design §5.2 "流式支持" 定义的接口和行为。
- Provider 内部按 design 规定的规则累加 chunk（`Map<index, {...}>` 累加、`finish_reason` 出现时 parse arguments）。
- Runner 在多轮 tool_call 循环中，只对最终完成轮次（无 tool_calls）的 `content_delta` 透传给 `onStreamEvent`。中间轮次静默保存到 session。
- `invoke` 内部通过 `invokeStream` 折叠所有事件实现，避免代码重复。

架构和事件契约以 design §5.2 "流式支持" 为准，不在本 plan 重复。

测试（fake stream，不访问真实 API）：

- Fake provider 按 chunk 序列输出（`role`/`content`/`tool_calls delta`/`finish_reason`），`invokeStream` 正确产出 `content_delta` 序列和最终 `done` 事件。
- 累加 content：多个 `content_delta` chunk 拼成完整 content。
- 累加 tool_calls：跨 chunk 的 `function.arguments` 字符串片段拼成完整 JSON，最终 `JSON.parse` 成对象。
- 一次流内多个 tool_call（`index=0`、`index=1`）分别累加，`done` 事件中 `toolCalls` 数组顺序稳定。
- tool_call `arguments` 拼完后 parse 失败 → `done` 事件的 `ToolCall` 带 `argsParseError`，不抛错。
- `invoke` 折叠包装：调用 `invoke` 得到的 `ProviderResponse` 与手动累加 `invokeStream` 的结果一致。
- Runner 在无 tool_call 的轮次：`onStreamEvent` 收到所有 `content_delta`。
- Runner 在有 tool_call 的中间轮次：`onStreamEvent` **不**收到该轮次的 `content_delta`，但 session 保存的 assistant message content 完整。
- Runner 在多轮 tool_call 循环的最后一轮（无 tool_calls）：`onStreamEvent` 收到该轮次的 `content_delta`。
- `AgentLoop.runTurn` 不传 `onStreamEvent` 时行为与非流式一致。

Review 重点：

- `ProviderStreamEvent` 是否为 tagged union，字段无遗漏。
- Provider 累加逻辑是否严格按 design 规定：以 `index` 为键、`finish_reason` 出现时才 parse arguments。
- `AgentRunner` 是否只在**最后一轮**（`stopReason === "completed"`）透传 `content_delta`。
- `AgentLoop` 是否将 `onStreamEvent` 作为可选参数，不改变现有 API 的默认行为。
- `RuntimeEvent` 是否**未被**流式 chunk 淹没（design §5.2 明确两者分离）。
- `invoke` 是否为 `invokeStream` 的折叠包装，无重复实现。

### Commit 3: CLI Config

范围：

- 新增 `apps/cli/src/config.ts`
- 新增 `test/cli/config.test.ts`

目标：

- 提供 CLI smoke command 需要的最小配置解析。
- 使用 `node:util` 的 `parseArgs` 解析命令行（subcommand + 位置参数），不引入第三方命令框架。
- 读取环境变量：`OPENAI_API_KEY`、`BYTE_MENTOR_MODEL`、`BYTE_MENTOR_OPENAI_BASE_URL`、`BYTE_MENTOR_DB_PATH`。
- 对缺失配置给出清晰错误。
- 按 design §5.3 "默认数据库路径" 规则解析 DB 路径（`BYTE_MENTOR_DB_PATH` > `path.resolve(process.cwd(), '.byte-mentor/byte-mentor.sqlite')`），并 `mkdirSync` 确保目录存在。

命令解析和 DB 路径契约以 design §5.3 为准，不在本 plan 重复。

测试：

- `parseArgs` 正确切分位置参数（`chat` subcommand + 用户消息）。
- 缺少 API key 时返回清晰错误。
- 缺少 model 时返回清晰错误。
- 缺少用户消息（位置参数）时返回命令用法错误。
- 可以读取 model、base URL 和 db path。
- 未指定 `BYTE_MENTOR_DB_PATH` 时使用默认路径 `.byte-mentor/byte-mentor.sqlite`（相对 `cwd`）。
- `BYTE_MENTOR_DB_PATH` 为相对路径时相对 `cwd` 解析。
- `BYTE_MENTOR_DB_PATH` 为绝对路径时原样使用。
- 错误消息不含 API key 值。

Review 重点：

- 配置逻辑是否独立于 agent runtime。
- 是否没有把环境变量读取散落到多个模块。
- 错误信息是否不泄露 secret。
- 错误信息是否不含数据库绝对路径（用相对路径或 env 变量名替代）。
- 是否使用 `node:util parseArgs`，未引入 `commander` / `yargs`。

### Commit 4: CLI Smoke Command

范围：

- 修改 `apps/cli/src/index.ts`
- 新增 `apps/cli/src/run-chat.ts`
- 修改 `apps/cli/package.json`，如果需要补充 bin 或运行脚本
- 可能新增 `test/cli/run-chat.test.ts`

目标：

- 提供最小命令：

```bash
byte-mentor chat "解释一下 Promise"
```

- 组装 `SqliteSessionStore`、`ContextBuilder`、`AgentRunner`、`OpenAIChatProvider` 和 `AgentLoop`。
- 执行一次真实 `runTurn`，传入 `onStreamEvent` callback。
- 在 callback 内对 `content_delta` 事件调用 `process.stdout.write(text)` 实时打印。
- 流结束后输出换行，若 `stopReason !== "completed"` 打印清晰错误。
- 使用 `try / finally` 保证异常路径下 `SqliteSessionStore.close()` 一定被调用。

测试：

- 用 fake provider 或 fake loop 验证 `run-chat` 能输出 completed result。
- 用 fake provider 输出多段 content_delta，验证 CLI 按序拼出完整输出。
- 非 completed result 能输出清晰错误。
- 未传用户输入时返回命令用法错误。
- 抛错场景下（例如 provider 请求失败） `store.close()` 仍然被调用（验证 try/finally 生效）。

Review 重点：

- CLI 是否只是组装层。
- 是否没有引入 TUI 或复杂命令框架。
- 是否没有在 CLI 中直接写 OpenAI SDK 调用或 SQL。
- CLI 是否只处理 `content_delta` 和最终结果，不解析 `done` 事件里的 tool_calls 等内部字段。
- 是否使用 `try / finally` 保证异常路径调用 `store.close()`。

### Commit 5: Local Smoke Docs and Runtime Ignore Rules

范围：

- 新增 `README.md`（当前根目录没有）
- 新增 `.env.example`
- 修改 `.gitignore`

目标：

- 记录本地真实 smoke 的运行方式。
- 忽略默认 SQLite 数据库目录（`.byte-mentor/`）和本地 `.env`。
- 说明当前能力边界和非目标。

`README.md` 至少包含：

- 安装依赖：`pnpm install`
- 环境变量说明（对齐 `.env.example`）：`OPENAI_API_KEY`（必填）、`BYTE_MENTOR_MODEL`（必填）、`BYTE_MENTOR_OPENAI_BASE_URL`（可选）、`BYTE_MENTOR_DB_PATH`（可选）。
- 运行 smoke 的命令：`OPENAI_API_KEY=... BYTE_MENTOR_MODEL=gpt-4o-mini pnpm --filter @byte-mentor/cli exec byte-mentor chat "解释一下 Promise"`（具体命令按实际 pnpm bin 配置调整）。
- 明确"在 repo 根运行"的建议，说明 DB 会生成在 `.byte-mentor/`。
- 本分支能力边界和非目标（参考 design §10）。

`.env.example` 至少包含：

```
OPENAI_API_KEY=sk-...
BYTE_MENTOR_MODEL=gpt-4o-mini
# BYTE_MENTOR_OPENAI_BASE_URL=
# BYTE_MENTOR_DB_PATH=
```

`.gitignore` 新增：

```
.byte-mentor/
.env
```

自动化测试：

- `pnpm test`
- `pnpm typecheck`

手动 smoke 步骤（reviewer 应能逐步复现）：

1. 复制 `.env.example` 为 `.env`，填入真实 `OPENAI_API_KEY` 和 `BYTE_MENTOR_MODEL`。
2. 首次运行：`byte-mentor chat "解释一下 Promise"`。**预期**：终端流式打印 assistant 回复；结束后本目录出现 `.byte-mentor/byte-mentor.sqlite`。
3. 用 sqlite CLI 验证落库：`sqlite3 .byte-mentor/byte-mentor.sqlite "SELECT id, created_at FROM sessions"`（应看到一条 session）、`sqlite3 .byte-mentor/byte-mentor.sqlite "SELECT seq, role FROM messages"`（应至少有 user 和 assistant 各一条，按 seq 递增）。
4. **不删除 `.byte-mentor/`**，再次运行 `byte-mentor chat "换个方式解释"`。**预期**：本分支 CLI 每次新建 session（未实现 `--session`），但 SQLite 文件里应能看到**两个** session。
5. 验证 close 生效：运行结束后 `.byte-mentor/byte-mentor.sqlite` 无 `-journal` 或 `-wal` 文件残留（有的话说明 close 没跑或跑失败）。
6. 故意断网或使用错误 API key，验证 CLI 报错清晰、不泄露 key、`store.close()` 仍生效（无 journal 残留）。

Review 重点：

- 文档是否只承诺本分支已实现能力。
- 默认运行产物是否不会被误提交（`.gitignore` 覆盖 `.byte-mentor/` 和 `.env`）。
- smoke 命令是否可以被 reviewer 逐步复现。
- `.env.example` 是否不含真实 secret（占位符 `sk-...` 而非任何真实 key）。

## 4. 文件改动总览

预计新增：

- `packages/session/src/session-store.ts`
- `packages/session/src/sqlite-session-store.ts`
- `packages/agent/src/openai-chat-provider.ts`
- `apps/cli/src/config.ts`
- `apps/cli/src/run-chat.ts`
- `test/session/sqlite-session-store.test.ts`
- `test/agent/openai-chat-provider.test.ts`
- `test/agent/openai-chat-provider.stream.test.ts`（Commit 2c 流式测试独立文件）
- `test/cli/config.test.ts`
- `test/cli/run-chat.test.ts`
- `README.md`
- `.env.example`

预计修改：

- `packages/core/src/messages.ts`（新增 `ToolCall.argsParseError` 可选字段）
- `packages/session/src/in-memory-session-store.ts`
- `packages/session/src/index.ts`
- `packages/session/package.json`
- `packages/agent/src/provider.ts`（新增 `invokeStream` 和 `ProviderStreamEvent`）
- `packages/agent/src/agent-runner.ts`（处理带 `argsParseError` 的 tool call；消费 `invokeStream` 并转发 content_delta）
- `packages/agent/src/agent-loop.ts`（`runTurn` 接受 `onStreamEvent` callback）
- `packages/agent/src/index.ts`
- `packages/agent/package.json`
- `apps/cli/src/index.ts`
- `apps/cli/package.json`
- `package.json`
- `pnpm-lock.yaml`
- `.gitignore`

默认不改：

- `packages/knowledge/**`
- `packages/tui/**`
- `packages/core/**` 除上述 `messages.ts` 的可选字段扩展

## 5. 分支完成定义

- `SqliteSessionStore` 通过自动化测试。
- `OpenAIChatProvider` 通过自动化测试，测试不访问真实 API。
- CLI 能通过真实 OpenAI API 跑一轮非 TUI chat。
- 同一个 SQLite db 能恢复已有 session history。
- `pnpm test` 通过。
- `pnpm typecheck` 通过。

## 6. Review 前确认点

- SQLite driver 使用 `better-sqlite3`。
- Provider 命名使用 `OpenAIChatProvider`。
- 默认 SQLite db path 使用 `.byte-mentor/byte-mentor.sqlite`。
- CLI 第一版至少支持新 session；是否在本分支支持 `--session <id>` 可在实现前最后确认。
