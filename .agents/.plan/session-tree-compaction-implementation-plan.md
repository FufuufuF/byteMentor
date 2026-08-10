# Session Tree 与 Compaction 实现计划

- 状态：待实现
- 实现分支：`feat/session-tree-compaction`
- 对应设计：[`../.design/session-tree-compaction.md`](../.design/session-tree-compaction.md)
- 下游计划：[`session-runtime-implementation-plan.md`](./session-runtime-implementation-plan.md)

## 1. 目标与交付边界

本分支实现 M1～M6 的领域与持久化能力，为后续 Runtime 提供稳定的 Session Tree、Context、Navigation、Summary 和 Compaction 契约。

完成后应具备：

- 七种不可变 Session Entry、树结构校验与新的 SQLite schema；
- active leaf、活动路径、model/thinking-level 回放与 provider-neutral 上下文重建；
- Tree direct navigation、Fork 和 Branch Summary 的完整领域行为；
- token 预算、cut point、增量摘要与手动/自动 Compaction 能力；
- InMemory/SQLite Store 的共同契约、原子事务和稳定错误分类。

本分支不接入 MessageBus、Runtime Turn、checkpoint 状态机或 TUI。Turn 内 Compaction 只提供可由 Runtime 消费的纯能力和 pending Entry 结果，实际 safe point/checkpoint 接线在下一分支完成。

## 2. Batch 执行方式

- 下列一个 Batch 是一次开发、验证和 review 的最小单位，也是一个建议 commit 边界。
- 每个 Batch 内连续完成 TDD：先建立能证明目标行为的失败测试，再实现生产代码，直到该 Batch 全部 GREEN；RED/GREEN 不拆成单独提交，也不要求中途 review。
- 测试与使其通过的生产代码必须在同一个 Batch 中。公共契约变更与必须同步迁移的调用方也放在同一 Batch，保证仓库可构建。
- 每个 Batch 结束至少运行相关测试、`pnpm typecheck`、`pnpm lint` 和 `pnpm format:check`；分支收口时再运行 `pnpm test` 与 `pnpm build`。
- Batch 是建议提交边界；没有用户明确授权时不执行 `git commit`。
- 如果实现暴露设计未覆盖、且会改变公共契约或事务语义的问题，暂停回到设计；普通文件组织和私有命名由实现者自行决定。

## 3. Batch 1：Entry Tree 与 Store 基础整体替换

建议 commit：`feat(session): introduce tree entries and transactional store`

### 范围

- `packages/core/src/**`：稳定 ID、provider-neutral 共用值对象的必要调整。
- `packages/session/src/**`：Session/Entry 领域类型、树校验、Store 契约、InMemory 与 SQLite 实现。
- `test/core/**`、`test/session/**`。
- 仅为保持现有 AgentLoop 可编译而需要的兼容调用点。

### 目标

- 建立设计 M2 的 SessionEntry union、共同不变量、序列化边界和 Session 初始状态。
- 用 `sessions + session_entries` 最终 schema 替换 legacy 线性存储；不实现旧数据库迁移。
- 为两种 Store 实现同一套 Session 创建、全量树加载、checkpoint JSON 更新、Turn 批量提交、导航、Summary/Compaction 提交、Fork 和恢复提交原子操作。
- 落实复合外键、`next_entry_seq`、短 `BEGIN IMMEDIATE` 事务、WAL/FULL/busy timeout 和回滚语义。
- 将 SQLite 错误归一化为 M9 定义的稳定类别；领域层不解析原始错误字符串。
- 暂时保留标记为 deprecated 的线性 `appendMessages/getHistory` 适配入口，使尚未迁移的旧 AgentLoop 保持 GREEN；该入口不得成为新能力的实现基础。

### 测试

