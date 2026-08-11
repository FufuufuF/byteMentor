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

- 下列一个 Batch 是一次开发、验证和 review 的最小单位，也是一个建议 commit 边界。本计划把原来的四个里程碑级切片进一步拆成十个细粒度 Batch，使每个 Batch 聚焦一到两个概念、可在一次 review 中完整读完。
- 每个 Batch 内连续完成 TDD：先建立能证明目标行为的失败测试，再实现生产代码，直到该 Batch 全部 GREEN；RED/GREEN 不拆成单独提交，也不要求中途 review。
- 测试与使其通过的生产代码必须在同一个 Batch 中。公共契约变更与必须同步迁移的调用方也放在同一 Batch，保证仓库可构建。
- 每个 Batch 结束后仓库必须处于可构建、可运行相关测试的状态；不允许把一个概念的实现横跨两个 Batch。
- 写事务原语随其所属功能一起交付：通用的 Turn 批量提交与恢复提交事务留在地基层（Batch 3），Summary、Fork、Compaction 各自的提交事务下沉到对应功能 Batch，使每个功能 Batch 成为自洽的薄垂直切片。
- InMemory 与 SQLite 两种实现在同一个 Batch 内一起完成，并共用同一套 Store contract 测试双实现验证，不把两种实现拆成不同 Batch。
- 每个 Batch 结束至少运行相关测试、`pnpm typecheck`、`pnpm lint` 和 `pnpm format:check`；分支收口时再运行 `pnpm test` 与 `pnpm build`。
- Batch 是建议提交边界；没有用户明确授权时不执行 `git commit`。
- 如果实现暴露设计未覆盖、且会改变公共契约或事务语义的问题，暂停回到设计；普通文件组织和私有命名由实现者自行决定。

## 3. Batch 依赖顺序

```
B1 → B2 → B3 → B4 → B5 → B6
                 ↘ B7 → B8
                        B9 → B10
```

- B2 依赖 B1；B3 依赖 B2。
- B4、B5、B6 依赖 B1～B3。
- B7 依赖 B4（摘要复用状态回放）。
- B8 依赖 B3、B5、B7。
- B9 依赖 B4、B5。
- B10 依赖 B7、B9。

Batch 之间基本线性，建议按编号顺序逐个实现、逐个 review。

## 4. Batch 1：Entry 领域模型与结构校验

建议 commit：`feat(session): model session entries and tree invariants`

对应设计：M2（§2）。

### 范围

- `packages/core/src/**`：稳定 ID、provider-neutral 共用值对象（`ModelRef`、`ThinkingLevel`、`ToolCall`、`TokenUsage` 等）的必要调整。
- `packages/session/src/**`：仅 Entry 领域类型与纯结构校验，不含任何 Store 或 SQLite 代码。
- `test/core/**`、`test/session/**` 中对应的纯类型/校验测试。

### 目标

- 建立设计 M2 的 `SessionEntry` union 与七种具体 Entry、`BaseEntry` 共同字段和共用值对象。
- tool call 内嵌 `AssistantEntry.toolCalls`；tool result 独立成节点；不引入 navigation entry。
- 实现纯函数式的结构校验：discriminator、payload、`parentId`/`sequence` 关系、tool-call 与 tool-result 内部引用、M2 共同不变量。
- 明确序列化边界：Entry 为纯数据，不带行为；`sessionId` 不进入领域 Entry。

### 测试

- 七种 Entry 的 discriminator 与 payload 必填/空值语义。
- `parentId`/`sequence` 校验：父早于子、根为 `null`、禁止自引用。
- tool-call/result 引用校验与内部一致性。
- 违反不变量时校验函数返回明确错误分类，不抛裸异常。

### Review 重点

- 是否为纯类型与纯校验，没有引入 Store、SQLite、provider 或 Runtime 依赖。
- 七种 Entry 字段是否与设计 §2 一致，未多引入 `messageId` 等冗余身份字段。
- `@byte-mentor/session` 是否保持不依赖 `@byte-mentor/agent`。

## 5. Batch 2：Store 契约与生命周期（InMemory + SQLite）

建议 commit：`feat(session): add session store contract and lifecycle`

对应设计：M3 的 schema、连接配置、全量加载、错误归一化（§3.1、§3.2、§3.3、§3.4、§3.14 的连接部分）。

### 范围

- `packages/session/src/**`：`SessionStore` 契约、`sessions + session_entries` 最终 schema、InMemory 与 SQLite 的基础生命周期实现、错误归一化。
- `test/session/**`：InMemory/SQLite 共用的 Store contract 测试。
- 仅为保持现有 AgentLoop 可编译而需要的 deprecated 线性适配入口。

