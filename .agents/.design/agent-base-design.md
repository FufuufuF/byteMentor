# Agent Base 模块设计

## 1. 文档定位

本文档定义 `feat/agent-base` 分支要交付的 Agent 基座功能模块。

它不是执行计划。执行计划应单独放在 `.agents/.plan/` 下，并且只说明如何按本文档分步骤实现。

本文档也不是项目级架构总览。项目级结论仍以 `.agents/.design/architecture-design.md` 为准。

## 2. 设计结论

`feat/agent-base` 应交付一个 Headless Agent Base。

这里的 Headless 指：没有 CLI 命令、没有 TUI 渲染、没有真实模型供应商，但可以通过 TypeScript API 跑通一次完整的通用 agent turn。

一次完整 turn 的最小闭环是：

```text
用户输入消息
  -> 创建或恢复一个会话上下文
  -> 构建模型输入消息
  -> 调用模型 Provider
  -> 必要时执行 ToolRegistry 中的工具
  -> 将工具结果回填给模型
  -> 得到最终 assistant 回复
  -> 保存本轮消息
  -> 返回本轮结果和 RuntimeEvent 序列
```

这个闭环使用 fake provider、fake tool 和 in-memory session 即可验证，不要求接入真实 LLM、真实知识图谱、教学模块或真实持久化。

## 3. 为什么不是更小的 Runner 分支

只实现 `AgentRunner + ToolRegistry + Provider` 虽然边界干净，但作为一个功能分支过薄。

它只能证明底层模型/工具循环存在，无法证明 Byte Mentor 的 agent 基座能承载一次完整 headless turn，也无法验证 Session、ContextBuilder 和 RuntimeEvent 之间的协作方式。

因此本分支应比“最小 runner”更完整：它要交付一个可测试的 Headless turn runtime。

## 4. 为什么不加入 CLI 或 TUI

CLI 和 TUI 会让分支变成用户交互功能分支，容易把运行时边界、终端渲染、命令解析和调试入口混在一起。

`feat/agent-base` 的目标是先稳定 agent 核心运行时。CLI/TUI 后续只应该消费这个运行时和 RuntimeEvent，而不是反过来塑造 agent 核心。

因此本分支不加入命令行入口、不渲染终端 UI、不启动交互应用。

## 5. 模块边界

本分支允许触及三个 workspace package：

- `@byte-mentor/core`
- `@byte-mentor/agent`
- `@byte-mentor/session`

不触及：

- `@byte-mentor/cli`
- `@byte-mentor/tui`
- `@byte-mentor/knowledge`

原因是 Headless turn 需要通用会话能力，但不需要用户界面，也不应该直接依赖教学知识模块。

## 6. 与教学模块的解耦关系

Agent Base 是通用运行时，不拥有教学能力。

教学模块后续可以作为 Agent Base 的调用方：

```text
Teaching Module
  -> 生成 Teaching Brief / 学习状态 / 观察记录策略
  -> 将教学上下文转换为普通 system/user messages
  -> 注册教学相关 tools
  -> 调用 Agent Base

Agent Base
  -> 只处理 messages / session / provider / tools / runtime events
```

因此 Agent Base 不知道：

- Teaching Brief。
- KnowledgeGraph。
- UserKnowledgeStatus。
- Observation Log。
- 学习目标的语义。
- 教学策略。

这些概念如果需要影响模型行为，应由教学模块在调用 Agent Base 前转换为普通消息或工具。

## 7. 包职责

### 7.1 `@byte-mentor/core`

`core` 负责跨包共享的薄契约。

本分支中它应包含：

- 消息角色和消息结构。
- 通用 ID 类型。
- RuntimeEvent 判别联合类型。
- 通用运行结果状态，例如 completed、failed、max_iterations。

它不包含：

- Provider 接口。
- ToolRegistry 实现。
- 教学业务规则。
- KnowledgeGraph 或 Teaching Brief 内部结构。
- Session 存储规则。

### 7.2 `@byte-mentor/session`

`session` 负责会话上下文的最小生命周期。

本分支中它应包含：

- 会话记录结构。
- 会话存储接口。
- in-memory 会话存储实现。
- 追加和读取消息历史的能力。

它不包含：

- 文件持久化。
- 会话列表 UI。
- 历史压缩。
- 多设备同步。

### 7.3 `@byte-mentor/agent`

`agent` 负责通用 Headless turn 的编排和模型/工具循环。

本分支中它应包含：

- AgentLoop：一次 headless turn 的编排。
- ContextBuilder：把会话历史和本轮输入转成模型输入消息。
- AgentRunner：底层 provider/tool calling 循环。
- ModelProvider 接口。
- ToolRegistry 和 AgentTool 接口。
- Headless turn 的输入、输出和运行结果类型。

它不包含：

- CLI 命令解析。
- TUI 渲染。
- 真实模型供应商适配。
- 流式输出。
- 重试策略。
- 上下文压缩。
- 长期记忆写回策略。

## 8. 运行时组件关系