- Entry discriminator、payload、parent/sequence、tool-call/result 和内部引用校验。
- InMemory/SQLite 共用 Store contract，覆盖创建、加载、sequence、active leaf、metadata/checkpoint 和 close。
- SQLite schema 约束、事务回滚、外键、JSON 局部更新、WAL 配置、close/reopen 和稳定错误分类。
- Turn、导航、Summary、Compaction、Fork、恢复提交均验证“全部成功或全部回滚”，不留下部分 Entry 或错误 leaf。
- 旧 AgentLoop 的已有回归测试继续通过。

### Review 重点

- Session Entry 与 SQLite row/payload 的边界是否清晰，是否没有引入七张子表或多余物化表。
- Store 是否只提供领域原子能力，没有包含 provider、Runtime 或 UI 决策。
- 同一事务内 Entry、leaf、sequence 与 checkpoint 是否保持一致。
- deprecated 入口是否只是短期兼容层，且新测试没有依赖它。

## 4. Batch 2：活动上下文、直接导航与 Fork

建议 commit：`feat(session): rebuild active context and navigate session trees`

### 范围

- `packages/session/src/**`：Tree、活动路径、状态回放、Context、Navigation 与 Fork 服务。
- `packages/agent/src/context/**`：迁移现有 ContextBuilder 消费新公共契约所需的最小适配。
- `test/session/**`、`test/agent/context-builder.test.ts` 及相关集成测试。

### 目标

- 从 active leaf 严格重建单条活动路径，检测缺失节点、循环、逆序 parent 和其他结构损坏。
- 从 Session 基线和状态 Entry 恢复 model/thinking level；非活动分支不生效，当前环境不可执行时明确阻止请求而不改写历史。
- 按最后一次 Compaction 计算有效上下文，并把普通 Entry、Branch Summary、Compaction Summary 映射为统一 `Message[]`。
- 实现 Tree default 展示/可选规则、User target 归一化、direct navigation、no-op/stale target 行为。
- 实现 Fork 的单路径复制、sequence 重排、内部引用归一化、新 Session 原子创建和源 Session 不变语义。
- 沿用既有 synthetic tool-result 归一化，不新增第二套修复机制。

### 测试

- 多根、多分支、空 leaf、深路径和 sibling 排除；所有损坏路径严格失败。
- model/thinking-level 状态回放、Branch/Compaction wrapper、最后一次 Compaction 生效和跳回压缩前历史。
- Tree 可见/可选目标、User 回填语义、direct navigation no-op、stale target 和提交失败不改变 leaf。
- Fork 空前缀与深路径、状态 Entry、tool call/result、跨路径引用置空、事务失败和源 Session 不变。
- ContextBuilder 仍输出合法 provider-neutral 消息并复用现有 tool 边界修复。

### Review 重点

- 树关系是否只由 parent/active leaf 表达，没有错误使用 sequence 推导分支。
- 状态回放是否基于完整路径，而 Compaction 只裁剪模型可见消息。
- direct navigation 与 Fork 是否通过 Store 原子能力提交，UI 草稿等 presentation 状态没有进入领域层。
- `@byte-mentor/session` 是否保持不依赖 `@byte-mentor/agent`。

## 5. Batch 3：Branch Summary 垂直能力

建议 commit：`feat(session): add summarized branch navigation`

### 范围

- `packages/session/src/**`：LCA、总结区间、摘要输入、导航计划与提交能力。
- `packages/agent/src/**`：provider-neutral 摘要执行适配及可控重试/取消边界。
- `test/session/**`、`test/agent/**` 中对应摘要测试。

### 目标

- 计算 `(LCA, sourceLeaf]`，处理 User target、祖先关系、空区间和 direct fallback。
- 用固定、协议安全的历史序列化生成 Branch Summary 输入，不把任意片段伪装成原生 provider 对话。
- 通过抽象摘要端口在事务外调用模型；Session 包不依赖具体 provider。
- 实现摘要成功后的原子 Entry/leaf/sequence 提交，以及失败、取消、空摘要、stale source 和提交重试语义。
- 提交成功后返回足够的领域结果供 Runtime/TUI 重建 snapshot 和回填草稿，但不直接操作 UI。

