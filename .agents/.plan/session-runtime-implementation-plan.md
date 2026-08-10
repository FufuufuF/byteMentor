# Session Runtime 与调度实现计划

- 状态：待实现
- 实现分支：`feat/session-runtime`
- 对应设计：[`../.design/session-runtime.md`](../.design/session-runtime.md)
- 横切要求：[`../.design/session-tui-integration.md`](../.design/session-tui-integration.md) 的 M9
- 依赖计划：[`session-tree-compaction-implementation-plan.md`](./session-tree-compaction-implementation-plan.md)
- 下游计划：[`session-tui-integration-implementation-plan.md`](./session-tui-integration-implementation-plan.md)

## 1. 目标与前置条件

本分支在已冻结的 Tree/Compaction 契约上实现 M7，并承担 M9 中属于 Runtime 的错误恢复、持久化 reconciliation 和关闭行为。

开始前必须满足：

- `feat/session-tree-compaction` 已完成或本分支明确基于其最终提交；
- SessionEntry、SessionStore 原子操作、Context/Navigation/Compaction 服务契约已经冻结；
- deprecated 线性 Store API 只作为迁移起点，不再新增使用者。

完成后，应用层只需通过 AgentRuntime 即可提交消息/命令、停止 Turn、响应 interaction、读取 snapshot、订阅事件和关闭资源。

## 2. Batch 执行方式

