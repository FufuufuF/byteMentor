# Session Tree & Compaction 实现进度

- 分支：`feat/session-tree-compaction`
- 计划：[`.agents/.plan/session-tree-compaction-implementation-plan.md`](../.plan/session-tree-compaction-implementation-plan.md)
- 设计：[`.agents/.design/session-tree-compaction.md`](../.design/session-tree-compaction.md)（M1～M6）
- 状态：**Batch 1～10a、10b-session 已提交；Batch 10b-Turn 已完成并将在本次提交；10b-agent 待实现**

## 当前进度

| Batch | 内容 | 提交 | 状态 |
|---|---|---|---|
| 1 | Entry 领域模型与结构校验 | `122d737` | ✅ 已提交 |
| 2 | Store 契约与生命周期（InMemory + SQLite） | `cd63e30` | ✅ 已提交 |
| 3 | 单语句写与 Turn/恢复批量提交事务 | `6be06ee` | ✅ 已提交 |
| 4 | 活动路径重建与状态回放 | `586b75f` | ✅ 已提交 |
| 5 | 上下文映射与 Tree 直接导航 | `418a77f` | ✅ 已提交 |
| 6 | Fork 垂直切片 | `43dcb4f` | ✅ 已提交 |
| 7 | 摘要基础设施（区间、序列化、端口、重试） | `5b86d05` | ✅ 已提交 |
| 8 | Branch Summary 垂直切片 | `51142fb` | ✅ 已提交 |
| 9 | Token 预算与压缩决策（决策层） | `e50c56d` | 🟡 已提交；运行时接线待补 |
| 10a | Compaction 压缩算法（纯计算） | `4a36011` | ✅ 已提交 |
| 10b-session | Compaction 原子提交事务（InMemory + SQLite） | `80fff2a` | ✅ 已提交 |
| 10b-Turn | PendingSessionEntry 契约与 Turn 最终提交迁移 | 本次提交 | ✅ 已完成 |
| 10b-agent | Compaction pending/空闲期领域服务与 overflow 归一化 | — | ⏳ 待实现 |

## 重要架构决策（实现中用户确认，已偏离原始计划）

### 1. 压缩/摘要生成语义全部归 agent 层（B7 时确认）

用户明确："session 不应该带有压缩语义的逻辑，它属于 agent 层"。最终划分：

- **agent 包**（`packages/agent/src/`）：
  - `summary/summary-interval.ts`：`computeSummaryInterval`（LCA、(LCA,S] 区间）
  - `summary/summary-serialize.ts`：`serializeSummaryInput`、`truncateToolResultForSummary`（2000 字符）
  - `summary/summary-port.ts`：端口类型 `SummaryModelPort`/`SummaryRequest`/`SummaryResponse`/`SummaryError`（三分类 retryable/permanent/cancelled）
  - `summary/summary-executor.ts`：`executeSummaryWithRetry`（重试一次、Retry-After、取消）
  - `summary/branch-summary.ts`：`navigateWithBranchSummary` 领域服务 + `BranchSummaryError`（四分类）+ `PreparedBranchSummary`（B8）
  - `context/session-context.ts`：`mapEntriesToMessages`/`selectEffectiveContextEntries`/`buildProviderContext`（原 session 的 context-builder 整体移入，M4.9 流水线）
  - `runtime/runtime-environment.ts`：`RuntimeEnvironment`/`defaultRuntimeEnvironment`（B8 从 session 迁入，见决策 5）
- **session 包**（`packages/session/src/`）：只保留 Entry 类型、Store 持久化、树/路径/状态回放、导航、fork、以及各写事务提交原语。**零 agent 依赖**。

依赖方向：agent → session 正向，无反向依赖。

### 2. 计划文档已同步更新

`.agents/.plan/session-tree-compaction-implementation-plan.md` 中 B7/B8/B9/B10 的范围已改为：
- B7/B9：全部在 `packages/agent/**` + `test/agent/**`
- B8：领域服务在 agent，提交事务在 session（`BranchSummaryEntry` 落库、推进 leaf/seq）
- B10：cut point/增量摘要/Compaction 领域服务在 agent，原子提交事务在 session

### 3. 其他确认过的决策

