# Session CLI/TUI 集成与实施收口

- 状态：M8、M9 已确认完成
- 实现分支：`feat/session-tui`
- 依赖：[`session-tree-compaction.md`](./session-tree-compaction.md)、[`session-runtime.md`](./session-runtime.md)
- 总索引：[`session-tree-and-compaction.md`](../.session/session-tree-and-compaction.md)

> M8 已确认目标分层、公开接口、命令流、事件路由和 TUI 状态模型；M9 已确认错误边界、测试矩阵、实施批次、接口冻结与合并顺序。

## 1. M8 分层架构与 CLI/TUI 集成（已确认）

### 1.1 当前问题与目标架构

当前 `InteractiveChatController` 同时维护 Session/Turn 状态、AbortController、流式事件映射、工具卡片和 View mutation；`AgentLoop` 同时承担 Session 恢复、checkpoint、Runner 调用、持久化和事件回调。继续在这两个对象上直接加入 MessageBus、多 Session、command barrier 与 Tree 交互，会让应用层和运行时边界失去控制。

目标架构采用 `AgentRuntime` 作为 CLI 和其他应用调用方的唯一高层入口，不新增职责宽泛的 `SessionManager`：

```text
ByteMentorTui
      ↑ view state / user intent
InteractiveChatController
      ↑ typed input / runtime event
AgentRuntime
  ├─ MessageBus + per-session mailbox
  ├─ SessionCommandExecutor
  ├─ AgentLoop
  │    └─ AgentRunner
  └─ RuntimeEventHub
      ↓
SessionStore / Context / Navigation / Compaction
```

稳定依赖方向为：

```text
@byte-mentor/core ← @byte-mentor/session ← @byte-mentor/agent ← apps/cli
                                                       ↑
                                             @byte-mentor/tui 由 CLI 驱动
```

`@byte-mentor/tui` 不依赖 AgentLoop、MessageBus 或 SessionStore；`apps/cli` 是 composition root，负责组装 Runtime、Controller 和 View。

### 1.2 各层职责

**SessionStore 与 Session 领域服务**

- 只负责 Session/Entry 持久化、活动路径查询和已确认的原子事务。
- 提供 Tree、Fork、Compaction、checkpoint 与 Turn 最终提交所需的存储能力。
- 不感知 Controller、TUI、MessageBus 或 provider。

**AgentRunner**

- 保持 Session 无关，只执行 provider/tool ReAct。
- 接收 working context、工具、`pendingQueue` 和 checkpoint 回调。
- 不知道 mailbox、Session command、Controller 或 TUI。

**AgentLoop**

- 只执行一个已经获得 Session 逻辑 writer 的 Runtime Turn。
- 管理 pending Entry 链、Context/Compaction 接入、AgentRunner、checkpoint、终态和崩溃收口。
- 不解析 slash command，也不负责跨 Session 调度。

**SessionCommandExecutor**

- 在同一 per-session mailbox 中执行 typed session command。
- 负责 Tree、Fork、Compact、model/thinking-level 变化，以及需要等待当前 Session 空闲的 `/new` 顺序操作。
- 与 AgentLoop 共用 Session 串行边界，但命令不进入 ReAct。

**AgentRuntime**

- 是应用层唯一运行时入口。
- 内部拥有 MessageBus、per-session mailbox、ActiveTurnHandle、全局并发控制和 RuntimeEventHub。
- 负责把 normal message 路由给 AgentLoop，把 typed command 路由给 SessionCommandExecutor。

**InteractiveChatController**

- 只保存当前前台 `sessionId` 和应用生命周期状态。
- 把文本与快捷键转换成 typed intent，把 RuntimeEvent 投影为 ViewState。
- 转发 selector interaction，不直接执行 Session 业务逻辑。

**ByteMentorTui**

- 只负责渲染、编辑器、键盘输入和 modal selector。
- 不判断节点是否可导航，不计算活动路径，不直接订阅 RuntimeEvent。

### 1.3 AgentRuntime 公开接口

首版公开形态为：

```ts
interface AgentRuntime {
  submitUserMessage(input: UserMessageInput): OperationHandle;
  submitCommand(input: SessionCommandInput): OperationHandle;

  stop(sessionId: SessionId): void;
  respondToInteraction(response: InteractionResponse): void;

  getSessionSnapshot(sessionId: SessionId): Promise<SessionSnapshot>;
  subscribe(listener: RuntimeEventListener): () => void;

  close(): Promise<void>;
}
```