### 测试

- LCA、祖先/后代/跨分支、空总结区间和 Compaction 感知的摘要输入。
- ToolResult 截断、固定 wrapper、状态 Entry 排除、source model/thinking 使用与 usage 记录。
- 网络/429/可恢复 5xx 一次重试、不可重试错误、取消和超预算失败。
- 摘要生成期间无 SQLite 长事务；提交失败不移动 leaf，复用已生成摘要重试时不再次调用模型。

### Review 重点

- 区间是否只总结离开的旧分支，没有重复公共历史或目标分支。
- 外部模型调用与数据库事务是否彻底分离。
- 摘要重试是否不会导致重复 Session Entry 或重复模型调用。
- 摘要端口是否足够供 Compaction 复用而没有形成通用工作流框架。

## 6. Batch 4：Token 预算、Compaction 与上游接口冻结

建议 commit：`feat(session): add context compaction capabilities`

### 范围

- `packages/session/src/**`：模型能力、token 估算、cut point、摘要计划与 Compaction 结果。
- `packages/agent/src/**`：provider usage/overflow 归一化与摘要适配的必要扩展。
- `test/session/**`、相关 `test/agent/**` 和分支级集成测试。
- package public exports 与设计文档所需的最终契约测试。

### 目标

- 建立精确匹配的 ModelCapabilities、usage 锚点、本地估算和动态 reserve/keep/summary 预算。
- 实现手动、turn 间和 Turn 内共用的压缩决策；本分支只返回 Turn 内可 checkpoint 的 pending Compaction，不接管 Runtime safe point。
- 实现合法 cut point、完整工具批次、用户交互段、Interaction Prefix Summary 和增量累计摘要。
- 实现固定摘要结构、输入预算、ToolResult 摘要截断、一次重试/取消和 overflow 分类。
- 实现空闲期手动 Compaction 的生成与原子提交；失败不修改 Session，成功后可重建有效上下文。
- 冻结下游 Runtime 将消费的 SessionEntry、SessionStore、Context、Navigation、Summary 和 Compaction 公共契约。

### 测试

- 已知/未知模型、模型切换、真实 usage 锚点失效、本地估算和阈值边界。
- 从 User/Assistant 开始的 cut point、完整 tool batch、多 User 的 interaction segment 和 prefix summary。
- 旧 Compaction 增量更新、摘要输入超预算、单 ToolResult 截断、压缩后仍 overflow。
- 手动 no-op、自动失败、取消 durable boundary、摘要成功但提交失败后复用结果。
- 公共 API contract、InMemory/SQLite 集成以及 M9 验收矩阵中属于 M1～M6 的场景。

### Review 重点

- 未知模型是否避免虚构 context window，自动压缩是否在安全阈值外停止。
- cut point 是否保留用户意图和工具协议边界。
- Turn 内 Compaction 是否只形成领域结果，没有提前接管 checkpoint 或移动数据库 leaf。
- 冻结接口是否最小、provider-neutral，并足够让 Runtime 不访问 Session 内部实现。

## 7. 分支完成标准

- 四个 Batch 全部 GREEN，`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 通过。
- M1～M6 的验收行为均有自动化覆盖，且没有实现 M7/M8 的调度或界面职责。
- 新 SQLite schema 是唯一最终 schema；不包含旧数据库迁移、双写或 feature flag。
- deprecated 线性 Store 入口仅为下游迁移暂留，并在 Runtime 计划最后一个 Batch 删除。
- 公共接口冻结后，才开始 `feat/session-runtime`。

## 8. 非目标

- MessageBus、Runtime Turn 调度、TUI 接线。
- Tree 搜索、额外过滤、标签、书签、`/clone`。
- 精确 tokenizer、多级 map-reduce、自定义摘要 prompt 和 context-window UI。
- 旧线性数据库迁移。