```text
AgentLoop
  -> SessionStore
  -> ContextBuilder
  -> AgentRunner

AgentRunner
  -> ModelProvider
  -> ToolRegistry

ToolRegistry
  -> AgentTool[]

AgentLoop / AgentRunner
  -> RuntimeEvent
```

`AgentLoop` 是 Headless turn 的入口。它只知道这是一次通用 agent turn。

`AgentRunner` 是模型和工具循环。它不应该知道教学目标、Teaching Brief、用户知识状态或 Session 持久化。

`ContextBuilder` 是 AgentLoop 和 AgentRunner 之间的翻译层。它把会话历史和本轮输入转成普通模型消息。

`SessionStore` 是 AgentLoop 的依赖。第一阶段可以使用内存实现，后续再替换成真实实现。

## 9. 一次 Headless Turn 的数据流

```text
HeadlessTurnInput
  sessionId?
  userMessage

AgentLoop.runTurn(input)
  1. 发出 turn.started
  2. 从 SessionStore 创建或读取 Session
  3. 使用 ContextBuilder 构建 messages
  4. 调用 AgentRunner.run(messages, tools, provider)
  5. 接收 runner 返回的 finalMessage、messages、toolsUsed
  6. 将本轮用户消息和 assistant 消息写入 SessionStore
  7. 发出 turn.completed 或 turn.failed
  8. 返回 HeadlessTurnResult
```

## 10. RuntimeEvent 设计边界

RuntimeEvent 的第一阶段目标是让测试和未来 UI 能观察运行过程。

事件应表达稳定事实，而不是 UI 展示细节。

第一阶段需要的事件：

- `turn.started`
- `turn.completed`
- `turn.failed`
- `context.built`
- `model.requested`
- `model.responded`
- `tool.started`
- `tool.completed`
- `tool.failed`

事件载荷应保持小而可序列化，例如：

- turnId
- sessionId
- messageId
- toolCallId
- toolName
- stopReason
- error message

RuntimeEvent 不应包含终端颜色、卡片状态、折叠状态或 TUI 布局信息。

## 11. Tool 设计边界

本分支只需要最小工具能力：

- 注册工具。
- 列出工具定义。
- 按名称执行工具。
- 对未知工具返回受控错误。
- 将工具结果作为 tool message 交还给模型。

工具参数使用 JSON-like object 表示。

本分支不引入复杂 schema 校验库。工具可以携带 `parametersJsonSchema`，但运行时只做最小必要校验，例如参数必须是对象。

## 12. Provider 设计边界

本分支只定义 Provider 接口，不实现真实供应商。

Provider 需要支持：

- 接收消息列表。
- 接收工具定义。
- 返回 assistant 内容。
- 返回工具调用请求。
- 返回停止原因。

Provider 不需要支持：

- streaming。
- retry。
- reasoning tokens。
- provider-specific fields。
- OpenAI / Anthropic 格式细节。
- 速率限制处理。

测试中使用 fake provider 模拟：

- 直接返回最终回答。
- 先请求工具，再返回最终回答。
- 返回错误。

## 13. Session 的最小实现

为了让 `feat/agent-base` 成为完整功能点，本分支需要提供最小 session 内存实现，而不只是接口。

Session 的最小实现：

- 创建 session。
- 按 sessionId 读取 session。
- 追加消息。
- 返回消息历史。

这个实现不是最终产品能力，只用于验证 AgentLoop 的依赖边界和数据流。

## 14. 测试策略

本分支测试重点是运行时行为，而不是 UI 或真实模型效果。

应覆盖：

- `core` 中 RuntimeEvent 和消息结构的类型行为。
- `session` 中 in-memory session 的创建、读取和追加消息。
- `agent` 中 ToolRegistry 的注册、排序、执行和未知工具错误。
- `agent` 中 AgentRunner 的无工具响应、单工具调用、最大迭代停止和错误返回。
- `agent` 中 AgentLoop 的完整 Headless turn 集成测试。

最重要的验收测试应证明：

```text
给定 fake provider、fake tool、in-memory session
当运行一次 Headless turn
则最终返回 assistant 回复
并保存本轮消息
并产出可预测的 RuntimeEvent 序列
```

## 15. 本分支完成定义

`feat/agent-base` 完成时，应满足：

- 可以通过 TypeScript API 跑通一次 Headless agent turn。
- 该 turn 可以覆盖一次工具调用闭环。
- 有 in-memory session 支撑完整数据流。
- 有单元测试和轻量集成测试覆盖关键行为。
- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- 没有 CLI/TUI/真实 provider/真实持久化/真实知识图谱代码。

## 16. 后续演进

后续分支可以在不重写 Agent Base 的前提下继续扩展：

- `feat/cli-agent-smoke`：给 Headless Agent Base 加一个 CLI smoke 入口。
- `feat/tui-runtime-events`：让 TUI 渲染 RuntimeEvent。
- `feat/session-store`：把 in-memory session 替换或扩展为本地文件持久化。
- `feat/knowledge-brief`：接入真实 Teaching Brief 生成逻辑。
- `feat/provider-openai-compatible`：实现第一个真实模型 Provider。
- `feat/agent-streaming`：为 Provider 和 RuntimeEvent 加入流式输出。