- `OperationHandle` 提供稳定 `operationId` 和最终结果 Promise；方法返回即表示 envelope 已进入进程内 MessageBus。
- publish 成功不是 durable confirmation。只有 `input.checkpointed` 或相应提交完成事件才表示内容已经稳定持久化。
- MessageBus 不公开给 Controller；Controller 不能直接操作 mailbox、`pendingQueue` 或 ActiveTurnHandle。
- 新 Session 的首次提交可以先在 Runtime 内分配 provisional Session ID；Controller 只有收到 `session.created` 后才把它设为当前 Session。

### 1.4 Session 顺序、逻辑 writer 与全局并发

每个 per-session mailbox 只有一个 drain worker。该 worker 的独占执行权就是 Session 逻辑 writer；首版不额外实现通用 Mutex 或 `SessionLock` 类。

```text
per-session mailbox worker
  ├─ checkpoint recovery
  ├─ Runtime Turn
  └─ Tree / Fork / Compact / state command
```

- 同一 Session 的所有持久化业务操作严格串行。
- 不同 Session 的业务操作最多同时执行 4 个；计数单位是正在执行 Turn 或 Session command 的 Session。
- 该并发值使用 AgentRuntime 内部默认配置，构造时允许覆盖以便测试；首版不提供 CLI 设置。
- `stop` 不占用全局并发名额，直接访问对应 ActiveTurnHandle。
- `pendingQueue` 容量保持 3。
- MessageBus per-session backlog 首版不设第二层容量上限；它是进程内队列，真实进程崩溃时允许丢失。

### 1.5 输入与命令分类

Controller 负责 slash parsing，Runtime 只接收 typed input：

| 输入 | 分类与行为 |
|---|---|
| 普通文本 | publish 为 normal message |
| `/stop` | control，绕过 mailbox |
| `/tree`、`/fork`、`/compact` | session command barrier |
| model/thinking-level 变化 | session command barrier |
| `/new` | 有当前 Session 时作为 barrier，完成后回到 Home；Home 中为本地 no-op |
| `/help` 等纯展示命令 | Controller 本地处理 |
| `/exit`、空编辑器 Ctrl+D | 应用生命周期控制 |
| 未知 slash command | 显示错误，不发送给模型 |

键盘行为固定为：

- Turn 运行中按 Ctrl+C 等价于 `/stop`，停止当前 Turn 但不退出应用。
- Agent 空闲时按 Ctrl+C 退出应用。
- 空编辑器按 Ctrl+D 退出应用。

### 1.6 Tree/Fork 的交互命令协议

Tree/Fork selector 不能在命令 publish 前打开，否则 command barrier 尚未建立，后续 normal message 可能越过命令。

```text
用户输入 /tree
→ Controller publish typed TreeCommand
→ 命令进入 mailbox 并形成 barrier
→ 轮到命令时加载最新 Session 树
→ Runtime 发出 interaction.requested
→ Controller 打开 TUI selector
→ 用户选择目标及 direct/summary
→ Controller respondToInteraction()
→ Runtime 重新校验并执行导航
→ command.completed
→ Controller 重新加载 SessionSnapshot
```

Runtime 等待用户选择期间持有该 Session 的逻辑 writer，但不打开 SQLite 事务；后续消息继续停在 barrier 后。Esc 取消 interaction，不修改 Session。

`/fork` 使用相同协议，但只提供 UserEntry。成功事件返回新 Session ID 和待回填草稿，Controller 随后切换前台 Session。`/compact` 不需要 selector，直接作为 mailbox command 执行。

### 1.7 RuntimeEvent 路由

Provider stream callback 和 RuntimeEvent 不再作为两条公开通道存在。AgentRunner/AgentLoop 将 streaming、tool、checkpoint 和终态统一转换为 RuntimeEvent，由 AgentRuntime 的 EventHub 发布。

共同字段为：

```ts
interface RuntimeEventBase {
  sessionId: SessionId;
  operationId: string;
  ts: number;
}
```

Turn 事件额外携带 `turnId`；Command 事件额外携带 `commandId`。事件类别至少包括：

- input：`queued`、`admitted`、`checkpointed`、`discarded`；
- turn：`started`、`completed`、`failed`、`cancelled`；
- assistant stream：`started`、`delta`、`completed`、`discarded`；
- tool：`declared`、`started`、`completed`、`failed`、`cancelled`；
- compaction/summary：`started`、`completed`、`failed`；
- command：`waiting`、`interaction_requested`、`completed`、`cancelled`；
- session：`created`、`active_leaf_changed`、`recovered`。

