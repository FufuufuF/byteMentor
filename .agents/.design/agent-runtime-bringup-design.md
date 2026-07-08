# Agent Runtime Bring-up 设计

## 1. 文档定位

本文档定义 `feat/agent-runtime-bringup` 分支的设计结论。

它不是执行计划。具体提交拆分、文件范围和测试安排见 `.agents/.plan/agent-runtime-bringup-implementation-plan.md`。

本文档建立在 `.agents/.design/agent-base-design.md` 已完成的 Headless Agent Base 之上，目标是让该基座从 fake provider / in-memory session 进入真实本地可运行状态。

## 2. 目标和第一阶段范围

本分支要交付一个最小真实运行闭环：

```text
用户从 CLI 输入一条消息
  -> CLI 读取本地配置
  -> 创建或恢复 SQLite session
  -> ContextBuilder 构建模型输入
  -> AgentRunner 调用真实 OpenAI Chat Completions provider
  -> 必要时执行 ToolRegistry 中的工具
  -> 保存本轮 user / assistant / tool messages
  -> CLI 输出最终 assistant 回复
```

这个闭环的意义不是完成最终教学产品，而是验证 Agent Base 的核心抽象能承载真实模型和真实本地持久化。

第一阶段范围包括：

- SQLite-backed `SessionStore`。
- 基于官方 OpenAI SDK 的 Chat Completions provider。
- 一个非 TUI 的最小 CLI smoke command。
- 本地运行说明和默认运行产物忽略规则。

## 3. 设计原则

- 保持现有 Agent Base 抽象，不让 OpenAI SDK 类型扩散到 `AgentRunner`、`AgentLoop`、`core` 或 `session`。
- SQLite 只保存通用 session 和 message，不承载 Knowledge、Teaching Brief、Observation Log 或用户知识状态。
- CLI 只作为应用组装层，不拥有模型调用循环、session 规则或教学逻辑。
- 第一版优先跑通真实闭环，不引入 streaming、TUI 或完整命令框架。
- 自动化测试不访问真实 OpenAI API；真实 API 调用只作为手动 smoke 验收。

## 4. 技术选择

### 4.1 SQLite session

本分支选择 SQLite 作为第一版本地持久化存储。

原因：

- Byte Mentor 的学习会话需要跨进程恢复。
- 后续会自然需要按时间列出会话、恢复指定会话、关联 compact summary 和 Knowledge 写回结果。
- 相比 JSON 文件，SQLite 能更早提供稳定排序、事务和查询能力，避免后续手写索引和文件锁。

SQLite 第一版只保存完整消息 JSON，不把 user / assistant / tool message 拆成多张业务表。

这样做的取舍是：

- 优点：保留当前 `Message` 契约的演进空间，减少第一版 schema 固化。
- 缺点：按消息内部字段查询不方便。

当前阶段更看重运行闭环和边界稳定，因此接受这个取舍。

SQLite driver 初版使用 `better-sqlite3`。

原因：

- 本地 CLI 场景中同步 SQLite API 足够简单直接。
- 生态成熟。
- 避免在核心 session 存储中依赖当前仍会产生 experimental warning 的 `node:sqlite`。

### 4.2 OpenAI Chat Completions provider

本分支选择官方 OpenAI SDK，并先接 Chat Completions API。

原因：

- 当前 `ModelProvider` 接口以 `messages`、`tools`、assistant response 和 tool calls 为核心，和 Chat Completions 的结构更接近。
- 这个选择能最小化对现有 `AgentRunner` 的改动。
- Responses API 更接近 OpenAI 后续 agentic API 方向，但它的 input / output item 模型和当前内部 `Message` 契约不完全一致，适合后续单独设计迁移。

Provider 命名为：

```text
OpenAIChatProvider
```

这个名字表达的是：

- 它是 OpenAI SDK 的 adapter。
- 它接的是 Chat Completions 风格。
- 它不承诺兼容所有 OpenAI-compatible 服务。

Provider 的职责是适配，不是驱动架构：

```text
ProviderRequest
  -> OpenAI chat.completions.create(...)
  -> ProviderResponse
```

OpenAI SDK 类型应限制在 provider 实现内部。

### 4.3 CLI smoke command

本分支需要一个最小 CLI smoke command。

原因是只实现 SQLite store 和 provider 仍然只能证明模块分别可用，不能证明应用组装链路成立。

CLI 第一版只负责：

- 解析最小命令。
- 读取 env / args 配置。
- 创建 `SqliteSessionStore`、`OpenAIChatProvider`、`AgentRunner`、`ContextBuilder` 和 `AgentLoop`。
- 调用一次 `runTurn`。
- 打印最终 assistant 内容。

CLI 第一版不负责：

- TUI。
- 多轮交互 shell。
- 复杂 slash command。
- 会话列表 UI。
- 教学策略。

第一版命令形态为：

```bash
byte-mentor chat "解释一下 Promise"
```

## 5. 模块边界

### 5.1 `@byte-mentor/session`

新增 SQLite session 实现。

它负责：

- 初始化最小 SQLite schema。
- 创建和读取 session。
- 追加 messages。
- 按稳定顺序读取 history。
- 关闭数据库连接。

它不负责：

