# Session Runtime 与调度设计

- 状态：M7 已确认完成
- 实现分支：`feat/session-runtime`
- 依赖：[`session-tree-compaction.md`](./session-tree-compaction.md)
- 总索引：[`session-tree-and-compaction.md`](../.session/session-tree-and-compaction.md)

> 本文是 Agent Runtime、checkpoint、崩溃恢复、MessageBus 与 Session 调度的正式设计稿。它消费前一模块提供的 Session Tree 与 Compaction 能力，不重新定义 Entry、Tree 或压缩算法。

## 模块边界

本模块负责：

- Runtime Turn、pending Entry 链与最终提交；
- provider streaming、tool execution 和 Compaction 接入的 durable boundary；
- checkpoint 状态机、崩溃恢复和 Turn 终态；
- MessageBus、per-session mailbox、`pendingQueue`、command barrier 与 stop；
- 同一 Session 串行、不同 Session 并发的运行时调度语义。

本模块不负责：

- Tree/Compaction 领域算法本身；
- CLI/TUI 的具体命令交互和组件呈现，以及由 M9 定义的错误边界、测试矩阵与实施切片。

## 1. M7 运行时、流式响应与崩溃恢复

### 1.1 Turn 开始与运行时 pending 链（已确认）

> 1.6 已进一步确认：运行中的 Turn 可以在安全点接收新的普通用户消息，因此本节的 pending 链仍以首条 User 开始，但不再隐含“整个 Runtime Turn 只有一条 User”。

本文从此明确区分 Runtime Turn 与用户交互段：Runtime Turn 是 checkpoint、逻辑 writer 和最终事务的生命周期；pending 链中的每条 UserEntry 则开启一个新的用户交互段，直到下一条 UserEntry 前结束。Compaction 的 cut point 与 Interaction Prefix Summary 按交互段解释，不按 Runtime Turn 的事务分组解释；最终 Entry 无需持久化 `turnId`。

- 不再使用独立的 `pending_user_turn`。统一的 runtime checkpoint 从 `phase = "ready_for_iteration"` 开始承载整个 pending Turn。
- 用户提交后，per-session mailbox worker 先取得该 Session 的逻辑 writer，再调用 AgentLoop；AgentLoop 记录 `baseLeafId`，并为 Turn 和 pending User 分配稳定 ID。
- AgentLoop 在调用 AgentRunner 前，通过原子的 store 操作写入首个 checkpoint。它至少保存 `version`、`turnId`、`baseLeafId`、`phase` 和以 pending User 开头的 `pendingEntries`。
- pending User 保存最终物化 UserEntry 所需的 ID、创建时间和完整 content，但不预先分配 `sequence`；sequence 只在 Turn 最终事务中从 `next_entry_seq` 连续分配。
- checkpoint 写入成功后才清空编辑器、在 transcript 显示运行中的 User，并调用 AgentRunner。写入失败时不启动 Turn，用户文本留在编辑器。
- Turn 期间数据库 `active_leaf_id` 保持为 `baseLeafId`。运行时的 pending leaf 沿 User、完整 Assistant、按原 tool-call 顺序排列的 ToolResult，以及 Turn 内 Compaction 依次推进。
- pending Entry 一旦形成就获得稳定 ID 和确定的逻辑 parent；checkpoint 始终保存从 pending User 到当前稳定 pending leaf 的完整链。
- 正式 Session 树只包含已提交 Entry；pending 链只由运行中 transcript 展示，不可被 Tree 导航。
- Turn 到达可提交终态后，使用一个事务校验 `active_leaf_id = baseLeafId`，物化全部 pending Entry，推进 leaf/sequence，并删除 runtime checkpoint。
- 新 Session 延续 M4 的延迟创建语义：首次发送时在同一个原子操作中创建 Session 行并写入 `ready_for_iteration` checkpoint。

准确 checkpoint phase 与各阶段恢复语义已在 1.3、1.4 确认；本小节定义统一 checkpoint、Turn 开始的 durable 边界和 pending 链语义。

### 1.2 流式响应的持久化边界（已确认）

