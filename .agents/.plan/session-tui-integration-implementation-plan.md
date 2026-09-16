# Session CLI/TUI 集成与交付实现计划

- 状态：待实现
- 实现分支：`feat/session-tui`
- 对应设计：[`../.design/session-tui-integration.md`](../.design/session-tui-integration.md)
- 依赖计划：[`session-tree-compaction-implementation-plan.md`](./session-tree-compaction-implementation-plan.md)、[`session-runtime-implementation-plan.md`](./session-runtime-implementation-plan.md)

## 1. 目标与前置条件

本分支把已冻结的 AgentRuntime 接入 CLI/TUI，完成 M8 的分层迁移，并对 M9 的全链路验收和旧界面接口做最终收口。

开始前必须满足：

- 前两个分支已完成或本分支基于它们的最终提交；
- AgentRuntime、RuntimeEvent、OperationHandle、Interaction 和 SessionSnapshot 契约已冻结；
- Controller 不再需要通过兼容 API直接驱动旧 AgentLoop。

完成后，CLI 是唯一 composition root，Controller 只处理 typed intent 与事件投影，`@byte-mentor/tui` 只渲染 view data。

## 2. Batch 执行方式

- 一个 Batch 是一次连续 TDD、完整验证和人工 review 的最小单位，也是建议 commit 边界。
- Batch 内先建立失败测试，再连续实现至 GREEN；不按 RED/GREEN、小组件或单个快捷键停顿。
- 测试和生产代码同批完成。影响编译的 contract 与消费者迁移不得拆开。
- 每批结束运行相关测试、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`；最终 Batch 运行全量测试和 build。
- 没有明确授权时不执行 `git commit`；只有遇到会改变已冻结 Runtime 契约的缺口才暂停回到设计。

## 3. Batch 1：Controller 投影与 Session View 整体迁移

建议 commit：`feat(tui): project agent runtime into session views`

### 范围

- `apps/cli/src/interactive-chat-controller.ts` 及其测试。
- `packages/tui/src/**`：ChatSessionView、ChatPresentationEvent、ViewState reducer 和 transcript 组件。
- `test/cli/**`、`test/tui/**`，Controller 使用 fake AgentRuntime。

### 目标

- Controller 只保存前台 sessionId 和应用生命周期状态，把文本/快捷键转换为 typed intent。
- 实现 `replaceSession(snapshot)` 与 `applyPresentation(event)` 两条 View 输入；结构变化始终重新读取 Snapshot。
- 把 RuntimeEvent 投影为 TUI 专用 ChatPresentationEvent，TUI 不直接依赖 agent/runtime 内部协议。
- 实现 home/idle/queued/running/compacting/command_waiting/stopping/error 状态和 reducer。
- 支持 User queued/running/persisted、Assistant stream、Tool card，以及 Compaction/BranchSummary 专用 transcript 展示。
- Turn 运行期间编辑器保持可输入；只有 modal selector 和退出期间锁定。

### 测试

- Controller typed intent、按 session/operation/turn 关联事件，跨 Session 事件不污染前台 View。
- Snapshot replace 覆盖打开、Turn 提交、导航、压缩和恢复后的权威 transcript。
- queued/running/persisted 转换，stop discarded 后移除非持久化卡片。
- Assistant delta/complete、tool 临时状态和最终 Snapshot reconciliation。
- Compaction/BranchSummary、状态 Entry 隐藏、CJK/emoji/窄终端渲染。
- View 增量失败时丢弃临时状态并只尝试一次完整 Snapshot 重建。

### Review 重点

- Controller 是否不再拼接权威历史或持有 Turn AbortController。
- `@byte-mentor/tui` 是否只依赖 view 类型，没有导入 AgentLoop、MessageBus 或 SessionStore。
- presentation 增量是否可被 Snapshot 完整覆盖，不承担恢复职责。
- 运行中输入和 queued 卡片是否清楚表达“尚未持久化”。

## 4. Batch 2：命令交互、Tree/Fork Selector 与 Session 生命周期

建议 commit：`feat(tui): add session navigation and lifecycle interactions`

### 范围

- Controller slash/keyboard intent、interaction response 和 session switch 流程。
- `packages/tui/src/**` 的 Tree/Fork selector、状态提示和 editor 协作。
- `test/cli/**`、`test/tui/**` 与 virtual terminal 测试。

### 目标

- 实现普通文本、`/stop`、`/tree`、`/fork`、`/compact`、model/thinking、`/new`、本地展示命令和未知命令分类。
- 命令先提交 Runtime 建立 barrier，收到 `interaction.requested` 后才打开 selector。
- Tree selector 支持上下选择、Enter、Esc 和 direct/summary 二次选择；展示节点由领域 Snapshot 提供，不在 TUI 重算可导航性。
- Fork 成功后切换新 Session 并回填 User 草稿；Tree/Compact/状态命令完成后重新加载 Snapshot。
- 实现 Home 延迟创建、`/new` 回 Home、首次 `session.created` 后正式切换 currentSessionId。
- 实现运行中 Ctrl+C 等价 stop、空闲 Ctrl+C 退出、空编辑器 Ctrl+D 退出。
- persistence retry interaction 只展示“重试提交”和“退出应用”。

### 测试

- slash parsing 与本地/Runtime 命令边界，未知命令不发送给模型。
- selector 只能在 Runtime 请求后打开，等待期间 editor/modal 状态正确；Esc 不改变 Session。
- direct/summary、User 草稿、stale target、Fork 新 Session、Compact 和 model/thinking 切换后的 Snapshot。
- Home 首发成功/失败、`/new`、Fork switch 和 provisional Session 行为。
- stop 丢弃 queued presentation、barrier 后消息保留，以及 Ctrl+C/Ctrl+D 的空闲/运行态差异。
- persistence retry、Session corrupted 只读提示和返回 Home。

### Review 重点

- selector 是否只是 Runtime interaction 的表现层，没有抢先读取/修改 Session。
- 命令 barrier 是否由 Runtime 建立，Controller 没有本地模拟顺序。
- currentSessionId 是否只在持久化创建或 Fork 成功后更新。
- 错误状态是否提供设计允许的动作，没有“跳过持久化继续”入口。

## 5. Batch 3：Composition Root、关闭流程与全链路验收

建议 commit：`feat(cli): complete agent runtime tui integration`

### 范围

- `apps/cli/src/run-chat.ts`、`index.ts`、配置与资源组装。
- Controller/TUI 最终 public API 清理。
- `test/cli/**`、`test/tui/**` 以及真实 SQLite + fake provider/tools + virtual terminal 端到端测试。
- README 中受最终行为影响的运行说明。

### 目标

- CLI 组装 SessionStore、领域服务、AgentRuntime、Controller 和 TUI；移除 Controller → AgentLoop 直连。
- 统一 RuntimeEvent 订阅、前台 session 过滤和结构变化后的 Snapshot reload。
- 接入幂等 close：Controller 先请求 Runtime 收口，最后停止 TUI，并映射正常/失败退出码。
- Snapshot 重建再次失败时有序进入应用致命关闭；单个未知展示数据使用明确 fallback。
- 删除旧 Controller/TUI stream callback、busy 丢输入、线性 transcript mutation 和其他兼容接口。
- 完成设计 M9 §2.8 的 16 个关键场景全链路验收；底层场景可以复用前两个分支测试，TUI 分支补齐用户可观察结果。

### 测试

- composition root 依赖方向：TUI 不依赖 agent/session，CLI 是唯一组装层。
- 跨 Session RuntimeEvent 交错、前台切换、Snapshot 重建和 presentation failure fallback。
- close 正常、10 秒超时、未响应 interaction、资源失败、重复调用和退出码。
- virtual terminal 覆盖连续补充输入、stop、Tree/Fork/Compact、Home/New、错误提示与退出键。
- 真实 SQLite reopen 覆盖 crash recovery 后的 transcript，并验证无旧 messages/schema/API 路径。
- 全量测试不访问真实 provider 网络，不依赖 sleep 竞争。

### Review 重点

- 依赖方向是否保持 `core ← session ← agent ← cli`，TUI 只由 CLI 驱动。
- 所有结构性 UI 变化是否以 Snapshot 为最终真值。
- 关闭顺序是否确保 Runtime 先收口、TUI 最后停止，失败退出码可预测。
- legacy API 和双通道事件是否已完全删除，没有保留长期兼容层。

## 6. 分支完成标准

- 三个 Batch 全部 GREEN，执行 `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`。
- M9 §2.8 的验收矩阵全部由分层测试或端到端测试覆盖，并能定位到所属分支。
- AgentRuntime 是 CLI 唯一运行时入口，Controller/TUI 不直接访问 AgentLoop、MessageBus 或 SessionStore。
- 新数据库运行路径中不存在 legacy `messages` 表、旧 checkpoint phase、双写或旧 stream callback。
- README 与实际 Home、输入、命令、取消和退出行为一致。

## 7. 非目标

- 多标签、后台 Session 面板或 Session picker。
- Tree 搜索、额外过滤、标签、书签和节点复制。
- 持久化 RuntimeEvent、streaming partial 或 queued presentation state。
- 扩展首版命令集合、主题系统或摘要配置 UI。