- **deprecated 线性适配入口**（`create`/`get`/`appendMessages`/`getHistory`）：保留实现（AgentLoop 未迁移），B2 时删除了专项测试；迁移完成后删除。已加 `@deprecated` 标注。
- **`SessionSnapshot` 命名**：迁移完成后重命名为 `Session`（旧 `Session` 接口届时删除，名称回收）。已加注释。
- **leaf 持久化**：`sessions.active_leaf_id` 列持久化（用户曾提议"seq 最大推导 leaf"，被反例否决——/tree 直接导航后 leaf 与 seq 脱钩）。
- **状态回放方向**：`replayRuntimeState` 从 leaf 向上追溯，遇最近 model_change/thinking_level_change 即生效（等价于 root 扫描取最后一条，可提前终止）。
- **`RestoredRuntimeState` 更名为 `ModelState`**。
- **Fork 复制保留 Entry ID/createdAt**（设计 §3.12：ID 是 session 内局部身份，跨 session 复用不冲突；保留 ID 使路径内引用有效）。
- **B1 校验只做树级引用存在性**；路径级校验（toolCallId 在活动路径上、firstKeptEntryId 早于 compaction）在 B4/B5 处理。
- **Batch 3 曾未经授权提交**，用户指出后已改正流程：此后每个 Batch GREEN 后先报告、等 review、授权后才提交。

### 4. `SummaryModelPort.summarize` 的具体实现未实现（B8 确认）

- 现状：`SummaryModelPort` 只是接口；`navigateWithBranchSummary` 经 `input.summarize` 注入、由 `executeSummaryWithRetry` 包装调用。全仓库无具体实现，测试均用 fake port。
- 归属：语义上等价于一次单轮、无工具的 provider 调用，现有 `ModelProvider`（`providers/provider.ts`）已具备能力。
- **待办（M7 Runtime 分支）**：在 agent 包新建 provider 桥接适配器（如 `summary/provider-summary-adapter.ts`），把 `SummaryRequest`（固定 instructions + historyText + model/thinking + 可选 maxOutputTokens）映射为具体 provider 请求，调用模型并把输出映射为 `SummaryResponse`（文本 + usage）；取消接 `signal`。M7 Runtime 组装时经 `summarize` 注入。

### 5. `RuntimeEnvironment` 从 session 迁入 agent（B8 用户确认）

- 原 `RuntimeEnvironment`/`defaultRuntimeEnvironment` 定义在 `session-store.ts`（B4 遗留：当时 context-builder 还在 session 包）。
- B7 上下文重建迁入 agent 后全部消费方都在 agent，session 包零引用；真实实现（B9 ModelCapabilities + provider 栈、M7 注入）也注定在 agent。
- 已迁至 `packages/agent/src/runtime/runtime-environment.ts`（新建 `runtime/` 目录预留 M7）；`ModelState` 留在 session（`replayRuntimeState` 的返回类型，状态回放领域产物）。测试导入同步更新。

### 6. B8 实现细节（用户 briefing 中已确认，执行中落实）

- `RebuiltNavigationContext`（path/messages/modelState/execution）以扁平字段展开进 `navigateWithBranchSummary` 成功结果，而非嵌套 `context` 对象。
- `unknown-entry` 区间结果 → `SessionCorruptedError("parent-missing")`（活动路径已通过重建校验，剩余只可能是目标祖先链缺失）。
- 摘要文本 trim 后存储；`PreparedBranchSummary` 只含 summary/model/usage，重试时重新校验目标与区间。

### 7. B10b 公共契约（用户已确认）

- pending Entry 在写入 runtime checkpoint 前已经具有稳定 `id`、`createdAt` 和逻辑 `parentId`，只缺少最终事务分配的 `sequence`；统一导出 `PendingSessionEntry = DistributiveOmit<SessionEntry, "sequence">`，不再维护第二套同义 checkpoint 类型。
- `commitTurnEntries` 直接接收并校验上述稳定 pending 链；Store 不在提交时生成新 ID/时间或推导另一条 parent 链。这样 Turn 内 `CompactionEntry.firstKeptEntryId` 可以安全引用尚未落库的同 Turn Entry。
- `SummaryRequest` 增加固定 `instructions` 与可选 `maxOutputTokens`，和不可信 `historyText` 分离；Compaction/Branch Summary 领域服务负责填入各自固定指令，不开放自定义 prompt。
- provider overflow 采用 adapter 翻译边界：每个 Provider Adapter 根据自身厂商的结构化错误映射为 Byte Mentor 的 `ProviderInvocationError(kind = "context-overflow")`；Agent/Runtime 不依赖 OpenAI SDK、不解析厂商错误文案，无法确认的错误不得猜测为 overflow。
- B10b 的 29 个测试场景、明确范围与非目标已写入 implementation plan；实际 safe-point/checkpoint 接线和 overflow 后单次重试循环仍由下游 Runtime 分支实现。