- provider 的 `content_delta` 仅更新 UI 和运行时内存中的 streaming Assistant 卡片，不更新 runtime checkpoint，也不创建 partial AssistantEntry。
- 流式调用期间，数据库始终保留调用前的最后一个 `ready_for_iteration` checkpoint。
- 只有收到合法的 provider `done`，并取得完整 Assistant message、tool calls、stop reason 和可用的 usage 后，才形成 pending AssistantEntry。
- 如果完整 Assistant 包含 tool calls，必须先把它写入 `awaiting_tools` checkpoint，成功后才能执行该批工具。
- 如果完整 Assistant 不包含 tool calls，先将它加入内存 pending 链，再按 1.6 执行终态 admission 裁决：已有可归入当前 Turn 的新 User 则继续 ReAct；只有当前 Turn 成功封口时才直接执行最终事务。
- UI 可以实时显示 delta，但只在 Turn 最终事务成功后才将对应卡片标记为已持久化完成。
- 在 `done` 前发生崩溃、断流、取消或 provider 错误时，丢弃 partial text，不生成 partial AssistantEntry，并从上一个稳定 checkpoint 恢复。终止 Turn 时如何表达 cancelled/failed 留到后续终态讨论。
- 流式 tool-call 参数片段同样只在内存中累积；只有 `done` 中完整、已解析的 tool calls 才可以进入 checkpoint，不得提前执行工具。

首版不定期保存 partial snapshot，也不逐 delta 写数据库。

### 1.3 Runtime checkpoint 状态机（已确认）

首版 checkpoint 只记录可以安全恢复的稳定状态，不为 provider streaming、工具正在执行或 Compaction 正在生成等瞬时动作创建 phase。

checkpoint 使用单一数据结构，不为各 phase 抽取泛型或额外 interface：

```ts
interface RuntimeCheckpoint {
  version: 1;
  turnId: TurnId;
  baseLeafId: EntryId | null;
  phase: "ready_for_iteration" | "awaiting_tools";
  pendingEntries: PendingEntry[];
}
```

`PendingEntry` 表达已获得稳定 ID 和逻辑 parent、但尚未分配 `sequence` 的 Session Entry。

phase 表达“从这个稳定持久化状态恢复后，接下来可以安全做什么”，不再编码“最后追加了哪种 Entry”：

- `ready_for_iteration`：pending 链结构完整，不存在未闭合的 tool calls；可以进入下一个安全点，接收新 User、重新估算 token、必要时 Compaction，然后调用 provider。该 phase 可以包含初始 User、已完成的 ToolResult 批次、运行中补充 User 或已完成的 CompactionEntry。
- `awaiting_tools`：pending 链尾是包含非空 tool calls 的完整 Assistant，尚无该批对应的 durable ToolResult；该批工具可能尚未执行、正在执行，或已产生副作用但结果尚未稳定记录。

主要转换为：

```text
无 checkpoint
  → ready_for_iteration（首条 User）
      ├─ 追加新 User 或 Compaction → ready_for_iteration
      ├─ provider 完成且有工具 → awaiting_tools
      │                           → ready_for_iteration（完整 ToolResult 批次）
      └─ provider 最终回复且 Turn 封口 → 最终数据库事务
                                            → 删除 checkpoint
```

- provider streaming 期间保持 `ready_for_iteration`。
- 工具执行期间保持 `awaiting_tools`，表示工具可能已产生副作用，但结果尚未稳定持久化。
- Compaction 生成期间保持原 `ready_for_iteration` checkpoint；完整摘要与 CompactionEntry 写入成功后仍为 `ready_for_iteration`。Compaction 的 durable boundary 由 `pendingEntries` 中已存在完整 CompactionEntry 表达，不再重复编码为 phase。

每次转换原子替换整个 checkpoint。读取和写入边界必须校验：

- `version` 受支持，`turnId` 与 `baseLeafId` 在同一 Turn 内不变；
- phase 转换方向合法；
- pending Entry ID 唯一，第一条 User 的 parent 是 `baseLeafId`，后续 parent 构成连续链；
- `ready_for_iteration` 不存在未闭合 tool calls；`awaiting_tools` 恰有一个链尾工具批次尚无 durable ToolResult。

checkpoint 不持久化 iteration、当前 model 或 thinking level：它们不是首版崩溃恢复所需的事实。Provider 与摘要 usage 保存在对应的 pending AssistantEntry/CompactionEntry 中。

Turn 正常完成、取消、失败或达到迭代上限都不另外写入终态 checkpoint。AgentLoop 在内存中形成最终 pending 链后，直接调用 Turn 最终事务。事务成功时 Entry、leaf、sequence 和 checkpoint 清理一起提交；事务失败时整体回滚，原稳定 checkpoint 保留。进程仍存活时可使用内存中的最终链重试同一事务，不重新调用 provider 或工具。

