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

建议 commit：`feat(session): add summary infrastructure in agent layer`

对应设计：M5.3、M5.4、M5.5、M6.8、M6.9 的端口/重试/取消部分。

### 范围

- `packages/agent/src/summary/**`、`packages/agent/src/context/**`：LCA、总结区间、协议安全的摘要输入序列化、
  压缩感知上下文裁剪（`session-context`）与摘要端口（类型定义在 agent，执行适配与重试/取消在 agent）。
- `test/agent/**` 中对应摘要基础设施测试。
- 说明：压缩/摘要生成语义归属 agent 层（用户确认）；session 包只接收摘要产物 Entry 并负责持久化。

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

- `packages/agent/src/**`：Branch Summary 的领域服务（消费区间/端口，生成摘要后调 session 提交原语）。
- `packages/session/src/**`：Branch Summary 的原子提交事务（`BranchSummaryEntry` 落库、推进 leaf/seq）。
- `test/agent/**`、`test/session/**`：Branch Summary 提交与重建测试。

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

- `packages/agent/src/**`：ModelCapabilities 表、token 估算、预算与阈值、触发决策（压缩决策属于 agent 层）。
- `packages/agent/src/**`：provider usage 归一化的必要扩展。
- `test/agent/**` 中对应 token 预算与触发决策测试。

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

## 13. Batch 10a：Compaction 压缩算法（纯计算，已完成）

建议 commit：`feat(agent): add compaction planning`

对应设计：M6.6、M6.7、M6.8 的 cut point、交互前缀、增量摘要与输入预算。

### 已交付

- `planCompaction`：从有效活动路径向前累计 token，选择 User/Assistant 安全切点，ToolResult 命中时回退到产生它的 Assistant，状态 Entry 不作为切点。
- 必要时把交互段前缀并入摘要输入，但不导出同构 segment/prefix 类型，也不把内部前缀暴露到 `CompactionPlan`。
- 合并最近 `previousSummary` 与本次新增被压缩内容；摘要输入经过单 ToolResult 截断后仍超预算时明确失败。
- 固定 Compaction 摘要章节与“只总结、不继续执行”提示词。
- `selectEffectiveContextEntries` 作为压缩感知有效上下文选择 API。

## 13.1 Batch 10b：Compaction 提交、Turn 内结果与契约冻结

建议 commit：`feat(session): add context compaction and freeze contracts`

对应设计：M6.5、M6.9、M6.10、M6.11，M3.7/M3.11 的提交事务，以及 M1～M6 公共契约冻结。

### 已确认公共契约

- `PendingSessionEntry = DistributiveOmit<SessionEntry, "sequence">`：进入 checkpoint 前已经具有稳定 `id`、`createdAt` 和逻辑 `parentId`，最终事务只分配 sequence。
- `PendingCompactionEntry` 是上述 union 中的 compaction 分支；Turn 内 Compaction 可以通过 `firstKeptEntryId` 引用已持久化或本 Turn 更早的 pending Entry。
- `SessionStore.commitTurnEntries` 改为直接接收 `PendingSessionEntry[]`，校验稳定 ID 与连续 parent 链，不再提交时生成 ID/时间或推导另一条 parent 链。
- `SessionStore.commitCompaction` 接收已经准备好的 `PendingCompactionEntry`，短事务内校验 leaf、分配 sequence、插入并推进 leaf。
- agent 提供 `prepareCompaction`（只生成 pending 结果）和 `compactSession`（空闲期生成、提交与重建）；提交失败通过 `PreparedCompaction` 复用同一摘要和 Entry ID。
- `SummaryRequest` 增加 `instructions` 和可选 `maxOutputTokens`，与 `historyText`、model/thinking、signal 一起构成 provider-neutral 摘要请求。
- 各 provider adapter 把可可靠识别的厂商结构化 overflow 错误转换成 Byte Mentor 的 `ProviderInvocationError(kind = "context-overflow")`；上层不依赖厂商 SDK、不解析异常文案，其他错误不得误判。

### 范围

- `packages/agent/src/compaction/**`：pending Compaction 准备、空闲期领域服务、prepared 重试和提交后上下文重建。
- `packages/agent/src/summary/**`：固定 instructions 与 `SummaryRequest.maxOutputTokens` 契约。
- `packages/agent/src/providers/**`：provider-neutral context overflow 错误及 OpenAI adapter 映射。
- `packages/session/src/**`：pending Entry 最终契约、Turn 提交迁移、Compaction 原子提交事务（InMemory + SQLite）。
- `test/agent/**`、`test/session/**`、package public exports 和 M1～M6 契约测试。

明确不接入 AgentLoop、最终 RuntimeCheckpoint、mailbox、safe-point 调度、实际 provider overflow 重试循环或 TUI；这些由下游 Runtime/TUI 分支消费本 Batch 冻结的能力。自定义 prompt、多级摘要和自动换模型仍不实现。