事件约束：

- 同一 Session 内事件顺序稳定，不同 Session 的事件允许交错。
- Event listener 异常必须被 EventHub 隔离，不能反向中断 provider、工具或持久化流程。
- RuntimeEvent 是进程内观察事实，不作为恢复来源；`SessionSnapshot` 才是 UI 重建的权威来源。
- `RuntimeEvent` 从 `@byte-mentor/core` 移到 `@byte-mentor/agent`；TUI 不直接消费 RuntimeEvent。

### 1.8 Controller、Snapshot 与 View 接口

Controller 不再直接调用 `AgentLoop.runTurn()`、持有 Turn AbortController、拼接权威 transcript，或根据 ToolMessage 手工决定最终工具卡状态。

TUI 接收两类应用层输入：

```ts
interface InteractiveChatView {
  replaceSession(snapshot: ChatSessionView): void;
  applyPresentation(event: ChatPresentationEvent): void;
}
```

- `replaceSession()` 用于打开/切换 Session、Tree/Fork/Compact 完成、Turn 最终提交、checkpoint 恢复和回到 Home。
- `applyPresentation()` 只处理 streaming delta、tool 临时状态、queued/pending User 和 command/compaction 进度。
- RuntimeEvent 先由 Controller 投影成 UI 专用的 `ChatPresentationEvent`，不把 Agent 内部事件协议泄露到 TUI。
- 发生结构性变化后必须重新请求 `SessionSnapshot`，不能仅靠增量事件猜测权威 transcript。

### 1.9 TUI 状态与补充消息呈现

首版 View 状态集合为：

```text
home
idle
queued
running
compacting
command_waiting
stopping
error
```

普通 Turn 运行期间编辑器保持可输入，以支持补充消息；只有 selector/modal 和应用退出期间锁定编辑器。

用户消息展示状态为：

```text
queued       已进入 MessageBus，尚未 checkpoint
running      已写入 checkpoint，属于当前 Runtime Turn
persisted    Turn 最终事务已提交
```

- 新 Turn 的首条 User 继续遵循 M7：首个 checkpoint 成功后才从编辑器转入 transcript。
- ActiveTurn 期间的补充消息在 MessageBus 接受后转成 queued 卡片，使编辑器可以继续输入；其 memory-only 状态必须明确可见。
- `stop` 丢弃 queued 补充消息后，Controller 移除这些临时卡片，并显示非持久化提示；不写 Session Entry。

### 1.10 Tree TUI 首版范围

Tree UI 只复用或移植 pi-tui 的列表、键盘导航和布局能力，不移植 pi 的 JSONL Session、Tree 领域对象或持久化逻辑。

`SessionTreeSelector` 接收已经由领域层构建的展示节点：

```ts
interface TreeNodeView {
  entryId: EntryId;
  depth: number;
  type: EntryType;
  preview: string;
  active: boolean;
  selectable: boolean;
}
```

领域层负责执行 default 过滤和 selectable 判定：User、可见 Assistant、ToolResult 可选；Compaction/BranchSummary 可见但不可选；状态 Entry 和纯 tool-call Assistant 不提供给 default selector。

首版只实现上下选择、Enter 确认、Esc 取消，以及 direct/summary 二次选择。不实现搜索、其他过滤模式、标签、书签或 Session picker。

### 1.11 Home、Session 切换与应用退出

- Home 使用 `currentSessionId = null`，不提前创建数据库 Session。
- 首次发送时 Runtime 分配 provisional Session ID，并执行“创建 Session + 首个 checkpoint”原子操作；Controller 只在 `session.created` 后正式切换。
- `/new` 回到 Home，不删除旧 Session。
- Fork 成功后切换到新 Session 并回填所选 User 草稿。
- 首版没有 Session picker，TUI 只实时渲染一个前台 Session；所有 RuntimeEvent 仍携带 `sessionId`，为其他输入源和后续后台 Session 留出正确路由边界。

`AgentRuntime.close()` 必须幂等，并按顺序停止接收输入、取消 ActiveTurn、等待既有 Turn 收口、取消未响应 interaction、关闭工具资源和 SessionStore，最后由 Controller 停止 TUI。具体超时、清理失败和退出码归入 M9。