### 1.4 崩溃恢复与 checkpoint 物化（已确认）

首版采用自动、保守的恢复策略：Session 打开时发现 runtime checkpoint，先获取该 Session 的逻辑 writer，将旧 Turn 收口为已提交历史。恢复过程不自动继续旧 ReAct，不调用 provider，不重新执行工具，也不重新生成 Compaction Summary。

两个 phase 的物化规则：

- `ready_for_iteration`：物化 checkpoint 中的完整 pending 链，并追加一条 `stopReason = "failed"` 的中断 AssistantEntry。pending 链中已持久化的 User、真实 ToolResultEntry 和 CompactionEntry 全部保留；中断文本可以根据链尾 Entry 区分“收到用户补充后”、“工具批次完成后”或“压缩完成后”，但这些只是用户可见诊断，不再拆分 phase。
- `awaiting_tools`：物化已有链；为当前批每个 tool call 按原顺序追加 `isError = true` 的 ToolResultEntry，再追加中断 AssistantEntry。不区分哪些工具可能已执行，所有未稳定记录的结果都按“结果未知”处理。

`awaiting_tools` 恢复时每个未持久化结果使用固定的保守错误内容：

```text
Tool execution was interrupted before its result was durably recorded.
The tool may have completed and side effects may have occurred.
Its outcome is unknown. Do not retry automatically.
Verify external state or ask the user before retrying.
```

恢复生成的中断 AssistantEntry 使用 `toolCalls = []`、`stopReason = "failed"`、空 usage。`model` 优先使用 pending 链中最后一条 AssistantEntry 的 model；如果尚无 Assistant，则从 `baseLeafId` 所在活动路径恢复当时模型。

恢复使用一个最终事务：

1. 校验数据库 `active_leaf_id = baseLeafId` 及 checkpoint/pending 链不变量。
2. 在内存中生成必要的“结果未知” ToolResult 和中断 Assistant。
3. 为全部 Entry 分配连续 sequence，插入完整恢复链并推进 active leaf。
4. 在同一事务中删除 runtime checkpoint。

恢复事务再次崩溃时，数据库只会保留完整旧 checkpoint，或完整已提交的恢复链，不会重复物化。事务成功后才重建 transcript 并允许新 Turn 或 Session 命令继续。

空闲时手动 `/compact` 不使用 runtime checkpoint，而是直接提交正式 CompactionEntry。Turn 内 Compaction 是否已稳定持久化，由 `ready_for_iteration` checkpoint 的 `pendingEntries` 中是否存在完整 CompactionEntry 判定。

### 1.5 Turn 终态与正式历史收口（已确认）

进程仍存活且 AgentLoop 明确知道 Turn 为何结束时，在内存中形成可提交的最终 pending 链。不写终态 checkpoint，直接调用 Turn 最终事务。

- `completed`：保存 provider `done` 返回的完整 AssistantEntry，不生成额外收口 Entry。
- `cancelled`：如果没有可持久化的完整 Assistant，追加应用生成的 cancelled AssistantEntry。
- `failed`：如果没有可持久化的完整 Assistant，追加应用生成的 failed AssistantEntry。
- `max_iterations`：保留全部已完成的 Assistant/ToolResult 轨迹，并追加达到迭代上限的 AssistantEntry。

应用生成的收口 AssistantEntry 使用：

- `toolCalls = []`；
- 空 usage；
- 与 Turn outcome 一致的 `stopReason`；
- 本次实际尝试调用的 model；
- 固定、明确的用户可见内容，不把 provider 原始异常、堆栈或可能敏感的诊断信息写入对话历史。

首版固定表达至少区分：

```text
[Turn cancelled by user.]
[Assistant reply unavailable because the turn failed.]
[Turn stopped after reaching the maximum agent iterations.]
```

若 provider 已产生一条完整 Assistant，即使其 stop reason 是 failed/cancelled，也优先保存该真实 Assistant，不再追加第二条合成 Assistant。`done` 之前的 partial stream 仍按 1.2 丢弃。

工具批次执行期间取消时：