## 各 Batch 交付细节

### Batch 1：`feat(session): model session entries and tree invariants`

- `core/src/model.ts`：`ModelRef`、`ThinkingLevel`（7 变体）、`TokenUsage`
- `session/src/entries.ts`：`BaseEntry` + 七种 `SessionEntry`（user/assistant/tool_result/model_change/thinking_level_change/compaction/branch_summary）；`AssistantEntry.content/toolCalls` 必填空值
- `session/src/entry-validation.ts`：`validateSessionEntries` 纯函数校验，9 种错误分类（duplicate-id、duplicate-sequence、non-positive-sequence、self-parent、missing-parent、parent-after-child、dangling-tool-call、dangling-source-leaf、dangling-first-kept），一次报告全部违规
- 测试：`test/core/model.test.ts`、`test/session/entries.test.ts`、`test/session/entry-validation.test.ts`

### Batch 2：`feat(session): add session store contract and lifecycle`

- `session-store.ts`：新契约 `createSession`/`loadSession`/`getMetadata`/`updateMetadata`/`close` + `SessionSnapshot`（完整快照）+ 错误类（`SessionStoreError` 八类 kind、`SessionNotFoundError`、`SessionStoreClosedError`）+ deprecated 线性入口
- SQLite 最终 schema：`sessions`（10 列）+ `session_entries`（复合主键、UNIQUE(entry_seq)、parent 自引用、json_valid、DEFERRABLE）；连接配置 `foreign_keys=ON`/`WAL`/`synchronous=FULL`/`busy_timeout=5000`
- `entry-codec.ts`：Entry↔SQLite 行编解码 + deprecated 消息映射（**消息 id 保留 = Entry ID**，M2.2；AgentLoop checkpoint 去重依赖它）
- 删除旧测试 `session-store.test.ts`、`session-store-history.test.ts`、`deprecated-linear-adapter.test.ts`（用户授权）
- 双实现共用 `test/session/store-contract.ts`

### Batch 3：`feat(session): add transactional turn and checkpoint commits`

- `setRuntimeCheckpoint`/`clearRuntimeCheckpoint`：单语句 `json_set`/`json_remove` + RETURNING，形状无关（checkpoint 结构由 M7 Runtime 定义）
- `commitTurnEntries({ sessionId, expectedLeafId, entries })`：BEGIN IMMEDIATE 内校验 leaf → 连续分配 seq → 批量插入 → 推进 leaf/seq → 清除 runtime_checkpoint，全有或全无
- `SessionLeafConflictError`（leaf 过期，D 级）；B3 初版 `PendingTurnEntry` 允许省略 id/createdAt 并由 Store 推导 parent，B10b 将按已确认的最终 checkpoint 契约替换为稳定 `PendingSessionEntry`
- 恢复提交复用同一 commitTurnEntries（补"未知 ToolResult"的物化逻辑在 M7 Runtime）

### Batch 4：`feat(session): rebuild active path and replay state`

- `session-tree.ts`：`SessionTree` 建 id→entry 索引，`rebuildActivePath()` 严格失败检测（leaf-missing/parent-missing/parent-seq-order/invalid-entry-structure/parent-cycle 防御）
- `state-replay.ts`：`replayRuntimeState(snapshot, leafId)` → `ModelState`（leaf 向上追溯，最近状态 Entry 生效，可提前终止）
- `RuntimeEnvironment.canExecute` 注入端口 + `defaultRuntimeEnvironment`（恒可用）；`SessionCorruptedError`（B 级）——注：`RuntimeEnvironment` 于 B8 迁入 agent（见决策 5）
- 注：`parent-cycle` 在合法 seq 下不可达（被 parent-seq-order 拦截），代码保留作防御

### Batch 5：`feat(session): build provider context and direct navigation`

- `context-builder.ts`（后移入 agent）：`mapEntriesToMessages`（Entry→Message，wrapper 固定、Entry ID 作 Message ID）、`selectEffectiveContextEntries`（`[C]+[K..C)+(C..leaf]`，firstKeptEntryId 合法性）、`buildProviderContext`（M4.9 流水线）
- `tree-navigation.ts`：`listTreeTargets`（M5.1 可见/可选规则）、`navigateDirectly`（user→parent 归一化+草稿、no-op、stale 错误）
- `updateLeaf` 单语句原语（双实现）；`SessionNavigationError`
- **未改 agent 的旧 ContextBuilder**（决策 3：M7 迁移时改）