### 1.12 M8 收口与明确不做

M8 选择 `AgentRuntime + typed command + snapshot/event`，不继续让 Controller 直接驱动 AgentLoop，也不新增职责宽泛的 `SessionManager`。

首版明确不做：

- TUI 多标签或后台 Session 面板；
- Session picker；
- Tree 搜索、额外过滤模式、标签和书签；
- TUI 直接调用 Store/AgentLoop 或直接解析 RuntimeEvent；
- 持久化 RuntimeEvent 或 streaming partial snapshot；
- 为 per-session 串行再增加通用锁框架。

M8 至此确认了目标分层、对象职责、AgentRuntime API、mailbox 所有权、命令协议、事件路由、Snapshot 重建、TUI 状态和首版交互范围。

## 2. M9 错误边界、测试与实施批次（已确认）

### 2.1 错误边界的四级模型

错误按“发生后允许什么继续运行”分为四级，不能只按异常类型或错误文案分类。

#### A. 应用级致命错误

适用于整个进程已无法安全继续的情况：

- SQLite 无法打开、schema 初始化失败或数据库连接整体不可用；
- AgentRuntime、MessageBus 或全局并发控制的不变量被破坏；
- TUI/终端无法继续渲染或接收输入，且一次完整 Snapshot 重建仍失败；
- 核心 provider/tool/runtime 依赖初始化失败；
- 资源清理或关闭失败导致进程状态无法可信判断。

行为：停止接受新输入，启动幂等关闭流程，尽力收口所有 ActiveTurn，关闭 Store 和工具资源，最终返回非零退出码。

#### B. Session 损坏

适用于当前 Session 的持久化身份或树结构不可信，但应用和其他 Session 仍可工作：

- active leaf 不存在；
- parent 链断裂、循环，或 parent sequence 不早于 child；
- Entry discriminator/payload、内部引用或 tool-call/result 关系违反不变量；
- 结构合法的 runtime checkpoint 与当前 `active_leaf_id`、`baseLeafId` 或 pending parent 链冲突；
- 恢复时无法唯一确定 Entry 身份或活动路径。

行为：当前 Session 进入只读 `corrupted` 状态，禁止新 Turn、Tree、Fork、Compact 和状态变更；不自动截断、删除或修复历史。用户仍可查看诊断、回到 Home 或处理其他 Session。

#### C. Session 暂停等待持久化

适用于 Session 数据仍然一致，但当前 operation 的 durable 结果尚未解决：

- checkpoint 更新失败；
- Turn 最终事务失败；
- Branch Summary/Compaction 已生成，但提交事务失败；
- SQLite busy/locked、磁盘满、只读或可恢复 I/O 问题阻止提交。

行为：当前 mailbox operation 保持占用，不执行该 Session 后续 envelope；保留内存中的 checkpoint、最终 pending 链或摘要，不重新调用 provider、工具或摘要模型。其他 Session 可以继续工作。

#### D. 当前操作失败

适用于当前 Turn/command 可以按既有规则明确收口，Session 随后仍可使用：

- provider 网络、认证、rate limit 或普通服务错误；
- context overflow、自动 Compaction 或 Branch Summary 生成失败；
- 工具正常返回错误；
- stale Tree target、用户取消、max iterations；
- 恢复出的 model/thinking-level 当前不可用。

行为：按 M5～M8 的已确认语义收口 Turn 或保持 Session 不变，显示明确错误，然后让 mailbox 继续。原始异常堆栈不得写入会话历史。

### 2.2 错误分类与用户行为表

| 场景 | 级别 | Session 后续写入 | 用户可做什么 |
|---|---|---|---|
| 数据库无法打开/schema 初始化失败 | 应用致命 | 全部禁止 | 查看错误并退出 |
| 活动路径或 Entry 树损坏 | Session 损坏 | 当前 Session 禁止 | 查看诊断、回 Home、退出 |
| 合法 checkpoint 与 active leaf 冲突 | Session 损坏 | 当前 Session 禁止 | 查看诊断、回 Home、退出 |
| checkpoint/最终事务暂时无法提交 | 等待持久化 | 当前 Session 暂停 | 重试提交或退出 |
| provider/tool/summary 普通失败 | 操作失败 | 收口后允许 | 重试新操作、切换状态或退出 |
| model/thinking 当前不可用 | 操作阻塞但非损坏 | 切换状态前禁止模型请求 | 浏览、导航、明确切换模型 |
| Event listener 失败 | listener 隔离 | Runtime 不受影响 | Controller 失败时有序退出 |
| TUI 单次增量渲染失败 | presentation 降级 | Runtime 不受影响 | 自动执行一次 Snapshot 重建 |