1. 已启动工具等待其真实成功、失败或取消结果。
2. 尚未启动的 tool call 生成明确的 `tool_cancelled` ToolResultEntry。
3. 按原 tool-call 顺序组装全部 ToolResult，形成完整的 pending 链。
4. 追加 cancelled AssistantEntry 后执行 Turn 最终事务。

该流程不丢弃已执行工具的真实结果，也不假定已发生的外部副作用可以回滚。

唯一已确认的撤回式例外沿用 M6：新 Turn 第一次 provider 调用前的自动 Compaction 尚未把完整 CompactionEntry 写入 `ready_for_iteration` checkpoint 时，用户取消则删除该 checkpoint，把 User 文本恢复为编辑器草稿，不提交该 Turn。一旦 checkpoint 已包含完整 CompactionEntry，取消只能收口 Turn，不回滚 CompactionEntry。

最终事务成功后，UI 才将终态标记为已持久化并对外返回完整 Turn 结果。事务失败时保留原稳定 checkpoint；进程存活期间可使用内存最终链重试事务，不重新调用 provider 或工具。

### 1.6 MessageBus、Session 顺序与运行中补充消息（已确认）

当前 Controller 在 `busy` 时丢弃新输入的行为必须移除。所有输入先 publish 到 MessageBus，由它负责按 Session 分类、保持同一 Session 的到达顺序，并调度不同 Session 的并发工作。MessageBus 不要求同一 Session 的消息在全局到达序列中物理相邻；顺序约束只在 per-session mailbox 内生效。

M8 已确认其架构边界：MessageBus 是 `AgentRuntime` 的内部实现，不直接暴露给 Controller。应用层只使用 `submitUserMessage()`、`submitCommand()`、`stop()`、`respondToInteraction()`、`getSessionSnapshot()`、`subscribe()` 和 `close()` 等 typed API。

- 每个 per-session mailbox 只有一个 drain worker；该 worker 的独占执行权就是 Session 逻辑 writer，首版不额外实现通用 Mutex 或 `SessionLock` 类。
- 不同 Session 最多同时执行 4 个 Turn 或 Session command；该内部默认值允许构造时覆盖，但首版没有 CLI 设置。
- `pendingQueue` 容量保持 3；MessageBus per-session backlog 首版不设第二层上限。
- publish 方法返回表示 envelope 已进入进程内 MessageBus，不表示 durable；`input.checkpointed` 或最终提交事件才表示稳定持久化。
- RuntimeEvent 与 AgentRuntime 的完整公开边界见 M8 正式设计稿。

同一 Session 的输入分为三类：

1. **stop/control**
   - 不等待 per-session mailbox worker 的正常消费顺序，不进入普通 backlog。
   - 直接通知当前 ActiveTurn/AbortController，让正在运行的 Agent 按已确认的取消规则收口；同时同步封闭该 Turn 的补充消息 admission。
   - `stop` 直接取消尚未写入 checkpoint 的补充消息：丢弃当前 `pendingQueue` 中的全部 normal message，以及 per-session mailbox 中排在第一个 session command barrier 之前、原本可继续 admission 到当前 Turn 的 normal message（包括因 `pendingQueue` 满而留在 backlog 中的消息）。这些消息不打包、不重新入队。
   - 已写入 checkpoint 的 UserEntry 属于当前 Turn 历史，仍随 cancelled Turn 收口；第一个 command barrier 及其后的 envelope 保留。`stop` 处理完成后新到达的 normal message 也不受本次取消影响。
2. **normal message**
   - Session 空闲时，队首 normal message 启动新 Runtime Turn。
   - Session 已有 ActiveTurn 且尚未被 command barrier 阻断时，MessageBus 尝试将它 admission 到该 Turn 的有界 `pendingQueue`。首版容量暂定为 3 条 normal message。
   - `pendingQueue` 达到上限时，超出的 normal message 作为独立 envelope 保留在 MessageBus backlog 中，后续按原到达顺序逐条 admission；MessageBus 层不丢弃、不合并，也不为这个低频场景引入 deferred batch。它们后续进入 `pendingQueue` 后，仍可与同一安全点的其他补充消息一起合并消费。
3. **session command**
   - `/tree`、`/fork`、`/compact` 等会改变 Session 状态的命令不注入 ReAct。
   - 命令等待当前 Turn 完整结束后，由同一个 mailbox worker 顺序执行。
   - 命令是顺序 barrier：它到达后，后续 normal message 不能越过它进入当前 Turn。

