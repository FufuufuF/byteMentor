# 树状会话与上下文压缩设计

- 状态：M1～M9 已确认完成；尚未进入实现
- 日期：2026-08-10

> 本文件是总索引，不再承载详细设计。三个模块文档共同构成本功能的正式设计；发生跨模块冲突时，先回到本索引确认依赖和术语，再逐点回改对应模块。

## 1. 背景与目标

Byte Mentor 计划参考 pi，把当前线性 Session 扩展为树状会话，并加入上下文压缩、运行时恢复和核心 TUI 导航能力。

全局方向：

- 保留 SQLite；不兼容或迁移旧线性 Session 数据。
- `/fork` 创建独立 Session，`/tree` 在当前 Session 树中导航。
- `/compact`、turn 间自动压缩和安全点 Turn 内压缩纳入首版。
- model/thinking-level 状态进入 Session 历史并随活动路径恢复。
- 同一 Session 的写操作串行，不同 Session 可以并发执行外部工作。

## 2. 模块文档与实现分支

| 模块 | 正式设计稿 | 实现分支 | 当前状态 |
|---|---|---|---|
| Session Tree & Compaction（M1～M6） | [`session-tree-compaction.md`](../.design/session-tree-compaction.md) | `feat/session-tree-compaction` | 已确认完成 |
| Session Runtime & Scheduling（M7） | [`session-runtime.md`](../.design/session-runtime.md) | `feat/session-runtime` | 已确认完成 |
| CLI/TUI Integration & Delivery（M8～M9） | [`session-tui-integration.md`](../.design/session-tui-integration.md) | `feat/session-tui` | 已确认完成 |

实现依赖：

```text
feat/session-tree-compaction
            ↓
feat/session-runtime
            ↓
feat/session-tui
```

三个分支采用依赖式推进，不假设可以从 `main` 完全并行开发。每个分支必须包含自身范围内的测试；M9 负责最终验收与实施 Batch，而不是把测试推迟到最后统一补写。

## 3. 全局术语

- **Session Entry**：已提交、不可变的树节点。
- **active leaf**：当前 Session 活动分支的末端指针。
- **Runtime Turn**：一次 checkpoint、Session 逻辑 writer 和最终事务的生命周期，可以包含多条 UserEntry。
- **用户交互段**：从一条 UserEntry 开始，到下一条 UserEntry 之前结束；Compaction 按此语义选择 cut point。
- **runtime checkpoint**：尚未正式物化到 Session 树的稳定 pending 链。
- **MessageBus**：外部输入分类、per-session 顺序和跨 Session 调度边界。

## 4. 首版暂缓范围

- Tree 搜索、额外过滤模式、标签和书签。
- 复制节点内容、`/clone` 和来源 Session 谱系。
- 自定义 Branch Summary/Compaction prompt。
- 用户自定义 context window、精确 tokenizer 和多级 map-reduce 摘要。
- 自动切换更大模型、token 图表和成本优化摘要模型。

## 5. 讨论与变更规则

- 每次只 review 一个决策点，用户确认后才写入对应模块正式稿。
- 后续模块可以暴露前序设计问题；发生时必须显式回改，不以“已完成”为由保留矛盾。
- M1～M9 的设计和三个分支的实施 Batch 均已确认。
- 设计完成不授权代码实现；开始任一分支前仍需用户明确要求。

## 6. 当前状态

- M1～M9 已确认完成。
- 三个 stacked implementation branches 的依赖、接口冻结点和 TDD Batch 已经定义。
- 尚未创建实现分支，也未开始代码修改。
