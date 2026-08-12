# Session Tree & Compaction 实现进度

- 分支：`feat/session-tree-compaction`
- 计划：[`.agents/.plan/session-tree-compaction-implementation-plan.md`](../.plan/session-tree-compaction-implementation-plan.md)
- 设计：[`.agents/.design/session-tree-compaction.md`](../.design/session-tree-compaction.md)（M1～M6）
- 状态：**Batch 1～8 已完成并提交；Batch 9 尚未开始（未 briefing）**

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
| 9 | Token 预算与压缩决策 | — | ⬜ 未开始 |
| 10 | Compaction 垂直切片与契约冻结 | — | ⬜ 未开始 |

## 重要架构决策（实现中用户确认，已偏离原始计划）

### 1. 压缩/摘要生成语义全部归 agent 层（B7 时确认）

用户明确："session 不应该带有压缩语义的逻辑，它属于 agent 层"。最终划分：

- **agent 包**（`packages/agent/src/`）：
  - `summary/summary-interval.ts`：`computeSummaryInterval`（LCA、(LCA,S] 区间）
  - `summary/summary-serialize.ts`：`serializeSummaryInput`、`truncateToolResultForSummary`（2000 字符）
  - `summary/summary-port.ts`：端口类型 `SummaryModelPort`/`SummaryRequest`/`SummaryResponse`/`SummaryError`（三分类 retryable/permanent/cancelled）
  - `summary/summary-executor.ts`：`executeSummaryWithRetry`（重试一次、Retry-After、取消）
  - `summary/branch-summary.ts`：`navigateWithBranchSummary` 领域服务 + `BranchSummaryError`（四分类）+ `PreparedBranchSummary`（B8）
  - `context/session-context.ts`：`mapEntriesToMessages`/`applyCompaction`/`buildProviderContext`（原 session 的 context-builder 整体移入，M4.9 流水线）
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
- **待办（M7 Runtime 分支）**：在 agent 包新建 provider 桥接适配器（如 `summary/provider-summary-adapter.ts`），把 `SummaryRequest`（historyText + model/thinking）映射为 `ProviderRequest`，调用 `invoke` 并把输出映射为 `SummaryResponse`（文本 + usage）；取消接 `ProviderInvocationOptions.signal`。M7 Runtime 组装时经 `summarize` 注入。

### 5. `RuntimeEnvironment` 从 session 迁入 agent（B8 用户确认）

- 原 `RuntimeEnvironment`/`defaultRuntimeEnvironment` 定义在 `session-store.ts`（B4 遗留：当时 context-builder 还在 session 包）。
- B7 上下文重建迁入 agent 后全部消费方都在 agent，session 包零引用；真实实现（B9 ModelCapabilities + provider 栈、M7 注入）也注定在 agent。
- 已迁至 `packages/agent/src/runtime/runtime-environment.ts`（新建 `runtime/` 目录预留 M7）；`ModelState` 留在 session（`replayRuntimeState` 的返回类型，状态回放领域产物）。测试导入同步更新。

### 6. B8 实现细节（用户 briefing 中已确认，执行中落实）

- `RebuiltNavigationContext`（path/messages/modelState/execution）以扁平字段展开进 `navigateWithBranchSummary` 成功结果，而非嵌套 `context` 对象。
- `unknown-entry` 区间结果 → `SessionCorruptedError("parent-missing")`（活动路径已通过重建校验，剩余只可能是目标祖先链缺失）。
- 摘要文本 trim 后存储；`PreparedBranchSummary` 只含 summary/model/usage，重试时重新校验目标与区间。

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
- `SessionLeafConflictError`（leaf 过期，D 级）；`PendingTurnEntry`（DistributiveOmit 保留 union 收窄，id/createdAt 可省略）
- 恢复提交复用同一 commitTurnEntries（补"未知 ToolResult"的物化逻辑在 M7 Runtime）

### Batch 4：`feat(session): rebuild active path and replay state`

- `session-tree.ts`：`SessionTree` 建 id→entry 索引，`rebuildActivePath()` 严格失败检测（leaf-missing/parent-missing/parent-seq-order/invalid-entry-structure/parent-cycle 防御）
- `state-replay.ts`：`replayRuntimeState(snapshot, leafId)` → `ModelState`（leaf 向上追溯，最近状态 Entry 生效，可提前终止）
- `RuntimeEnvironment.canExecute` 注入端口 + `defaultRuntimeEnvironment`（恒可用）；`SessionCorruptedError`（B 级）——注：`RuntimeEnvironment` 于 B8 迁入 agent（见决策 5）
- 注：`parent-cycle` 在合法 seq 下不可达（被 parent-seq-order 拦截），代码保留作防御

### Batch 5：`feat(session): build provider context and direct navigation`

- `context-builder.ts`（后移入 agent）：`mapEntriesToMessages`（Entry→Message，wrapper 固定、Entry ID 作 Message ID）、`applyCompaction`（`[C]+[K..C)+(C..leaf]`，firstKeptEntryId 合法性）、`buildProviderContext`（M4.9 流水线）
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

## 当前基线

- 测试：52 文件 / 638 测试全绿（`pnpm test`）
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check` 通过
- Git 状态：工作区干净（B8 已提交，含本进度文件）

## 下一步（Batch 9：Token 预算与压缩决策）

按更新后的计划（全部在 agent 包 + test/agent）：

- **agent 包**：ModelCapabilities 表、token 估算、预算与阈值、触发决策（压缩决策属于 agent 层）
- **agent 包**：provider usage 归一化的必要扩展
- 目标：内置 `(provider, modelId)` 精确匹配的 `ModelCapabilities`；未知模型不启用阈值自动压缩、不假定默认窗口；usage 锚点（真实 usage 优先、cachedInputTokens 不重复计入、锚点失效重新全量估算）；本地估算（ASCII chars/4、非 ASCII 保守、固定协议开销、tool-call 稳定序列化）；动态 reserveTokens/keepRecentTokens/maxSummaryOutputTokens 与触发阈值；压缩后重估仍超阈值时阻止请求
- 明确边界：本 Batch 只产出压缩决策，不写 Entry（提交在 B10）
- 流程：每个 Batch 开始前 briefing + 等用户确认；GREEN 后报告 + 等 review + 授权后才提交
