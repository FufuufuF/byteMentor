# Byte Mentor 架构设计进度记录

更新时间：2026-07-02

## 当前状态

Byte Mentor 的 MVP 高层架构设计已经基本完成。

当前主要架构结论已经记录在：

```text
.agent/.design/architecture-design.md
```

记忆 / 知识子系统的详细需求与已确认设计记录在：

```text
.agent/.design/memory-requirements.md
```

产品计划记录在：

```text
.agent/.design/product-plan.md
```

## 已完成的架构设计结论

当前已经完成并写入 `architecture-design.md` 的内容包括：

- 第一阶段产品形态：本地 CLI，并提供 TUI 作为默认交互体验。
- 技术栈：TypeScript / Node.js。
- Node.js 运行时基线：Node.js 22。
- 模块系统：ESM。
- 工程工具链：pnpm workspace、tsc、TypeScript project references、ESLint、Prettier、Vitest。
- 第一阶段不引入 `tsup`。
- 第一阶段采用 workspace package 边界拆分。
- 第一阶段包含 6 个 workspace project：

```text
apps/cli
packages/tui
packages/agent
packages/knowledge
packages/session
packages/core
```

- `@byte-mentor/knowledge` 不命名为 `memory`，因为它不是常规 agent memory，而是知识子系统。
- `Provider` 和 `ToolRegistry` 第一阶段不拆成独立 package，而是作为 `@byte-mentor/agent` 内部模块。
- 已确认 package import 关系图。
- 已确认各 package 职责边界原则。
- 已确认学习会话启动时序图。
- 已确认会话结束写回时序图。
- 已确认当前暂不处理多聊天平台、插件市场、多 agent、复杂权限、远程部署和多租户。

## 当前设计原则

当前架构设计已经收口，不应该继续在总体架构文档里提前塞入详细接口、字段或数据模型。

后续如果需要设计具体数据结构，例如：

- RuntimeEvent
- UserCommand
- SessionMetadata
- MessageHistory
- ObservationLog
- TeachingBrief 的具体字段

应该进入对应模块的详细设计阶段再讨论，不要在总体架构阶段拍脑袋写入。

架构文档当前只保留：

- 模块边界
- import 关系
- 职责边界
- 核心运行流程
- 明确不做的范围

## 接下来的目标

下一步目标是做工程初始化。

工程初始化应该基于已经确认的 6 个 workspace project：

```text
apps/cli
packages/tui
packages/agent
packages/knowledge
packages/session
packages/core
```

初始化时需要注意：

- 不要重新讨论 package 拆分，除非发现当前设计有阻塞问题。
- 不要先实现复杂业务逻辑。
- 先建立 TypeScript / Node.js workspace 骨架。
- Node.js 版本按 Node.js 22 初始化。
- 模块系统按 ESM 初始化，package 应显式使用 `"type": "module"`。
- 先建立 package 边界、基础构建、测试和 lint / format 工具。
- 第一阶段只做最小可运行工程骨架。
- `@byte-mentor/core` 必须保持薄层，不要把业务逻辑放进去。
- `@byte-mentor/tui` 不应该直接依赖 `@byte-mentor/agent` 或 `@byte-mentor/knowledge` 的内部实现。
- `@byte-mentor/knowledge` 不应该依赖 `@byte-mentor/agent` 或 `@byte-mentor/tui`。

## 恢复上下文时的推荐步骤

如果之后清空上下文，需要先阅读以下文档：

1. `.agent/.design/product-plan.md`
2. `.agent/.design/memory-requirements.md`
3. `.agent/.design/architecture-design.md`
4. `.agent/.session/architecture-design-process.md`

然后继续下一步：工程初始化。

## 重要协作约定

用户希望我是在“教他设计架构”，不是直接替他拍板。

后续继续设计时需要遵守：

- 先解释为什么要做某个设计判断。
- 先讲清楚方案含义和代价。
- 不要在用户确认前写入设计结论文档。
- 文档中只记录已经达成共识的结论。
- 不要写“建议采用”这类未确认语气。
- 不要把还没有详细设计的数据结构提前写入总体架构文档。
