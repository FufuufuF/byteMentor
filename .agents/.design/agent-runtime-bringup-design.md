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
- 第一版优先跑通真实闭环，不引入 TUI 或完整命令框架。
- 引入流式响应以改善 CLI 用户体验；流式只影响 provider 输出面和 CLI 消费面，中间层不感知。
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

#### 接口提取

当前 `SessionStore` 和 `Session` 类型定义在 `in-memory-session-store.ts` 内部。本分支需要将它们提取到独立的 `session-store.ts` 文件，让接口和实现解耦，使 `SqliteSessionStore` 和 `InMemorySessionStore` 都从同一文件导入接口。

#### `close()` 方法

SQLite 实现需要关闭数据库连接。为保持多态契约一致，`SessionStore` 接口需要新增 `close(): Promise<void>` 方法。

契约细节：

- `SqliteSessionStore.close()`：关闭 `better-sqlite3` db 句柄。**幂等**（连续调用第二次是 no-op）。close 后所有其它方法（`createSession` / `getSession` / `appendMessages` / `getHistory`）抛 `SessionStoreClosedError`。
- `InMemorySessionStore.close()`：no-op。为方便测试，close 后其它方法仍可用（内存数据未释放）。这是主动放宽，不追求与 SQLite 完全一致。
- 调用方职责：CLI 层使用 `try / finally` 保证异常路径也会调用 close。
- `ModelProvider` 不需要 close——OpenAI SDK 请求是每次独立 fetch，没有需要清理的长连接。

#### 新增 SQLite session 实现

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

#### Chat Completions 映射约定

**请求方向（内部 → OpenAI）**：

- `Message[]` → OpenAI `messages`：`user` / `assistant` / `tool` / `system` role 直接对应。
- `AssistantMessage.toolCalls[i].args`（对象）→ OpenAI `tool_calls[i].function.arguments`（字符串），通过 `JSON.stringify` 转换。
- `ToolDefinition` → OpenAI `tools` 元素：包装为 `{ type: "function", function: {...} }`。`parametersJsonSchema` 为 `undefined` 时省略 `parameters` 字段。
- `tools` 为空数组时请求中省略 `tools` 字段，避免 API warning。

**响应方向（OpenAI → 内部）**：

- `choices[0].message.content` → `AssistantMessage.content`。为 `null` 或空字符串时：若含 `tool_calls` 则省略该字段；若无 `tool_calls` 视为受控失败。
- `choices[0].message.tool_calls[]` → `AssistantMessage.toolCalls[]`：无条件转换全部，不筛选，将"一轮多个 tool_calls 如何处理"的决策权交给 `AgentRunner`。
- `tool_calls[i].function.arguments`（字符串）→ `ToolCall.args`（对象），通过 `JSON.parse` 转换。
- `finish_reason` → `StopReason` 映射：

  | OpenAI `finish_reason` | 内部 `StopReason` |
  | --- | --- |
  | `stop` | `completed` |
  | `tool_calls` | `tool_calls` |
  | `function_call`（老式命名，兜底） | `tool_calls` |
  | `length` | `failed` |
  | `content_filter` | `failed` |
  | 其它未知值 | `failed` |

**`arguments` 解析失败的处理**：

模型偶尔会返回格式非法的 tool call `arguments`。Provider 处理策略是**不抛错、不静默丢弃**，而是把错误信息通过 `ToolCall` 传给 `AgentRunner`，让 runner 合成 tool result 让模型自我修正。

为此在 `packages/core/src/messages.ts` 的 `ToolCall` 上新增可选字段：

```ts
export interface ToolCall {
  id: ToolCallId;
  name: string;
  args: unknown;
  argsParseError?: string;   // present 表示 provider 解析 arguments 失败，args 为原始字符串
}
```

Provider 在 `JSON.parse` 失败时：

- 保留原始 `arguments` 字符串到 `args`。
- 把解析错误信息填入 `argsParseError`。
- 其它字段（`id`、`name`）正常填充。

