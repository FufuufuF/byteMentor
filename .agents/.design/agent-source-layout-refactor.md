# Agent 源码目录分层重构

## 背景

`packages/agent/src` 当前采用平铺结构。随着 Agent Loop、Runner、Context、Provider、Checkpoint 和 Tool 等能力持续增长，文件已经开始呈现多个独立的变化方向；继续在 `src` 下平铺新增文件，会降低职责辨识度和代码导航效率。

接下来优先开发的是通用运行时 Tool。Byte Mentor 教学类工具未来可能通过 MCP 提供，但该方向尚未确定，不纳入本次重构范围。

## 决定

采用“按内部能力分层”的方案重构 `@byte-mentor/agent`，暂不拆分新的 workspace package。

目标目录结构：

```text
packages/agent/src/
├── loop/
│   ├── agent-loop.ts
│   ├── turn-state.ts
│   └── runtime-checkpoint.ts
├── runner/
│   └── agent-runner.ts
├── context/
│   └── context-builder.ts
├── providers/
│   ├── provider.ts
│   └── openai-chat-provider.ts
├── tools/
│   └── tool-registry.ts
└── index.ts
```

具体边界：

- `loop/` 负责一次 turn 的编排、状态流转和恢复。
- `runner/` 负责模型与工具之间的运行循环。
- `context/` 负责构建模型输入上下文。
- `providers/` 负责模型供应商契约和具体适配器。
- `tools/` 当前放置 Tool 注册与执行机制；Tool 契约暂时保留在现有 `provider.ts` 中，后续开发具体 Tool 时再重新评估归属。
- 根 `index.ts` 继续作为 `@byte-mentor/agent` 的公共导出入口。

本次只按实际增长情况重构 `agent`，不要求其他 package 为了形式统一而同步增加目录层级。

第一步严格限定为目录迁移：移动现有文件并修正 import/export，不拆分 `agent-loop.ts`，不新增子目录 `index.ts`，也不调整现有类型和运行逻辑。Tool contracts 和内置 Tool 的进一步分层，等具体 Tool 开发时再根据实际代码决定。

## 考虑过的替代方案

### 每个 Tool 独立一个目录

能够容纳复杂 Tool 的 schema、实现和辅助代码，但对第一批通用 Tool 而言层级偏重。等单个 Tool 的复杂度确实增长后，再局部采用该结构。

### 新建 `@byte-mentor/tools` workspace package

可以形成更强的包级隔离，但目前 Tool 体系只服务于 Agent Runtime，提前拆包会增加依赖和公共 API 管理成本。等 Tool 需要被多个 runtime 或应用独立复用时再评估。

## 暂不包含

- Byte Mentor 教学类 Tool 的具体设计。
- MCP Tool 的接入方式和生命周期。
- Tool 权限、安全策略与沙箱设计。
- 其他 workspace package 的目录重构。
- Agent 现有运行行为或公共 API 的功能性调整。
- `agent-loop.ts` 内部 helper、常量和状态处理函数的拆分。
- Provider 与 Tool contracts 的拆分。
- 子目录 Barrel Export。

## 实施说明

- 本次重构只移动现有文件并重新导出，保持现有外部 import 和运行行为兼容。
- 不创建没有实际文件的空目录；`tools/builtins/` 等到第一个内置 Tool 落地时再创建。
- 每一步都应由现有 Agent、Provider、ToolRegistry 和集成测试验证。
- 第一批内置 Tool 的范围、文件粒度和具体命名留待后续讨论后确定。