- 生成 session title。
- 压缩历史。
- 知识状态写回。
- 教学语义判断。

### 5.2 `@byte-mentor/agent`

新增 OpenAI Chat provider adapter。

它负责：

- 将内部 `Message[]` 转成 OpenAI Chat Completions messages。
- 将内部 `ToolDefinition[]` 转成 OpenAI tools。
- 将 OpenAI assistant text response 转回内部 `AssistantMessage`。
- 将 OpenAI tool calls 转回内部 `ToolCall[]`。
- 将不支持或异常的 OpenAI 响应转成受控失败。

它不负责：

- 保存 session。
- 解析 CLI config。
- 决定教学策略。
- 管理多 provider 注册中心。

### 5.3 `@byte-mentor/cli`

新增最小非 TUI 运行入口。

它负责：

- 从命令行和环境变量读取配置。
- 组装本地运行时依赖。
- 执行一次真实 `AgentLoop.runTurn`。
- 输出用户可见结果或配置错误。

它不负责：

- 直接调用 OpenAI SDK。
- 直接读写 SQLite 表。
- 实现 agent loop。
- 渲染 TUI。

### 5.4 `@byte-mentor/core`

默认不改。

只有在 Chat Completions 必须表达的信息无法用现有 `Message` / `ToolCall` / `StopReason` 表达时，才考虑扩展 `core`。

第一阶段目标是避免这种扩展。

## 6. 依赖和 import 规则

本分支允许的新增运行时依赖：

- `@byte-mentor/session` 可以依赖 SQLite driver。
- `@byte-mentor/agent` 可以依赖官方 `openai` SDK。

依赖边界：

```text
cli -> agent
cli -> session
cli -> core

agent -> core
agent -> session

session -> core
```

`@byte-mentor/agent` 当前不应依赖 `@byte-mentor/knowledge`。

原因是本分支不实现 Knowledge，且 Headless Agent Base 的边界要求 agent runtime 仍可在没有 Knowledge 的情况下真实运行。

## 7. 持久化设计

SQLite 第一版使用两张表表达通用会话历史：

```text
sessions
  id
  created_at
  updated_at
  metadata_json

messages
  id
  session_id
  seq
  role
  message_json
  created_at
```

关键设计：

- `message_json` 保存完整内部 `Message`。
- `seq` 负责同一 session 内的稳定顺序。
- `role` 是冗余字段，用于基础调试和未来简单查询。
- `metadata_json` 初版保留为空对象，用于后续扩展，不在本分支放入教学语义。

默认数据库路径倾向放在项目内：

```text
.byte-mentor/byte-mentor.sqlite
```

原因：

- 当前是个人学习项目，项目内路径便于调试和清理。
- 后续如果做正式 CLI 用户体验，可以迁移到用户 home 目录。

该路径必须被 git 忽略。

## 8. 配置和错误处理

第一版 CLI 配置来源：

```text
OPENAI_API_KEY
BYTE_MENTOR_MODEL
BYTE_MENTOR_OPENAI_BASE_URL
BYTE_MENTOR_DB_PATH
```

其中：

- `OPENAI_API_KEY` 必填。
- `BYTE_MENTOR_MODEL` 必填，第一版不设置隐式默认模型。
- `BYTE_MENTOR_OPENAI_BASE_URL` 可选。
- `BYTE_MENTOR_DB_PATH` 可选。

错误处理原则：

- 配置缺失应在 CLI 层报清楚，不进入 AgentLoop。
- Provider 调用异常应在 provider 或 runner 层转成受控失败。
- SQLite session 读取不存在的 session 应保持现有 `SessionStore` 语义。
- 不把 API key、完整请求体或数据库绝对路径写入 RuntimeEvent。

## 9. 测试策略

自动化测试覆盖：

- SQLite store 的创建、追加、读取、跨实例恢复和顺序稳定。
- OpenAI provider 的请求映射和响应映射。
- CLI config 解析和错误提示。

自动化测试不覆盖：

- 真实 OpenAI API 网络调用。
- 真实模型质量。
- TUI 展示。

真实 API 只用于手动 smoke：

```text
给定 OPENAI_API_KEY 和 model
运行 byte-mentor chat "解释一下 Promise"
应能看到 assistant 回复
SQLite 中应保存本轮消息
再次使用同一 db / session 时应能恢复历史
```

## 10. 非目标和延后决策

本分支不处理：

- Knowledge / Teaching Brief / Observation Log。
- TUI。
- streaming。
- Responses API。
- 多 provider 注册中心。
- session compact / summary。
- SQLite 复杂迁移框架。
- 真实 API 集成测试。

延后决策：

- 是否从 Chat Completions 迁移到 Responses API。
- 是否把默认数据库路径迁移到用户 home 目录。
- 是否支持会话列表、标题生成和多轮交互 shell。
- 是否在 provider 层支持更多 OpenAI finish reason 和流式事件。

## 11. 验收标准

本分支完成时应满足：

- SQLite-backed `SessionStore` 能通过自动化测试。
- OpenAI Chat provider 能通过 fake client 测试。
- CLI 能使用真实 OpenAI API 跑通一次非 TUI chat。
- 同一个 SQLite 数据库能恢复已有 session history。
- `pnpm test` 通过。
- `pnpm typecheck` 通过。