### 目标

- 定义 `SessionStore` 契约，只暴露领域原子能力，不包含 provider、Runtime 或 UI 决策。
- 用 `sessions + session_entries` 最终 schema 替换 legacy 线性存储；不实现旧数据库迁移。
- 实现两种 Store 共同的基础生命周期：Session 创建、按 `(session_id, entry_seq)` 全量树加载、metadata 读取、close/reopen。
- 落实连接初始化：`foreign_keys = ON`、`journal_mode = WAL`、`synchronous = FULL`、`busy_timeout = 5000`，以及复合外键、`next_entry_seq` 初始值、`WITHOUT ROWID` 约束。
- 将 SQLite 错误归一化为 M9 定义的稳定类别；领域层不解析原始错误字符串。
- 暂时保留标记为 deprecated 的线性 `appendMessages/getHistory` 适配入口，使尚未迁移的旧 AgentLoop 保持 GREEN；该入口不得成为新能力的实现基础。

### 测试

- InMemory/SQLite 共用 Store contract：创建、全量加载、metadata 读取、close/reopen 行为一致。
- SQLite schema 约束、外键、`json_valid`、`UNIQUE (session_id, entry_seq)`、WAL 配置。
- 稳定错误分类：session 不存在、约束失败、非法引用均返回归一化错误。
- 旧 AgentLoop 的已有回归测试通过 deprecated 入口继续通过。

### Review 重点

- Store 契约是否只提供领域原子能力，没有多步写事务混入。
- 是否用一张公共 entry 表，没有引入七张子表或多余物化表。
- 两种实现是否真正共用同一份 contract 测试，而不是各写一套。
- deprecated 入口是否只是短期兼容层，新测试没有依赖它。

## 6. Batch 3：单语句写与 Turn/恢复批量提交事务

建议 commit：`feat(session): add transactional turn and checkpoint commits`

对应设计：M3.7、M3.8、M3.9、M3.13、M3.14 的事务规则。

### 范围

- `packages/session/src/**`：checkpoint JSON 更新、active leaf 单语句更新、Turn 批量提交事务、checkpoint 恢复提交事务，在两种 Store 上一致实现。
- `test/session/**`：事务原子性与回滚的 contract 测试。

### 目标

- 实现 checkpoint 的单语句 `json_set` 局部更新，不做“先读全量 metadata 再合并回写”。
- 实现 active leaf 的单语句更新原语（供 Batch 5 的直接导航服务消费）。
- 实现 Turn 最终提交：短 `BEGIN IMMEDIATE` 事务内校验 leaf、从 `next_entry_seq` 连续分配、批量插入、推进 leaf/sequence、清理 `runtime_checkpoint`。
- 实现 checkpoint 恢复提交：走同一批量追加事务，从 pending Entry 链物化并原子提交，同批未闭合 tool call 按 §3.5 补“结果未知”ToolResult。
- 落实共同事务规则：受影响行数检查、`DEFERRABLE INITIALLY DEFERRED` 提交时校验、不在事务中等待外部 I/O、回滚语义。

### 测试

- Turn 提交与恢复提交验证“全部成功或全部回滚”，失败不留下部分 Entry、不推进 leaf/sequence、checkpoint 仍可用。
- leaf 校验失败（并发下 leaf 已变）时事务拒绝提交。
- 单语句 checkpoint 更新只改目标字段，不覆盖其他 metadata；崩溃只保留完整旧/新 JSON。
- 恢复提交后 checkpoint 已清除且不重复物化。

### Review 重点

- 通用 Turn/恢复提交是否留在地基层，而 Summary/Fork/Compaction 的提交没有提前混进来。
- 同一事务内 Entry、leaf、sequence 与 checkpoint 是否保持一致。
- 单语句写是否真正依赖隐式事务，没有多余显式事务包裹。

## 7. Batch 4：活动路径重建与状态回放

建议 commit：`feat(session): rebuild active path and replay state`

对应设计：M4.1、M4.2、M4.8（§4.1、§4.2、§4.8）。

### 范围

- `packages/session/src/**`：从 active leaf 重建活动路径、结构损坏检测、model/thinking-level 回放、恢复状态可用性判定。
- `test/session/**`：路径重建与状态回放测试。

### 目标