### 目标

- 空闲期 Compaction 在数据库事务外生成摘要，成功后原子插入 Entry 并推进 leaf/sequence；提交成功后重建完整 path、有效 messages、模型状态和压缩后 token 估算。
- Turn 内 Compaction 只返回可写入 checkpoint 的稳定 pending Entry 与压缩后 working context，不写数据库、不移动 active leaf。
- 摘要失败、取消、空摘要或 stale leaf 不留下部分持久化状态；提交失败保留 prepared 结果供复用。
- checkpoint、Turn 最终提交和 Turn 内 Compaction 共用一种 pending Entry 结构。
- provider overflow 只通过 adapter 翻译后的内部错误契约暴露给 Runtime；真正的“压缩并重试一次”由下游 Runtime 在最近安全 checkpoint 上编排。

### 测试（Batch briefing 冻结的 29 个场景）

#### Pending Entry 与 Turn 提交

1. 稳定 pending Entry 提交到空 Session：Store 只分配 sequence，保留调用方提供的 ID、时间和根 parent。
2. pending 链接到已有 active leaf：parent 链与连续 sequence 正确，leaf 指向末条。
3. Turn 提交原子清除 checkpoint，同时提交 Entry、leaf 和 sequence。
4. stale leaf 拒绝 Turn 提交，Entry、leaf、sequence 和 checkpoint 全部不变。
5. 空 pending 链返回 constraint，Session 不变。
6. 第一条或后续 Entry 的 parent 链不连续时拒绝整批提交。
7. pending Compaction 的 `firstKeptEntryId` 引用本 Turn 更早 pending Entry 时可完整物化并保持引用有效。

#### Compaction Store 事务

8. InMemory/SQLite 成功提交 Compaction，完整保存 payload 并原子推进 leaf/sequence。
9. 独立 Compaction 提交不擅自清除 runtime checkpoint metadata。
10. stale source leaf 返回 `SessionLeafConflictError` 并完整回滚。
11. Session 不存在时返回 `SessionNotFoundError`。
12. 空白摘要返回 constraint 且不写 Entry。
13. 非法 parent 或 `firstKeptEntryId` 引用在两种 Store 中都被拒绝并回滚。

#### Summary 契约

14. Compaction 请求分别传递固定 instructions、协议安全 history、model/thinking、maxOutputTokens 和 signal。
15. Branch Summary 迁移到固定 instructions，并保持原有区间、模型、重试和取消行为。

#### Turn 内 Compaction

16. 成功准备具有稳定 ID、时间、逻辑 parent、trigger/model/usage/tokensBefore 的 pending Compaction，且 Store 未被调用。
17. pending Compaction 可以引用尚未落库的同 Turn Entry，并返回应用新 Compaction 后的有效 messages。
18. pending 摘要失败或取消时不返回 Compaction Entry，也不修改原 pending 链。
19. pending 摘要为空时返回 `empty-summary`，不形成 durable 结果。

#### 空闲期 Compaction 领域服务

20. 手动 Compaction 在事务外生成摘要，提交后成为 active leaf，并返回重建上下文与压缩后估算。
21. 没有可压缩内容时友好 no-op，不调用摘要模型、不写 Entry。
22. 当前模型不可执行时返回 `model-unavailable`，摘要模型调用次数为零。
23. 摘要生成失败或取消时返回 `generation-failed`，不提交 Compaction。
24. 摘要成功后 source leaf 已变化时返回 `SessionLeafConflictError`，不写 Compaction。
25. 提交失败返回 `PreparedCompaction`；复用重试时保持同一摘要和 Entry ID，不再次调用模型。
26. 提交成功后 messages 以新 Compaction summary 开始，保留尾部、完整路径状态与模型状态正确。

#### Provider overflow 归一化

27. OpenAI 结构化 context overflow 被 adapter 转换为内部 `ProviderInvocationError("context-overflow")`。
28. rate limit、认证、网络或未知 OpenAI 错误不被误判为 context overflow。
29. overflow 在 stream 创建或消费阶段发生时得到相同内部分类，partial stream 不形成成功响应。

### Review 重点

- Store 是否只分配 sequence，并严格保留 checkpoint 已冻结的 Entry 身份和 parent 链。
- Turn 内 Compaction 是否只形成领域结果，没有提前写 checkpoint、提交半个 Turn或移动数据库 leaf。
- 摘要模型调用是否始终在 SQLite 事务外；prepared 重试是否不重复模型调用。
- provider 错误映射是否局限于 adapter，且只依据可靠结构化字段。
- 冻结接口是否最小、provider-neutral，足够让 Runtime 不访问 Session 内部实现。

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