`AgentRunner` 收到带 `argsParseError` 的 `ToolCall` 时：

- 不调用 `ToolRegistry.execute()`。
- 直接合成一条 `ToolMessage`，`content` 描述参数解析失败、包含原始 raw arguments，并提示模型按 schema 重试。
- 将 assistant message 与这条合成 tool message 一并写回 session。
- 继续下一轮循环。

这样模型能在下一轮看到"我的调用参数错了"，自动重试正确格式。用户无感，只是本次 turn 多消耗一次 API 调用。

**错误处理**：

- 网络异常、API 错误、SDK 异常等一律 `throw`，不在 provider 层重试或降级。
- 由 `AgentRunner` 捕获后转为 `stopReason: "failed"`。
- 未来若需要重试策略，用装饰器模式包一层 `RetryingProvider`，不修改本 provider。

**OpenAI SDK 类型隔离**：

- `openai` 包类型只在 `openai-chat-provider.ts` 内部使用。
- 该模块只 `export` `OpenAIChatProvider` 类和它的 config 类型，不 `export` 任何 OpenAI SDK 类型别名或转发。

#### 流式支持

本分支支持流式响应，以改善 CLI 交互体验（用户输入命令后不必等待完整响应才看到第一行输出）。

**架构原则**：

- "流式"只影响 provider 输出面和 CLI 消费面。`AgentRunner`、`AgentLoop`、`session` 等中间层不感知流式细节。
- Content 的流式性通过增量事件传递到 CLI 层实时打印。
- Tool call 对下游而言仍是"非流式"——provider 内部累加所有 tool_call chunk，直到流结束（`finish_reason` 出现）才把完整、已 parse 的 `ToolCall[]` 交给上层。

**`ModelProvider` 接口扩展**：

在现有 `invoke` 之外新增 `invokeStream` 方法：

```ts
export interface ModelProvider {
  invoke(req: ProviderRequest): Promise<ProviderResponse>;
  invokeStream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

export type ProviderStreamEvent =
  | { type: "content_delta"; text: string }
  | { type: "done"; message: AssistantMessage; stopReason: StopReason };
```

- `content_delta`：assistant text 增量，边到边推送。
- `done`：流结束事件，携带完整 `AssistantMessage`（含累加拼接完成、已 `JSON.parse` 的 `toolCalls`）和 `stopReason`。

保留 `invoke` 用于不需要流式的场景（测试、fake provider、未来的批处理）。实现上 `invoke` 内部调用 `invokeStream` 并折叠事件成完整响应，避免代码重复。

**Provider 内部流累加规则**：

- 用 `Map<number, {...}>` 以 `tool_calls[i].index` 为键累加。
- 首次 chunk 保存 `id`、`function.name`、`function.arguments` 初值。
- 后续 chunk 只累加 `function.arguments` 字符串。
- 流结束时（`finish_reason` 出现）对每个累加完的 `argumentsRaw` 一次性 `JSON.parse`。
- Parse 失败走 §5.2 定义的 `argsParseError` 路径，不抛错。

**`AgentLoop` 事件出口**：

`runTurn` 接受可选 callback：

```ts
runTurn(input, options?: { onStreamEvent?: (event: ProviderStreamEvent) => void }): Promise<HeadlessTurnResult>
```

`AgentRunner` 内部消费 `invokeStream`，将 `content_delta` 事件透传给 `onStreamEvent`。

**多轮 tool_call 循环下的流式策略**（第一版）：

只对"最终完成轮次"（无 tool_calls 的那一轮）的 `content_delta` 透传给 `onStreamEvent`。中间轮次的 assistant content 仍然完整保存到 session，但不实时打印。

原因：第一版 CLI 无 TUI，输出协议简单，避免在同一屏交错打印"assistant 中间思考 + tool 执行提示 + 最终答案"。未来加 TUI 时放宽此筛选。