- 从 `active_leaf_id` 沿 `parentId` 严格重建单条活动路径，再反转为根到 leaf 顺序。
- 检测缺失节点、循环、逆序 parent、非空 leaf 不存在等损坏，采用严格失败策略阻止后续构建，不截断、不自动修复。
- 从 Session 初始 model/thinking-level 基线扫描完整活动路径回放状态，取路径上最后一条状态 Entry；非活动分支不生效；`AssistantEntry.model` 不参与后续状态回放。
- 恢复出的 model/thinking level 在当前环境不可执行时，判定 Session 不损坏但阻止请求，不静默回退默认值、不自动追加状态 Entry。

### 测试

- 多根、多分支、空 leaf、深路径、sibling 排除；所有损坏路径严格失败。
- 状态回放：基线生效、多次覆盖取最后一条、非活动分支不生效。
- 恢复状态不可用时阻止请求且不改历史。

### Review 重点

- 树关系是否只由 `parentId`/active leaf 表达，没有用 sequence 推导分支。
- 状态回放是否基于完整活动路径，而非压缩后的可见范围。
- 严格失败是否覆盖设计列出的全部损坏情形。

## 8. Batch 5：上下文映射与 Tree 直接导航

建议 commit：`feat(session): build provider context and direct navigation`

对应设计：M4.3～M4.7、M4.9、M5.1、M5.2、M5.7、M5.8，以及 M3.9 的直接导航事务。

### 范围

- `packages/session/src/**`：普通 Entry→Message 映射、压缩感知裁剪、summary 消息映射、上下文重建流水线、Tree 直接导航领域服务。
- `packages/agent/src/context/**`：迁移现有 ContextBuilder 消费新公共契约所需的最小适配。
- `test/session/**`、`test/agent/context-builder.test.ts` 及相关集成测试。

### 目标

- 把活动路径普通 Entry 映射为统一 `Message[]`：User/Assistant/ToolResult 对应消息，状态 Entry 不生成消息。
- 复用现有 tool-call/tool-result 归一化机制补占位结果，不新增第二套修复。
- 实现压缩感知裁剪：以活动路径上最后一个 Compaction 计算有效上下文 `[C] + [K..C) + (C..leaf]`，`firstKeptEntryId` 合法性校验。
- 实现 Branch Summary 与 Compaction Summary 的固定 wrapper `UserMessage` 映射。
- 实现 Tree 直接导航服务：Tree default 可见/可选规则、User target 归一化到 parent 并回填草稿、`targetLeafId = null` 语义、no-op/stale target、提交失败不改 leaf；导航提交复用 Batch 3 的 active leaf 单语句原语。
- 组装 M4.9 的完整上下文重建流水线。

### 测试

- 普通 Entry/Branch/Compaction wrapper 映射、最后一次 Compaction 生效、跳回压缩前历史。
- Tree 可见/可选目标、User 回填语义、direct navigation no-op、stale target、提交失败不改变 leaf。
- ContextBuilder 仍输出合法 provider-neutral 消息并复用现有 tool 边界修复。

### Review 重点

- 状态回放（Batch 4）与压缩裁剪是否职责分离：Compaction 只裁模型可见消息。
- 直接导航是否通过 Store 原语提交，UI 草稿等 presentation 状态没有进入领域层。
- `@byte-mentor/session` 是否保持不依赖 `@byte-mentor/agent`。

## 9. Batch 6：Fork 垂直切片

建议 commit：`feat(session): fork a path into an independent session`

对应设计：M1.3.1、M2（fork 建模）、M3.12、M4.2 的 fork 基线复制。

### 范围

- `packages/session/src/**`：Fork 领域服务与其独立的原子创建事务。
- `test/session/**`：Fork 行为与事务测试。

### 目标

- 在内存中取得 root 到所选 user entry 之 parent 的稳定单路径。
- 用一个 `BEGIN IMMEDIATE` 事务原子创建新 Session：新 ID、不保留来源关系、继承 workspace 与初始 model/thinking-level 基线、metadata 空、leaf 初始 `null`。
- 按路径顺序复制 Entry：保留 Entry ID/tool call ID/内容/原始 `created_at`，`entry_seq` 从 1 重排，parent 指向复制路径前驱。
- 归一化 payload 引用：路径内引用保持有效，`BranchSummaryEntry.sourceLeafId`、`CompactionEntry.firstKeptEntryId` 指向路径外时置 `null`。
- 设置新 Session active leaf 为复制路径末条（空路径 `null`），`next_entry_seq = 复制数 + 1`。

### 测试