### Batch 6：`feat(session): fork a path into an independent session`

- `fork.ts`：`forkSession`（路径提取+复制+引用归一化+原子创建）
- `createSessionWithEntries` Store 原语（原子创建 session+插入 entries+设 leaf/seq；**空 entries 合法**=空 fork 路径）
- `ForkValidationError`；复制保留 id/content/createdAt，seq 重排，路径外 sourceLeafId/firstKeptEntryId → null

### Batch 7：`feat(session): add summary infrastructure in agent layer`

- 全部在 agent 包（见上架构决策 1）
- `computeSummaryInterval`：跨分支/祖先/退化（same-leaf/no-branch-leave/unknown-entry）；`(T,S]` 至少含 S，无字面空区间
- `serializeSummaryInput`：固定标签，状态 Entry 排除，Compaction 最后一次生效
- `executeSummaryWithRetry`：retryable 重试一次+Retry-After+取消；permanent 不重试
- 测试：`test/agent/session-context.test.ts`、`summary-interval.test.ts`、`summary-serialize.test.ts`、`summary-executor.test.ts`

### Batch 8：`feat(session): commit summarized branch navigation`

- **session 包**：`SessionStore.commitBranchSummary` 原语（`CommitBranchSummaryInput/Result`）——BEGIN IMMEDIATE 内重新校验 active leaf 仍为 S（expectedLeafId）→ 插入 `BranchSummaryEntry`（parentId=T、sourceLeafId=S、summary/model/usage）→ 推进 leaf/next_entry_seq/updated_at，全有或全无；**不清除 runtime_checkpoint**（区别于 commitTurnEntries）；空白摘要与非法 parentId（InMemory 显式、SQLite 靠 FK）→ constraint
- **agent 包**：`navigateWithBranchSummary` 领域服务——`listTreeTargets` 目标校验（可见+可选）→ `SessionTree.rebuildActivePath` 严格校验 → `computeSummaryInterval` 区间 → 事务外经 `executeSummaryWithRetry` 生成摘要（source leaf 恢复的 model/thinking、`canExecute` 前置检查、AbortSignal）→ `commitBranchSummary` 提交
  - 退化：same-leaf → `mode:"noop"`（user 回填草稿）；no-branch-leave/empty-interval → `mode:"direct"` 直接导航；摘要失败/空摘要**不**自动降级
  - 错误：SessionNotFoundError / SessionNavigationError / SessionCorruptedError / SessionLeafConflictError（stale source）/ `BranchSummaryError`（model-unavailable、empty-summary、generation-failed、commit-failed+prepared）
  - 提交失败返回 `prepared`，重试传 `preparedSummary` 跳过模型调用；成功后 reload + rebuildActivePath + buildProviderContext 重建，返回 path/messages/modelState/execution + draft
- `RuntimeEnvironment` 迁入 agent（决策 5）
- 测试：`test/session/store-contract.ts`（+6 契约用例，双实现共享）、`test/agent/branch-summary.test.ts`（20 用例）

### Batch 9：`feat(agent): add token budgeting and compaction triggers`

- `packages/agent/src/token/model-capabilities.ts`：按精确 `(provider, modelId)` 匹配的模型能力表；未知模型不假定 context window，也不启用阈值自动压缩。
- `packages/agent/src/token/token-estimator.ts`：消息、tool definitions/schema、system prompt 的本地 token 估算；ASCII/非 ASCII 保守估算、固定协议开销、tool-call 参数稳定序列化，以及 usage 锚点估算。
- `packages/agent/src/token/token-budget.ts`：`reserveTokens`/`keepRecentTokens`/`maxSummaryOutputTokens` 预算计算、压缩阈值判定、未知模型策略和超预算错误。
- provider usage 归一化：扩展 provider response/stream usage，并在 OpenAI provider 中解析 usage。
- 测试：`test/agent/model-capabilities.test.ts`、`test/agent/token-estimator.test.ts`、`test/agent/token-budget.test.ts`、`test/agent/openai-chat-provider.test.ts` 以及 core model 测试。
- 边界：本 Batch 只产出压缩决策，不写 `CompactionEntry`；真实 compaction 提交和 Runtime 消费留在 Batch 10/下游 Runtime。

### Batch 9 当前未闭合项