**RuntimeEvent 与 StreamEvent 的区分**：

- `RuntimeEvent`（现有）：关注"发生了什么"的**离散**事件（turn 开始、model 调用、tool 执行、turn 完成），用于日志、指标、审计。
- `ProviderStreamEvent`（新增）：关注"content 增量"的**连续**流事件，仅用于 UI 层实时渲染。
- 两者不合并，避免 RuntimeEvent 被高频 content chunk 淹没。

### 5.3 `@byte-mentor/cli`

新增最小非 TUI 运行入口。

它负责：

- 从命令行和环境变量读取配置。
- 组装本地运行时依赖。
- 执行一次真实 `AgentLoop.runTurn`。
- 消费 `onStreamEvent` 事件，将 `content_delta` 实时写入 stdout。
- 输出用户可见结果或配置错误。
- 确保异常路径下 store 也会正确 close。

它不负责：

- 直接调用 OpenAI SDK。
- 直接读写 SQLite 表。
- 实现 agent loop。
- 渲染 TUI。

#### 命令解析

使用 Node.js 18+ 内置的 `node:util` 中的 `parseArgs`，不引入 `commander` / `yargs` 等第三方命令框架。

第一版命令形态：

```bash
byte-mentor chat "<用户消息>"
```

- 位置参数 1：subcommand，第一版只有 `chat`。
- 位置参数 2：用户消息。
- 缺少用户消息 → 打印命令用法错误，退出码非 0。

**本分支不实现 `--session <id>` 选项**。`SqliteSessionStore` 已具备恢复历史的能力（Commit 1 会验证），但 CLI 层的 session 选择 UX（列出、错误提示、默认行为）留到未来能力做。

#### 默认数据库路径

DB 路径解析规则：

- 若环境变量 `BYTE_MENTOR_DB_PATH` 设置，使用其值（可以是绝对路径或相对路径，相对路径相对 `process.cwd()`）。
- 否则默认 `path.resolve(process.cwd(), '.byte-mentor/byte-mentor.sqlite')`。
- CLI 启动时若目标目录不存在，用 `fs.mkdirSync(dir, { recursive: true })` 创建。

**从子目录调用 CLI 的行为**：会在当前目录下生成 `.byte-mentor/`，这是可解释一致行为，不是 bug。README 明确建议在 repo 根运行。

**路径显示约束**：绝对路径不出现在任何用户可见输出、`RuntimeEvent`、日志中。错误消息只显示相对路径或环境变量名。这与 §8 "不把数据库绝对路径写入 RuntimeEvent" 一致。

### 5.4 `@byte-mentor/core`

本分支需要一处小扩展：`ToolCall` 新增可选字段 `argsParseError?: string`，用于表达 provider 解析 `arguments` 失败的情况（详见 §5.2 Chat Completions 映射约定）。

除此之外不修改 `core`。

后续如果 Chat Completions 需要表达的信息仍无法用现有 `Message` / `ToolCall` / `StopReason` 表达，可以按同样方式最小扩展。

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

SQLite 第一版使用两张表表达通用会话历史。

### 表结构

`sessions`：

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT NOT NULL PRIMARY KEY,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

`messages`：

```sql
CREATE TABLE IF NOT EXISTS messages (
  session_id   TEXT    NOT NULL,
  seq          INTEGER NOT NULL,
  role         TEXT    NOT NULL,
  message_json TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) WITHOUT ROWID;
```

### 字段和约束说明

`sessions`：