- 空前缀与深路径、状态 Entry、tool call/result、跨路径引用置空。
- 事务失败时新 Session 整体不存在，源 Session 始终不变。
- fork 复制的状态 Entry 在两个 Session 得到相同回放结果。

### Review 重点

- Fork 提交事务是否自洽下沉，没有污染 Batch 3 的通用事务。
- 复用 Entry ID 是否未建立新旧 Session 的持久化关系。
- 源 Session 不变语义是否严格成立。

## 10. Batch 7：摘要基础设施（区间、输入序列化、摘要端口）

建议 commit：`feat(session): add summary interval and model port`

对应设计：M5.3、M5.4、M5.5、M6.8、M6.9 的端口/重试/取消部分。

### 范围

- `packages/session/src/**`：LCA、总结区间、协议安全的摘要输入序列化。
- `packages/agent/src/**`：provider-neutral 摘要执行适配及可控重试/取消/超预算边界。
- `test/session/**`、`test/agent/**` 中对应摘要基础设施测试。

### 目标

- 计算 `(LCA, sourceLeaf]`：处理 User target 归一化、祖先关系、空区间与 direct fallback 判定。
- 用固定、协议安全的历史序列化生成摘要输入，不把任意片段伪装成原生 provider 对话；区间内含 Compaction 时按 M4“最后一次生效”裁剪。
- 定义抽象摘要端口，在事务外调用模型；Session 包不依赖具体 provider。
- 实现摘要执行边界：网络/429/可恢复 5xx 一次重试并遵守 `Retry-After`、不可重试错误、取消、ToolResult 输入截断、超预算失败。

### 测试

- LCA、祖先/后代/跨分支、空总结区间、Compaction 感知的摘要输入。
- ToolResult 截断、固定 wrapper、状态 Entry 排除、source model/thinking 使用。
- 一次重试、不可重试错误、取消、超预算失败的分类。

### Review 重点

- 区间是否只覆盖离开的旧分支，不重复公共历史或目标分支。
- 摘要端口是否足够供 Branch Summary 与 Compaction 共用，而没有形成通用工作流框架。
- 外部模型调用是否完全在数据库事务之外。

## 11. Batch 8：Branch Summary 垂直切片

建议 commit：`feat(session): commit summarized branch navigation`

对应设计：M5.6、M5.7、M5.8，以及 M3.10 的带摘要导航事务。

### 范围

- `packages/session/src/**`：Branch Summary 的提交事务与导航后重建。
- `test/session/**`：Branch Summary 提交与重建测试。

### 目标

- 消费 Batch 7 的区间与端口，实现摘要成功后的原子提交：`BEGIN IMMEDIATE` 内重新校验 active leaf 仍为 `S`、插入 `BranchSummaryEntry`（`parentId = T`、`sourceLeafId = S`）、推进 leaf/`next_entry_seq`/`updated_at`。
- 实现失败、取消、空摘要、stale source 语义；提交失败复用已生成摘要重试，不再次调用模型。
- 提交成功后依次重建活动路径、恢复目标分支状态、重建 transcript、更新编辑器草稿；返回足够的领域结果供 Runtime/TUI 重建 snapshot，但不直接操作 UI。

### 测试

- 摘要成功提交、stale source 拒绝、提交失败复用摘要重试不重复调用模型。
- 摘要生成期间无 SQLite 长事务；提交失败不移动 leaf。
- 导航后 transcript/状态/草稿重建语义（含带摘要选择 UserEntry 时 Summary 成为 leaf）。

### Review 重点

- Branch Summary 提交事务是否自洽下沉。
- 摘要重试是否不导致重复 Session Entry 或重复模型调用。
- 导航后重建是否复用 Batch 4/5 的路径与上下文能力，没有另起一套。

## 12. Batch 9：Token 预算与压缩决策

建议 commit：`feat(session): add token budgeting and compaction triggers`

对应设计：M6.1、M6.2、M6.3、M6.4（决策部分）。

### 范围

- `packages/session/src/**`：ModelCapabilities 表、token 估算、预算与阈值、触发决策。
- `packages/agent/src/**`：provider usage 归一化的必要扩展。
- `test/session/**`、相关 `test/agent/**`。

### 目标

- 建立内置 `(provider, modelId)` 精确匹配的 `ModelCapabilities`；未知模型不启用阈值自动压缩、不假定默认窗口。
- 实现 usage 锚点：真实 usage 优先、`cachedInputTokens` 不重复计入、锚点失效时重新全量估算。
- 实现本地估算：有效消息 + tool definitions/schema + system prompt，ASCII `chars/4`、非 ASCII 保守估、固定协议开销、tool-call 参数稳定序列化后估算。
- 实现动态 `reserveTokens`/`keepRecentTokens`/`maxSummaryOutputTokens` 预算与触发阈值判定（手动、turn 间共用）；压缩后重估仍超阈值时阻止请求。