不允许为了可用性在损坏路径上继续追加，也不允许把普通 provider 错误升级为整个应用退出。

### 2.3 Store 错误归一化、重试与提交确认

SessionStore 将底层 SQLite 错误归一化为稳定类别：`busy`、`capacity`、`read_only`、`io`、`constraint`、`corruption`、`closed` 和 `unknown`。上层不解析 SQLite 原始字符串决定业务行为。

- 连接已经设置 `busy_timeout = 5000`；超时后仍为 `busy/locked` 时，Runtime 只自动重试一次，并等待 100ms。
- `constraint` 或 `corruption` 不自动重试：领域输入合法但约束仍失败时按 Session 损坏或 Runtime invariant error 处理。
- `capacity`、`read_only`、`io` 和 `unknown` 不自动循环重试，进入等待持久化状态。
- 所有重试复用相同 Entry ID、operation ID、checkpoint 和最终链，不重新执行外部副作用。

提交结果不明确时，重试前先执行 reconciliation：

1. 重新读取 Session、runtime checkpoint、active leaf 和本批稳定 Entry ID。
2. checkpoint 已清除、全部预期 Entry 存在且 active leaf 指向预期末端时，视为上次最终事务已经成功。
3. 旧 checkpoint 仍完整存在且预期 Entry 均不存在时，可以安全重试同一事务。
4. checkpoint、Entry 与 leaf 出现部分提交或相互矛盾时，标记 Session 损坏，禁止继续。
5. checkpoint 更新同样先比较数据库中实际值：目标 checkpoint 已存在则视为成功，仍是旧值才重试。

一次自动重试和 reconciliation 仍无法解决时，Runtime 发出 `interaction.requested(kind = "persistence_retry")`。TUI 只提供“重试提交”和“退出应用”；不提供跳过提交后继续该 Session。Headless 调用方通过同一 interaction 协议选择。

用户选择退出或关闭超时时，不删除稳定 checkpoint。下次启动按 M7 的保守恢复规则收口。

### 2.4 Checkpoint 损坏与兼容边界

- JSON 语法非法、缺少 discriminator 或版本不受支持的 checkpoint，沿用既有设计：使用单条 metadata 更新删除该 key，记录警告，不物化 Entry。
- checkpoint 结构合法但与 Session 树冲突时，不能删除后继续，按 Session 损坏处理。
- 不尝试从 partial streaming、MessageBus backlog 或 `pendingQueue` 恢复；这些仍是明确的进程内状态。
- 不为旧线性 Session 数据设计迁移或自动兼容。开发期旧库使用新 schema 前直接删除。

### 2.5 RuntimeEvent、Controller 与 View 失败

- RuntimeEventHub 对每个 listener 单独捕获异常；一个 listener 失败不能中断 provider、工具、checkpoint 或其他 listener。
- Controller 的事件投影失败时，先丢弃临时 presentation state，并通过 `getSessionSnapshot()` 完整重建一次。
- Snapshot 重建或 View 整体替换再次失败时，按应用级致命错误进入关闭流程。
- 单个未知 tool card 或缺失 preview 可以使用明确 fallback 组件；未知持久化 Entry 类型不能以 fallback 绕过领域校验。
- UI error notice 是 presentation state，不自动写入 Session；只有 M7 已确认的 failed/cancelled AssistantEntry 属于正式历史。

### 2.6 AgentRuntime.close() 与退出码

`AgentRuntime.close()` 幂等；第一次调用创建并缓存唯一关闭 Promise，后续调用返回同一 Promise。

关闭顺序：

1. 标记 Runtime 为 `closing`，拒绝新的 user message、command 和 interaction。
2. 对全部 ActiveTurn 执行与 `stop` 相同的 admission seal、补充消息丢弃和 AbortController 通知。
3. 取消尚未响应的 Tree/Fork selector interaction；尚未开始的 mailbox envelope 不再执行。
4. 等待正在进行的工具、Turn 最终事务和 Session command 收口，默认 grace period 为 10 秒。
5. 无论前一步是否失败，都尽力关闭工具资源、shell 子进程和 SessionStore。
6. Controller 最后停止 TUI 并决定进程退出码。

