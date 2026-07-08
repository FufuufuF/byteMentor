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

测试：

- 创建 session 后可读取。
- 追加多条 messages 后顺序稳定。
- 重新打开同一个 SQLite 文件后可恢复 history。
- 读取不存在的 session 保持现有语义。

Review 重点：

- `SessionStore` 接口是否已提取到独立文件，`InMemorySessionStore` 和 `SqliteSessionStore` 均从该文件导入。
- `close()` 是否已加入接口，`InMemorySessionStore` 是否实现为 no-op。
- SQLite 层是否仍然只是通用 session/message 存储。
- 是否完整保存现有 `Message` JSON。
- 是否避免把教学、Knowledge 或 UI 语义放入 session。
- 是否没有引入不必要的 migration framework。

### Commit 2: OpenAI Chat Provider

范围：

- 新增 `packages/agent/src/openai-chat-provider.ts`
- 修改 `packages/agent/src/index.ts`
- 修改 `packages/agent/package.json`
- 修改 `package.json`
- 修改 `pnpm-lock.yaml`
- 新增 `test/agent/openai-chat-provider.test.ts`

目标：

- 用官方 OpenAI SDK 实现 `ModelProvider`。
- 支持内部 messages 到 Chat Completions messages 的映射。
- 支持内部 tool definitions 到 Chat Completions tools 的映射。
- 支持 assistant 文本回复和 tool calls 映射回内部 `AssistantMessage`。
- 移除 `@byte-mentor/agent` 中当前未使用的 `@byte-mentor/knowledge` 依赖。

测试：

- 普通 assistant 文本响应能映射为 `ProviderResponse`。
- tool calls 响应能映射为内部 `ToolCall[]`。
- tool message 能映射为 Chat Completions tool message。
- OpenAI SDK 抛错时返回或抛出受控错误，按现有 runner 行为验证。

Review 重点：

- OpenAI SDK 类型是否被限制在 provider 文件内。
- `AgentRunner` 和 `AgentLoop` 是否无需知道 OpenAI SDK。
- tool call id、name、args 映射是否稳定。
- provider 是否没有引入教学或 CLI 语义。

### Commit 3: CLI Config

范围：

- 新增 `apps/cli/src/config.ts`
- 修改 `apps/cli/package.json`，如果测试或运行需要补充依赖
- 新增 `test/cli/config.test.ts`

目标：

- 提供 CLI smoke command 需要的最小配置解析。
- 读取 `OPENAI_API_KEY`、`BYTE_MENTOR_MODEL`、`BYTE_MENTOR_OPENAI_BASE_URL`、`BYTE_MENTOR_DB_PATH`。
- 对缺失配置给出清晰错误。
- 决定默认 SQLite 数据库路径。

测试：

- 缺少 API key 时返回清晰错误。
- 可以读取 model、base URL 和 db path。
- 未指定 db path 时使用默认路径。

Review 重点：

- 配置逻辑是否独立于 agent runtime。
- 是否没有把环境变量读取散落到多个模块。
- 错误信息是否不泄露 secret。

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
- 执行一次真实 `runTurn`。
- 输出最终 assistant 回复。

测试：

- 用 fake provider 或 fake loop 验证 `run-chat` 能输出 completed result。
- 非 completed result 能输出清晰错误。
- 未传用户输入时返回命令用法错误。

Review 重点：

- CLI 是否只是组装层。
- 是否没有引入 TUI 或复杂命令框架。
- 是否没有在 CLI 中直接写 OpenAI SDK 调用或 SQL。

### Commit 5: Local Smoke Docs and Runtime Ignore Rules

范围：

- 新增 `README.md`，如果根目录仍不存在
- 修改 `.gitignore`
- 可能新增 `.env.example`

目标：

- 记录本地真实 smoke 的运行方式。
- 忽略默认 SQLite 数据库目录或文件。
- 说明当前能力边界和非目标。

测试：

- `pnpm test`
- `pnpm typecheck`
- 手动 smoke，使用真实 `OPENAI_API_KEY` 和 model。

Review 重点：

- 文档是否只承诺本分支已实现能力。
- 默认运行产物是否不会被误提交。
- smoke 命令是否可以被 reviewer 直接复现。

## 4. 文件改动总览

预计新增：

- `packages/session/src/session-store.ts`
- `packages/session/src/sqlite-session-store.ts`
- `packages/agent/src/openai-chat-provider.ts`
- `apps/cli/src/config.ts`
- `apps/cli/src/run-chat.ts`
- `test/session/sqlite-session-store.test.ts`
- `test/agent/openai-chat-provider.test.ts`
- `test/cli/config.test.ts`
- `test/cli/run-chat.test.ts`，如果 `run-chat` 逻辑需要独立测试
- `README.md`，如果根目录仍不存在
- `.env.example`，如果决定提供示例配置

预计修改：

- `packages/session/src/in-memory-session-store.ts`
- `packages/session/src/index.ts`
- `packages/session/package.json`
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
- `packages/core/**`

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