- `id`：应用层生成的 UUID 字符串（`crypto.randomUUID()`），使测试可预测且未来跨设备无冲突。
- `created_at` / `updated_at`：ISO 8601 UTC 字符串（例如 `"2026-07-13T10:30:00.000Z"`）。字典序即时间序，肉眼可读，便于用 `sqlite3` CLI 调试。
- `metadata_json`：JSON 字符串，默认 `'{}'`。作为暂存箱，不承载教学语义。未来当某字段需要按值查询或建索引时，按 [Schema 迁移](#schema-迁移) 拆成独立列。

`messages`：

- `session_id`：外键，指向 `sessions.id`。声明 `ON DELETE CASCADE`：session 被删除时其 messages 一并删除。
- `seq`：同一 session 内从 1 开始的顺序号。跨 session 独立计数。
- `role`：冗余字段（`'system' | 'user' | 'assistant' | 'tool'`），只写不改。方便调试查询和粗聚合，读取语义仍以 `message_json` 为准。
- `message_json`：完整内部 `Message` 的 JSON 字符串。
- `created_at`：与 `sessions` 同格式。
- 复合主键 `(session_id, seq)`：同时充当唯一约束和 `(session_id, seq)` 复合索引，完美匹配"按 session 读历史"和"取 max seq"两个查询模式，因此不额外建索引。
- `WITHOUT ROWID`：使用自定义复合主键，省去 SQLite 隐藏 rowid 列。

### 运行时约定

以下不体现在 DDL，但和表结构同等重要：

- **每次打开数据库连接必须执行 `PRAGMA foreign_keys = ON`**。SQLite 外键默认关闭，遗漏这一句会使 `FOREIGN KEY` 声明形同虚设。
- **追加 message 用单条 SQL** 完成"读 MAX + 写入"，避免在 `SELECT MAX` 与 `INSERT` 之间产生并发窗口：

  ```sql
  INSERT INTO messages (session_id, seq, role, message_json, created_at)
  SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?
  FROM messages WHERE session_id = ?
  ```

- **`appendMessage` 内的 `INSERT` 和 `UPDATE sessions SET updated_at` 用显式事务包起来**，保证两条语句原子。使用 `better-sqlite3` 的 `db.transaction(fn)` 语法糖。
- **`role` 列在 `INSERT` 时从 `message.role` 读一次写入，之后永不更新**。后续所有读取以 `message_json` 反序列化结果为准。
- **session id 由应用层 `crypto.randomUUID()` 生成**，不使用数据库自增主键，便于测试与未来分布式扩展。

### 并发和一致性保证

当前使用 `better-sqlite3` 同步 API + Node.js 单线程 + 单进程 CLI 组合，`appendMessage` 函数内部不含 `await`，天然原子。上述"单条 SQL + 复合主键 UNIQUE 兜底"是**为未来场景准备的契约**：

- 若未来切换至异步 driver 或多个后台异步任务共写 store（如 TUI 边输入边生成 title / summary），`await` 会引入让出窗口。
- 若未来支持多进程使用同一 db，Node 单线程保护无效。
- 单条 `INSERT ... SELECT MAX+1` 让读写在同一事务内完成，复合主键在数据库层做最后兜底，即便应用层出错也不会产生脏数据。

### Schema 迁移

本分支的 schema 通过 `CREATE TABLE IF NOT EXISTS` 在 store 初始化时建表，只覆盖初始建表，不支持升级。

后续当需要修改 schema（例如把 `metadata_json` 中的字段拆成独立列）时，需要补充一个极简的迁移机制：

- 新增一张 `schema_migrations` 表，记录已执行的迁移编号。
- 在 `packages/session/src/migrations/` 下按编号维护 `.sql` 文件（`001-init.sql`、`002-xxx.sql`）。
- store 初始化时依次跑未执行过的迁移，用事务保证原子性。

不引入现成迁移库（`umzug` / `knex` / `drizzle-kit`）。本项目 schema 简单，手写 runner 足够。

具体实现推到真正需要改 schema 的分支再做，不在本分支落地。

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
- Responses API。
- 多 provider 注册中心。
- session compact / summary。
- SQLite 复杂迁移框架。
- 真实 API 集成测试。
- 多轮 tool_call 循环中中间轮次的 content 实时打印（只流式打印最终完成轮次；中间轮次仍完整保存到 session）。

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