每次 provider 调用前是运行中补充消息的安全点：

```text
安全点
→ 对 pendingQueue 当时已有的 1～3 条消息创建不可变队首快照，不删除原消息
→ 按到达顺序用空行连接内容，合并为一条 pending UserEntry
→ 把合并后的 UserEntry 与完整 pending 链持久化到 checkpoint
→ checkpoint 成功后，才从 pendingQueue 删除该快照对应的队首消息
→ 更新 working context
→ 重新估算 token，必要时 Compaction
→ provider
```

由于同一 `pendingQueue` 只有 AgentRunner 一个消费者，队首快照在 checkpoint 写入期间不会被其他消费者抢走，因此不引入 claim/ack/nack 状态机。checkpoint 写入期间新到达的 normal message 只追加在队尾（或在容量已满时留在 MessageBus backlog），不改变已确定的快照，等待下一个安全点。

checkpoint 写入失败时，快照对应的消息从未离开 `pendingQueue`，无需 `nack`；当前 Turn 按 checkpoint 失败收口，进程仍存活时由 Turn 清理流程将未消费消息交还 MessageBus。若进程在 checkpoint 成功前直接崩溃，这些只存在内存的补充消息可以丢失；这是 MessageBus 与 `pendingQueue` 不持久化的明确首版边界。

合并后的新 User 只有在 checkpoint 写入成功后才能被 provider 消费。因此一个 Runtime Turn 可以形成：

```text
User₁ → Assistant → ToolResult → User₂ → Assistant
```

provider 产生不含 tool calls 的完整 Assistant 时，当前 Turn 不立即提交，而是先进行同步的终态 admission 裁决：

- 已有可归入当前 Turn 的 normal message：按上述相同规则对当前 1～3 条消息创建队首快照、合并为一条 UserEntry、写入 checkpoint，然后继续下一轮 ReAct。
- 没有这类消息：封口当前 Turn，然后执行最终事务。封口后到达的 normal message 明确属于后续 Turn。

终态检查与封口必须对同一 Session 的 publish/admission 呈现为一个不可分割的同步操作，避免新消息在“检查为空”与“提交 Turn”之间进入一个已无人消费的 `pendingQueue`。M8 已确认 MessageBus 保持 AgentRuntime 内部实现、backlog 首版不设第二层上限；普通异常收口时的剩余消息处理见 1.7。

### 1.7 普通异常收口时的剩余消息（已确认）

本节处理进程仍存活、但当前 Turn 因 provider 失败、max iterations、Compaction 失败、checkpoint 失败或其他普通运行异常而无法继续的场景。已进入 runtime checkpoint 的 User/Assistant/ToolResult/Compaction 属于当前 Turn，按 1.4、1.5 恢复或收口；本节只处理仍留在 `pendingQueue`、尚未写入 checkpoint 的 normal message。

首版不为这些消息维护原始全局到达序号，也不尝试将它们插回 per-session mailbox 的原位置。处理流程为：

1. Turn 确定无法继续时，同步封闭当前 `pendingQueue`，后续到达的消息只进入 MessageBus。
2. 使用最后稳定 checkpoint 形成 failed/max-iterations 等终态 pending 链，执行 Turn 最终事务。
3. 最终事务成功后，把 `pendingQueue` 中仍未消费的普通消息按队列内部顺序用空行合并，打包为一条新 normal message。
4. 将该打包消息追加到当前 Session mailbox 队尾，然后结束当前 mailbox operation；同一个 worker 后续按队列当前顺序串行消费。

这里的顺序语义是“按重新入队时间排序”，而不是恢复剩余消息最初到达时的相对位置。因此，异常收口期间已进入 mailbox 的新 normal message 或 session command 会排在打包消息之前；这是为避免 arrival sequence、有序合并和原位回插机制而接受的首版简化。同一 Session 仍始终只有一个业务流程执行，不会并发修改 Session。

最终事务失败时，Turn 尚未完成收口，不打包、不重新入队，mailbox worker 继续由当前 operation 占用，并保留封闭的 `pendingQueue` 与内存最终链重试同一事务。进程直接崩溃时，`pendingQueue` 和 MessageBus 中尚未 checkpoint 的消息仍可丢失。

`stop` 不属于上述普通异常重入队流程。它会按 1.6 直接丢弃尚未 checkpoint、且仍可归入当前 Turn 的补充消息，不打包、不重新入队。