### 测试

- 已知/未知模型、模型切换、真实 usage 锚点失效、本地估算、阈值边界。
- 未知模型不虚构 context window，自动压缩在安全阈值外停止。

### Review 重点

- 未知模型策略是否严格，没有模糊前缀猜测。
- 决策与提交是否分离：本 Batch 只产出压缩决策，不写 Entry。

## 13. Batch 10：Compaction 垂直切片与契约冻结

建议 commit：`feat(session): add context compaction and freeze contracts`

对应设计：M6.5、M6.6、M6.7、M6.10、M6.11，M3.11 的 Compaction 事务，以及 M1～M6 公共契约冻结。

### 范围

- `packages/session/src/**`：cut point、交互段切分、增量摘要、Compaction 提交、Turn 内 pending Compaction 结果。
- `packages/agent/src/**`：provider overflow 归一化的必要扩展。
- `test/session/**`、相关 `test/agent/**` 与分支级集成测试。
- package public exports 与设计文档所需的最终契约测试。

### 目标

- 实现合法 cut point：完整工具批次、用户交互段边界、Interaction Prefix Summary、状态 Entry 不作切点。
- 实现增量累计摘要与固定摘要结构（Goal/Constraints/Progress/…/Critical Context），合并 `previousSummary` 与本次被压掉内容。
- 实现空闲期手动/turn 间 Compaction 的原子提交：`BEGIN IMMEDIATE` 校验 leaf、插入 `CompactionEntry`（`parentId = sourceLeafId`）、推进 leaf/sequence；失败不修改 Session，成功后可重建有效上下文。
- 实现 Turn 内 pending Compaction：只返回可由 Runtime 放入 checkpoint 的领域结果，不提前移动数据库 leaf、不提前提交半个 Turn。
- 实现 overflow 分类与恢复策略：一次压缩重试、压缩后仍 overflow 停止并建议换更大窗口。
- 冻结下游 Runtime 将消费的 `SessionEntry`、`SessionStore`、Context、Navigation、Summary 和 Compaction 公共契约，补齐 M9 验收矩阵中属于 M1～M6 的场景。

### 测试

- 从 User/Assistant 开始的 cut point、完整 tool batch、多 User 交互段、prefix summary。
- 旧 Compaction 增量更新、摘要输入超预算、单 ToolResult 截断、压缩后仍 overflow。
- 手动 no-op、自动失败、取消 durable boundary、摘要成功但提交失败后复用结果。
- Turn 内 Compaction 只形成领域结果，不移动数据库 leaf。
- 公共 API contract、InMemory/SQLite 集成以及 M9 验收矩阵中属于 M1～M6 的场景。

### Review 重点

- cut point 是否保留用户意图与工具协议边界。
- Turn 内 Compaction 是否只形成领域结果，没有提前接管 checkpoint 或移动数据库 leaf。
- 冻结接口是否最小、provider-neutral，足够让 Runtime 不访问 Session 内部实现。

> 备注：本 Batch 是十个中最重的一个（cut point + 增量摘要 + 提交 + Turn 内 + 契约冻结）。如实现或 review 时发现负担过大，按下列自然边界拆成两个 Batch：**B10a** 压缩算法（cut point + 交互段切分 + 增量摘要，纯计算）；**B10b** Compaction 提交 + Turn 内 pending 结果 + overflow 恢复 + 契约冻结。

## 14. 分支完成标准

- 十个 Batch 全部 GREEN，`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 通过。
- M1～M6 的验收行为均有自动化覆盖，且没有实现 M7/M8 的调度或界面职责。
- 新 SQLite schema 是唯一最终 schema；不包含旧数据库迁移、双写或 feature flag。
- deprecated 线性 Store 入口仅为下游迁移暂留，并在 Runtime 计划最后一个 Batch 删除。
- 公共接口冻结后（Batch 10），才开始 `feat/session-runtime`。

## 15. 非目标

- MessageBus、Runtime Turn 调度、TUI 接线。
- Tree 搜索、额外过滤、标签、书签、`/clone`。
- 精确 tokenizer、多级 map-reduce、自定义摘要 prompt 和 context-window UI。
- 旧线性数据库迁移。