- 正常关闭返回 exit code 0。
- 任一资源关闭失败、grace period 超时或存在无法提交的最终事务时返回 exit code 1。
- 超时后不删除 checkpoint，不伪造成功历史；进程退出后由下一次启动恢复。
- 多个清理错误聚合报告，但不能因为前一个 close 失败而跳过后续资源清理。

### 2.7 测试分层与共同规则

每个实现 Batch 都使用 TDD，并在所属分支内同时完成测试与实现。RED 与 GREEN 是 Batch 内部连续完成的步骤，不作为独立 review 或提交单位；M9 不设置“最后统一补测试”的独立阶段。

**纯单元测试**

- Entry/Tree 不变量、活动路径、状态回放和 provider message 映射；
- Tree/Fork target 归一化与 Branch Summary 区间；
- token 估算、cut point、Interaction Prefix Summary 和增量摘要输入；
- mailbox admission、barrier、seal、pendingQueue 消费和 ViewState reducer。

**SessionStore 契约测试**

- 对 InMemory 与 SQLite 实现运行同一套可观察行为契约；
- 覆盖 Session 创建、Entry 追加、活动 leaf、sequence、checkpoint 和各原子事务；
- SQLite 另外覆盖复合外键、唯一约束、事务回滚、WAL 配置、JSON 更新和 reopen。

**Agent/Runtime 集成测试**

- 使用可控 fake provider、fake tools 和真实 InMemory/SQLite Store；
- 覆盖 checkpoint 两个 phase、工具副作用未知、Turn 最终提交、Compaction 接入和 crash reopen；
- 覆盖同 Session 串行、不同 Session 最大并发 4、command barrier、pendingQueue 容量 3、stop 和异常重入队；
- 覆盖 RuntimeEvent 的 session/operation/turn 关联和 per-session 顺序。

**Controller/TUI 测试**

- Controller 使用 fake AgentRuntime，验证 typed intent、事件投影、Snapshot 重建和 interaction response；
- TUI 使用 virtual terminal，验证 transcript、状态、editor、Tree/Fork selector 和退出键；
- View 增量失败后只允许一次完整 Snapshot 重建。

**端到端测试**

- 使用真实 SQLite、fake provider/tools 和 virtual terminal；
- 不在默认测试中访问真实网络、OpenAI API 或不可控外部服务；
- 所有竞态使用 controllable promise、barrier 或 fake clock，不使用依赖时间碰撞的 sleep。

### 2.8 首版关键验收矩阵

至少覆盖以下端到端场景：

1. 新 Session 首条 User 与 checkpoint 原子创建，失败时编辑器内容保留。
2. 多轮 Assistant/tool 形成合法 Entry 树，重启后上下文一致。
3. `/tree` direct 与 summary 导航、User 草稿回填和 stale target。
4. `/fork` 复制单路径、内部引用归一化、切换新 Session 和草稿回填。
5. 手动、turn 间和 Turn 内 Compaction，以及压缩后仍 overflow 的失败路径。
6. `ready_for_iteration` 和 `awaiting_tools` 两种 crash recovery，不重试未知副作用工具。
7. 运行中连续补充消息一次消费并合并，超出 3 条后留在 backlog。
8. command barrier 后的 normal message 不越过命令。
9. `stop` 绕过 backlog，丢弃未 checkpoint 补充消息并保留已持久化历史。
10. 普通异常将剩余 `pendingQueue` 合并后追加到 mailbox 队尾。
11. 同 Session 永不并发，不同 Session 并发不超过 4。
12. Tree/Fork selector 等待期间不持有 SQLite 事务，但仍阻塞当前 Session 后续 envelope。
13. RuntimeEvent 跨 Session 交错时，前台 TUI 不串流。
14. Snapshot 重建能够覆盖导航、压缩、恢复和 Turn 最终提交后的权威 transcript。
15. persistence retry reconciliation 能区分已提交、未提交和矛盾状态。
16. `AgentRuntime.close()` 正常、超时和资源失败路径都执行完整清理。

### 2.9 三个实现分支的 Batch 覆盖项

三个分支采用 stacked 顺序推进。以下列表定义每个分支必须覆盖的能力顺序，不再逐项对应提交；三份正式 implementation plan 将相邻且内聚的能力组合为行为 Batch。每个 Batch 是一次连续 TDD、一次 GREEN 验证和一个建议 commit/review 边界，不按 RED/GREEN 或单个文件拆分，也不把互不相关的跨层行为压入同一 Batch。

