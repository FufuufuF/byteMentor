# Agent Base 实现计划

## 1. 目标

按 `.agents/.design/agent-base-design.md` 实现 Headless Agent Base。

本分支完成后，应能通过 TypeScript API 跑通一次通用 headless agent turn：

```text
用户消息
  -> session
  -> context
  -> provider/tool loop
  -> 保存本轮完整 messages
  -> 返回 result/events
```

## 2. 实现原则

- 每个提交保持 50-200 行左右的可审阅增量。
- 每个提交必须有对应测试。
- 测试放在根目录 `test/`。
- 测试尽量通过 package public API 导入。
- 不引入 `@byte-mentor/knowledge`。
- 不做 CLI/TUI/真实 provider/文件持久化。
- Plan 不重复 design；架构边界以 design 文档为准。

## 3. 提交拆分

### Commit 1: Core runtime contracts

范围：

- `packages/core/src/**`
- `test/core/**`

目标：

- 建立通用 message、tool call metadata、RuntimeEvent、stop reason 等共享契约。

测试：

- message 能表达 assistant tool calls 和 tool result。
- RuntimeEvent 能表达 turn/model/tool 的关键事件。

Review 重点：

- `core` 是否保持薄层。
- 是否出现 provider、tool registry、session、教学概念。

### Commit 2: In-memory session store

范围：

- `packages/session/src/**`
- `test/session/**`

目标：

- 实现最小 `SessionStore` 和 `InMemorySessionStore`。
- 支持创建、读取、追加 messages、读取 history。

测试：

- 创建 session。
- 复用已有 session。
- 追加多条 messages 保持顺序。

Review 重点：

- session 是否只是通用消息历史。
- 是否没有持久化、标题、压缩、教学状态。

### Commit 3: Provider and tool registry

范围：

- `packages/agent/src/provider.ts`
- `packages/agent/src/tool-registry.ts`
- `packages/agent/src/index.ts`
- `test/agent/tool-registry.test.ts`

目标：

- 定义 provider/tool 边界。
- 实现工具注册、排序、执行和受控失败。

测试：

- 工具定义稳定排序。
- 已知工具执行成功。
- 未知工具和非法参数返回失败。

Review 重点：

- 是否没有真实 provider。
- 是否没有 provider-specific 格式。
- ToolRegistry 是否足够小。

### Commit 4: AgentRunner

范围：

- `packages/agent/src/agent-runner.ts`
- `packages/agent/src/index.ts`
- `test/agent/agent-runner.test.ts`

目标：

- 实现 provider/tool loop。
- 支持无工具、单工具调用、max iterations。
- 返回完整 messages。

测试：

- 无工具直接完成。
- 工具调用结果进入下一次 provider 请求。
- result messages 包含 assistant tool call、tool result、final assistant。
- max iterations 受控停止。

Review 重点：

- Runner 是否仍然无产品语义。
- 是否没有 session/context/CLI/TUI/teaching 依赖。

### Commit 5: ContextBuilder and AgentLoop

范围：

- `packages/agent/src/context-builder.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/index.ts`
- `test/agent/agent-loop.test.ts`

目标：

- 串起 session、context builder、runner。
- 支持新 session 和已有 session。
- 保存本轮完整新增 messages。
- 返回 `HeadlessTurnResult` 和 RuntimeEvent。

测试：

- 新 session 跑通 turn。
- 已有 session 会带入历史。
- 工具调用场景下 session 保存完整 messages。
- events 包含 turn/context/model/tool 关键事件。

Review 重点：

- AgentLoop 是否仍然是通用 headless turn。
- 是否没有 knowledge/Teaching Brief/Observation。
- 是否没有丢弃 tool trace。

### Commit 6: Public API and final integration

范围：

- `packages/*/src/index.ts`
- `test/agent/headless-turn.integration.test.ts`

目标：

- 整理 public exports。
- 用 public API 跑最终集成验收。

测试：

- 从 `@byte-mentor/core`、`@byte-mentor/session`、`@byte-mentor/agent` 导入。
- fake provider + fake tool + in-memory session 跑完整 turn。
- 验证 final response、session messages、event sequence。

Review 重点：

- public API 是否足够后续模块使用。
- 是否暴露了太多内部 helper。

## 4. 分支完成定义

- 可以通过 TypeScript API 跑通一次通用 Headless agent turn。
- 支持一次工具调用闭环。
- Session 保存本轮完整 messages。
- RuntimeEvent 能观察 turn、model、tool 的关键过程。
- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- 不包含 CLI/TUI/Knowledge/真实 Provider/真实持久化。