- 一个 Batch 是一次连续 TDD、一次完整验证和一次 review 的最小单位，也是建议 commit 边界。
- RED→GREEN 在 Batch 内完成，不按单个测试、类、文件或状态机步骤暂停。
- 测试、生产代码和必须同步迁移的消费者放在同一个 Batch；每个 Batch 结束时仓库必须 GREEN。
- 每个 Batch 结束运行相关测试、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`；分支收口运行全量测试和 build。
- 没有用户明确授权时不执行 `git commit`。遇到设计未覆盖的公共协议或 durable boundary 决策才暂停。

## 3. Batch 1：Durable Runtime Turn 与崩溃恢复

建议 commit：`feat(agent): run durable checkpointed turns`

### 范围

- `packages/agent/src/loop/**`、`packages/agent/src/runner/**`、provider/context 接入点和 public exports。
- `packages/session/src/**` 中冻结 Store 契约的必要实现修正。
- `test/agent/**`、`test/session/**` 中 Runtime Turn 与 reopen 集成测试。

### 目标

- 用最终 `RuntimeCheckpoint(version: 1)` 和 `ready_for_iteration | awaiting_tools` 替换旧 `pending_user_turn` 与旧 checkpoint phase。
- 建立从首条 User 开始的稳定 pending Entry 链；新 Session 创建和首 checkpoint 原子完成。
- 落实 streaming partial 不持久化、完整 Assistant 才入链、执行工具前 checkpoint、完整 ToolResult 批次后 checkpoint。
- 实现 completed/cancelled/failed/max-iterations 的内存终态链和最终原子提交。
- 实现两种 checkpoint 的保守恢复：不续跑旧 ReAct、不重试工具，未知副作用生成固定 ToolResult 后提交。
- 把 turn 间/Turn 内 Compaction 接到 provider 前 safe point，支持 overflow 后基于最近稳定 checkpoint 压缩并只重试一次。
- 保持 AgentRunner 不依赖 SessionStore；AgentLoop 负责 durable boundary 与领域服务编排。

### 测试

- 首条 User checkpoint 失败不调用 provider；完整 Assistant、tool batch 和 Compaction 的 checkpoint 顺序。
- `ready_for_iteration`/`awaiting_tools` reopen 恢复、稳定 ID/parent、未知工具结果和恢复事务幂等。
- partial stream/partial tool arguments 丢弃，完整 done 才生成 Entry。
- completed/cancelled/failed/max-iterations、取消工具批次、最终事务失败后不重复外部副作用。
- Turn 内 Compaction durable boundary、自动压缩失败和 overflow 单次恢复。
- InMemory 与真实 SQLite 的端到端 Runtime Turn。

### Review 重点

- checkpoint 是否只表示稳定恢复点，是否没有保存 streaming 或工具执行中的瞬时状态。
- provider、工具、摘要模型调用是否都在 SQLite 事务外。
- 最终事务是否同时物化完整链、推进 leaf/sequence 并清除 checkpoint。
- 恢复是否保守表达未知副作用，绝不自动重试工具。

## 4. Batch 2：Mailbox、补充消息、命令 barrier 与 Stop

建议 commit：`feat(agent): schedule session mailboxes and mid-turn input`

### 范围

- `packages/agent/src/runtime/**` 或等价 Runtime 内部模块。
- AgentLoop/Runner 的 admission、safe point 与 ActiveTurn 接口。
- `test/agent/**` 中可控并发、队列和取消测试。

### 目标

- 实现 MessageBus 内部的 per-session mailbox；单 worker 即 Session 逻辑 writer，不新增通用 SessionLock。
- 同一 Session 严格串行，不同 Session 默认最大并发 4，测试可覆盖配置。
- 实现 normal/control/session-command 分类和 command barrier；MessageBus backlog 不设上限，`pendingQueue` 容量为 3。
- 在 provider 前安全点一次认领当前 1～3 条补充消息，按到达顺序合并成一条 UserEntry；checkpoint 成功后才删除快照。
- 实现终态 admission 与 seal 的同步裁决，避免消息进入已经无人消费的 pendingQueue。
- 实现 `/stop` 绕过 backlog：取消 ActiveTurn，并丢弃尚未 checkpoint、且位于首个 command barrier 之前的补充消息。
- 普通异常收口后，将剩余 pendingQueue 按内部顺序合并成一条 normal message 追加 mailbox 队尾；不恢复原始全局到达位置。

### 测试

- 同 Session 永不并发；多 Session 峰值不超过 4，且一个 Session 等待不阻塞其他 Session。
- pendingQueue 容量、超额 backlog 逐条 admission、同一安全点合并和 checkpoint 失败不删除快照。
- command barrier 前后 normal message 的顺序、等待期间无 SQLite 长事务。
- 终态消息与 seal 竞态使用 controllable promise/barrier 验证，不使用 sleep。
- stop 的绕过、丢弃范围、已 checkpoint User 保留和 barrier 后 envelope 保留。
- 普通异常重新打包到队尾，stop 不重新入队。

### Review 重点

- MessageBus 是否保持 AgentRuntime 私有，同一 Session 是否只有一个业务 writer。
- claim 是否只是不可变队首快照，没有引入 ack/nack 或 arrival-sequence 状态机。
- barrier、seal 与 publish/admission 是否有清晰的同步临界区。
- stop 和普通异常是否遵循不同的补充消息处理规则。

## 5. Batch 3：AgentRuntime、命令执行、事件与 Snapshot

建议 commit：`feat(agent): expose typed agent runtime`

### 范围

- `packages/agent/src/runtime/**`、SessionCommandExecutor、RuntimeEventHub 和 public exports。
- `packages/core/src/**` 中 RuntimeEvent 移出后的共享类型清理。
- 领域命令适配及 `test/agent/**` Runtime contract/integration 测试。

### 目标

- 实现设计 M8 的 AgentRuntime 公开接口、OperationHandle 和 provisional Session ID 流程。
- normal message 路由到 AgentLoop，typed command 路由到 SessionCommandExecutor；`/tree`、`/fork`、`/compact`、状态变更和 `/new` 共享 mailbox 串行边界。
- 实现 Tree/Fork 的 `interaction.requested → respondToInteraction` 协议，等待用户时持有逻辑 writer但不持有数据库事务，并在响应后重新校验目标。
- 将 stream、tool、checkpoint、compaction、command 和 session 事实统一发布为 RuntimeEvent；listener 异常彼此隔离。
- 实现权威 SessionSnapshot，供打开、导航、压缩、恢复和 Turn 提交后重建 UI。
- RuntimeEvent 从 `@byte-mentor/core` 移到 `@byte-mentor/agent`，core 只保留 provider-neutral 共用值对象。

### 测试

- AgentRuntime public contract、OperationHandle 生命周期、publish 非 durable 与 checkpointed 事件。
- typed command 顺序、Tree/Fork interaction 取消/成功/stale target、Fork 新 Session 返回。
- RuntimeEvent 必需关联字段、同 Session 顺序、跨 Session 交错和 listener 隔离。
- Snapshot 对完整 Entry、有效 transcript、运行状态、queued/running input 和 Session 损坏状态的投影。
- provisional Session 创建失败时不产生正式 current Session。

### Review 重点

- Controller 未来是否无需访问 MessageBus、AgentLoop、SessionStore 或 pendingQueue。
- RuntimeEvent 是否是观察事实而非恢复来源，Snapshot 是否是 UI 重建权威。
- Session command 是否复用同一 mailbox writer，没有另建锁或并发通道。
- public union 是否完整而不过度暴露内部队列和 checkpoint 实现。

## 6. Batch 4：持久化阻塞、错误边界、幂等关闭与旧接口清理

建议 commit：`feat(agent): harden runtime failure and shutdown semantics`

### 范围

- AgentRuntime、AgentLoop、SessionCommandExecutor 的失败/关闭路径。
- Store reconciliation 调用与错误分类映射。
- 相关 `test/agent/**`、`test/session/**` 和分支级端到端测试。
- legacy API、旧 checkpoint 类型和直接 stream callback 的删除。

### 目标

- 实现应用致命、Session 损坏、等待持久化、当前操作失败四级边界。
- 对 busy timeout 后的持久化失败只自动重试一次；结果不明确时先读取 checkpoint/Entry/leaf 做 reconciliation。
- 已提交视为成功、未提交复用相同 ID/最终链重试、矛盾状态标记 Session corrupted；不重新调用 provider、工具或摘要模型。
- unresolved persistence 通过 interaction 只允许“重试提交”或“退出”，当前 mailbox operation 保持占用。
- 实现幂等 `AgentRuntime.close()`、10 秒 grace period、ActiveTurn seal/cancel、interaction 取消、资源尽力清理和聚合错误结果。
- 删除 deprecated 线性 Store API、`pending_user_turn`、旧 checkpoint phase、公开的直接 stream callback 和不再使用的兼容代码。
- 冻结 Runtime → TUI 的 AgentRuntime、RuntimeEvent、OperationHandle、Interaction 和 SessionSnapshot 契约。

### 测试

- busy 一次重试与 fake clock；capacity/read-only/io/unknown 直接进入 persistence blocked。
- reconciliation 的已提交、未提交、部分/矛盾三类结果，以及相同 ID 重试。
- corrupted Session 只读且不影响其他 Session；普通 provider/tool/summary 失败不升级为应用退出。
- close 重入返回同一 Promise；正常、超时、工具/Store 清理失败仍执行完整清理并保留 checkpoint。
- 旧 public API 无法再导入，现有调用方全部迁移；全仓没有 legacy messages/checkpoint 双写。
- M9 中属于 Runtime 的关键验收场景全部通过。

### Review 重点

- 持久化不确定状态是否先 reconciliation，是否没有盲目重放外部副作用。
- Session corrupted 与 persistence blocked 是否有不同的后续行为。
- close 是否停止新输入、尽力收口并在超时后保留可恢复状态。
- 旧 API 是否真正删除，而不是保留长期 adapter 或 feature flag。

## 7. 分支完成标准

- 四个 Batch 全部 GREEN，执行 `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`。
- M7 与 M9 Runtime 验收场景有可控 fake provider/tools 和真实 SQLite 覆盖，不依赖真实网络或时间 sleep。
- AgentRuntime 是应用唯一高层入口；MessageBus、mailbox、checkpoint 和 ActiveTurnHandle 均未泄露给 CLI/TUI。
- 下游接口冻结后，才开始 `feat/session-tui`。

## 8. 非目标

- TUI 组件、selector 视觉和 Controller presentation reducer。
- 持久化 MessageBus backlog、pendingQueue 或 streaming partial。
- 通用锁框架、全局 arrival sequence、ack/nack 状态机。
- 多进程 Session writer、旧数据库迁移和长期兼容模式。