- `AgentRunner` 目前仍只向上返回 message/stopReason，provider 返回的 usage 尚未完整接入 AssistantEntry/session 持久化。
- `shouldCompact` 尚未接入完整 Turn 前置决策和实际压缩流程。
- `SummaryModelPort` 仍只有接口，provider 桥接适配器按决策归入下游 Runtime 分支实现。

### Batch 10a：Compaction 压缩算法（纯计算）

- `packages/agent/src/compaction/compaction-planner.ts`：`planCompaction` 基于有效活动上下文与 `keepRecentTokens` 选择切点；状态 Entry 不参与 token 切点，ToolResult 切点回退到产生它的 AssistantEntry，必要时把同一用户交互的前缀并入摘要输入。
- 增量摘要：只携带最近 Compaction 的 `previousSummary` 与本次新增被压缩内容，不重新展开已被旧摘要替代的历史；摘要输入超过 `summaryInputBudget` 时返回 `summary-input-overflow`。
- `packages/agent/src/compaction/compaction-summary.ts`：固定 Goal、Constraints、Progress、Key Decisions、Files、Errors、Next Steps、Critical Context 八段摘要结构，并明确历史内容只可总结、不可继续执行。
- `selectEffectiveContextEntries`：原 `applyCompaction` 重命名为语义更准确的有效上下文选择函数，仍按最后一个 Compaction 的 `firstKeptEntryId` 执行 `[C] + [K..C) + (C..leaf]` 裁剪。
- API 收敛：交互前缀仅作为 planner 内部的 `readonly SessionEntry[] | null` 临时值，不导出同构的 segment/prefix 类型，也不暴露在 `CompactionPlan` 中。
- 测试：`test/agent/compaction.test.ts` 共 10 个用例，覆盖 User/Assistant 切点、完整 tool batch、多 User 交互、交互前缀、状态 Entry、旧摘要增量合并、固定 prompt、ToolResult 截断、摘要输入溢出和 no-op。
- 边界：本 Batch 只产出纯 `CompactionPlan`，不调用摘要模型、不写 `CompactionEntry`、不移动数据库 leaf，也不接管 Runtime checkpoint。

### Batch 10b-Turn：Pending Entry 契约与 Turn 最终提交（本次提交）

- `PendingSessionEntry` 统一为 `DistributiveOmit<SessionEntry, "sequence">`；进入 checkpoint 前已冻结稳定 `id`、`createdAt` 和 `parentId`。
- `commitTurnEntries` 在 InMemory/SQLite 中只分配 `sequence`，不再生成 ID、时间或重新推导 parent。
- 两种 Store 共用 pending 链校验：稳定 ID、重复 ID、连续 parent、持久化引用，以及同批更早 pending Entry 的 `firstKeptEntryId`；完整校验通过后才开始写入。
- SQLite Turn 提交使用 `BEGIN IMMEDIATE`、批量 Entry 写入、leaf/sequence 更新和 checkpoint 清理；受影响行数异常时回滚。
- 迁移 Store contract、fork、tree navigation 和 SQLite 持久化测试；新增空批、非连续 parent 链、同批 Compaction 引用场景。

## 当前基线

- 测试：56 文件 / 696 测试全绿（直接运行已安装的 Vitest；`pnpm` wrapper 因 Corepack 网络限制未使用）
- `tsc -b`、测试类型检查、`eslint`、Prettier 检查均通过
- Git 状态：B10a（`4a36011`）、B10b-session（`80fff2a`）和计划文档（`7c33e3b`）已提交；B10b-Turn 随本次提交完成，B10b-agent 尚未开始

## 下一步（Batch 10b-agent：Compaction 领域服务与 overflow 归一化）

在本次 Turn 契约冻结的基础上，按 plan 中剩余场景继续完整 RED → GREEN：

- **agent 包**：在 B10a 的纯规划结果上实现 pending Compaction 准备、空闲期 Compaction 领域服务、prepared 重试和 provider overflow 归一化。
- **上下文与恢复**：压缩后重建有效 provider context；Turn 内只产出可由 Runtime 消费的 pending 结果，不提前移动数据库 leaf。
- **session 包**：复用已完成的 `commitCompaction` 与 `commitTurnEntries` 契约，不在本阶段重新扩大 Store 职责。
- **契约收口**：补齐 Summary `instructions`、`maxOutputTokens`、provider-neutral overflow 和对应 public exports；完成后再进入 `feat/session-runtime`。
- 流程：每个 Batch 开始前 briefing + 等用户确认；GREEN 后报告 + 等 review + 授权后才提交