#### `feat/session-tree-compaction`

1. SessionEntry/ID/Tree 纯领域类型与结构校验。
2. 新 SQLite schema、SessionStore 契约和基础原子事务。
3. active path、model/thinking state 与 ContextBuilder。
4. Tree direct navigation 与 Fork 事务。
5. Branch Summary 区间、输入和提交。
6. ModelCapabilities、token 估算和触发预算。
7. Compaction cut point、Interaction Prefix Summary、摘要生成与提交。
8. 模块公共 API、契约测试和分支级集成测试收口。

为保证 stacked branch 在中间阶段仍能构建，可以暂时保留标记为 deprecated 的线性 `appendMessages/getHistory` 兼容入口；它们只服务尚未迁移的旧 AgentLoop，不属于最终架构，必须在 Runtime 分支删除。

#### `feat/session-runtime`

1. 最终 RuntimeCheckpoint 类型、Store checkpoint API 与恢复物化。
2. AgentRunner safe point、pendingQueue 消费和 checkpoint-before-provider。
3. 单 Runtime Turn 的 AgentLoop、终态与 Compaction 接入。
4. per-session mailbox、全局并发 4 和 ActiveTurnHandle。
5. normal/control/session command 分类、barrier 和交互命令协议。
6. RuntimeEventHub、SessionSnapshot 与 AgentRuntime 公开 API。
7. stop、异常重入队、persistence blocked reconciliation 和幂等 close。
8. 删除旧 checkpoint phase、直接 stream callback 和线性 SessionStore 兼容入口，完成分支级集成测试。

#### `feat/session-tui`

1. Controller 改为 typed intent + AgentRuntime fake 的契约测试。
2. `replaceSession()`、`applyPresentation()` 和 ViewState reducer。
3. User/Assistant/Tool/Compaction/BranchSummary transcript 组件。
4. queued/running/compacting/command_waiting/stopping 状态与可继续输入的 editor。
5. Tree/Fork selector 与 interaction response。
6. Home、`/new`、Fork 切换、`/stop`、Ctrl+C/Ctrl+D 和退出流程。
7. composition root 改用 AgentRuntime，移除 Controller → AgentLoop 直连。
8. virtual-terminal 端到端验收与旧 UI 接口清理。

### 2.10 跨分支接口冻结点

进入下一分支前必须冻结上游接口：

- Tree/Compaction → Runtime：SessionEntry union、SessionStore 原子操作、SessionSnapshot 的领域输入、Context/Navigation/Compaction service 契约。
- Runtime → TUI：AgentRuntime API、RuntimeEvent union、OperationHandle、InteractionRequest/Response、SessionSnapshot。
- TUI 内部：ChatSessionView、ChatPresentationEvent 和 TreeNodeView 只属于 presentation，不反向进入 Agent/Session 包。

冻结后如需改变字段语义或事务边界，必须先回改正式设计和上游契约测试，再更新下游；不能只在后续分支增加临时兼容分支。

### 2.11 分支合并、旧 API 移除与数据库边界

分支依赖固定为：

```text
main
  └─ feat/session-tree-compaction
       └─ feat/session-runtime
            └─ feat/session-tui
```

- 后一分支基于前一分支开发，最终按相同顺序合并；不从三个独立 main 分支并行实现后再解决大规模冲突。
- 每个分支在进入下一阶段前必须通过自身 package tests、全仓 typecheck 和已有回归测试。
- 最终版本删除 legacy `messages` 表、旧线性 Session API、`pending_user_turn`、旧 checkpoint phase 和 Controller → AgentLoop 直连。
- 不迁移旧开发数据库；启动新版本前删除旧库并由最终 schema 重建。
- RuntimeEvent 从 core 移到 agent 后，core 只保留稳定 ID、provider-neutral message/tool 等共享值对象。
- 合并完成后不保留双写、旧 schema feature flag 或长期 compatibility adapter。

### 2.12 M9 收口

M9 至此确认错误分级、Store 重试与 reconciliation、checkpoint 兼容边界、Runtime/View 失败、幂等关闭、测试分层、首版验收矩阵、三个分支的 TDD Batch、接口冻结点和合并顺序。

M1～M9 的设计至此完成，但设计完成不等于授权实现。开始任一分支前仍需用户明确要求进入实现。
