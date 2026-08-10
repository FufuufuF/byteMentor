# Session Tree 与 Compaction 设计

- 状态：M1～M6 已确认完成
- 实现分支：`feat/session-tree-compaction`
- 总索引：[`session-tree-and-compaction.md`](../.session/session-tree-and-compaction.md)

> 本文是 Session 树、上下文重建、导航、摘要与压缩的正式设计稿。它只定义 M1～M6；运行时接入和 TUI 集成分别由另外两份模块文档承接。

## 模块边界

本模块负责：

- 用户可见的 `/fork`、`/tree`、`/compact` 产品语义与首版范围；
- Session Entry 领域模型与 SQLite 持久化；
- active leaf、活动路径、model/thinking-level 状态与 provider 上下文重建；
- Tree/Fork、Branch Summary、token 预算与 Compaction 算法；
- 向 Runtime 提供稳定的 Store、Context、Navigation、Summary 与 Compaction 能力。

本模块不负责：

- AgentLoop/AgentRunner 的 checkpoint、流式响应、工具执行与崩溃恢复；
- MessageBus、per-session mailbox、`pendingQueue` 和 Session 调度；
- CLI/TUI 命令接线、Tree selector 和最终交互呈现。

## 1. M1 产品行为与首版边界

### 1.1 总体语义

- `/fork` 把一条历史路径抽离为具有独立生命周期的新 session；新 session 使用新 ID，不保留与原 session 的持久化父子/来源关系。
- `/fork` 只列出 user message。默认在该消息之前分叉：新 session 截止于其 parent，消息原文回填编辑器作为未发送草稿。
- `/fork` 不生成分支摘要；原 session 不变，完成后当前运行上下文整体切换到新 session。
- `/tree` 不创建 session，只在当前 session 的树中移动 active leaf；其他路径原地保留，可再次切回。
- `/tree` 首版可选择 user、非纯 tool-call assistant、tool result。user 导航到其 parent 并回填草稿；assistant/tool result 导航到 entry 本身。
- Tree 导航允许选择直接跳转或生成 `branch_summary` 后跳转。
- 导航到带未配对 tool call 的 assistant entry 时，在发送模型前补 synthetic error tool result，避免构造非法 provider 请求。
- `/tree` 首版只有 `default` 视图，不提供过滤切换；model/thinking 等设置 entry 不显示，但仍被持久化并影响活动分支状态。
- pi 的 JSONL 文件存储不直接照搬；Byte Mentor 的 fork 目标是一个完全独立的 SQLite session。
- `/compact` 手动压缩和 turn 间自动压缩均纳入首版；触发条件与压缩边界留到 M6。
- `/clone`、fork extension hook、label 重挂均不纳入首版。

M1 已完成。后续模块可以补充实现细节，但不再改变上述产品语义，除非明确回到 M1 重新讨论。

### 1.2 暂缓范围

- 树搜索
- 节点过滤及 `default/all` 等模式切换
- 标签/书签
- 复制节点内容
- 自定义分支摘要提示

### 1.3 详细决策

以下记录 M1 已确认的详细产品决策。

#### 1.3.1 `/fork` 分叉入口（已确认）

- `/fork` 只显示 user message，其他 entry 不可见。
- 默认采用 `before` 语义：复制 root 到所选 user message 的 parent 的单条路径，创建新 session。
- 新 session 获得新 ID，不记录来源 session；原 session 保持不变，当前运行上下文切换到新 session。
- 所选 user message 的原文回填编辑器，只作为可修改、可放弃的草稿，不自动发送。
- `/fork` 不生成摘要。
- session 必须已有持久化内容才允许 fork；“至少一条 assistant 回复”的准确约束结合当前持久化时机在 M7 落实。

`clone` 使用的 `at` 语义以及 label 重挂逻辑来自 pi，但不自动纳入本版本范围；label 本身已明确后补。复制时的 ID/parent 处理留到 M3。

#### 1.3.2 `/tree` 的操作语义（已确认）

- `/tree` 在同一 session 内移动 active leaf，不创建新 session，不删除任何路径。
- 首版导航目标只包括 user、非纯 tool-call assistant 和 tool result。
- 选中 user message 时，leaf 移到其 parent，并把原消息放入编辑器作为草稿。
- 选中 assistant/tool result 时，leaf 移到该 entry 本身。
- 离开旧活动路径时，可以直接跳转，也可以生成 `branch_summary` 后跳转。
- 选中 tool result 时直接停在该 entry；选中带 tool call 的 assistant entry 时允许形成暂时悬空的 tool call，由上下文转换层补 synthetic error result。
- 固定使用 `default` 视图：隐藏纯 tool-call assistant message，以及 label、custom、model change、thinking-level change、session info 等设置/记账 entry。
- tool result 和普通对话 message 保持可见、可选。
- compaction 与 branch summary 保持可见，但首版不可选；model/thinking 等设置 entry 不显示。

#### 1.3.3 `/tree` 的最小过滤范围（已确认）

- 首版只实现 `default` 模式。
- 不实现 `all`、`no-tools`、`user-only`、`labeled-only` 或过滤快捷键。
- default 视图可见不等于可选择：compaction 与 branch summary 只展示；user、非纯 tool-call assistant、tool result 才是导航目标。

#### 1.3.4 `/clone` 是否纳入首版（已收口）

`/clone` 对应 pi 的 `position: "at"`：把当前活动路径原样复制成新 session。它和 `/fork` 相近，但不是实现树导航与压缩的必要条件，本版本不实现。

## 2. M2 Session Entry 领域模型

### 2.1 已确认的建模方向

- 使用 `BaseEntry` 作为所有持久化 entry 的共同基础。
- user、assistant、tool result、compaction、branch summary、model change、thinking-level change 分别建模。
- tool call 不单独成为 entry，作为 `AssistantEntry.toolCalls` 的一部分。
- Tree 首版可选 user、带文本的 assistant、tool result；纯 tool-call assistant 不显示、不可选。
- compaction、branch summary 都是 tree entry。
- Tree 导航本身不是 entry；它只更新 session 的 active leaf 指针。
- fork 只选择 user entry；fork 不写 `ForkEntry`，也不在新旧 session 之间保留持久化关系。

### 2.2 基础类型

Entry 是纯持久化数据，推荐用 TypeScript discriminated interface，而不是带行为的 runtime class。领域操作由后续的 Session 领域对象负责。

```ts
type EntryId = string;
type EntrySequence = number;

interface BaseEntry {
  id: EntryId;
  sequence: EntrySequence;
  parentId: EntryId | null;
  createdAt: string;
}
```

字段语义：

- `id`：session 内使用的稳定 entry ID；新数据使用 UUID。同一个 session 内唯一。
- `sequence`：session 内严格递增的追加顺序，用于稳定排序和审计；它不表达 parent 关系。
- `createdAt`：UTC ISO 8601 时间，只用于展示，不承担排序正确性。
- `parentId`：对话树中的父节点；根 entry 为 `null`。
- `sessionId` 不进入领域 Entry；SessionStore 在读写 API 与 SQLite 行上负责 session 归属，具体映射留到 M3。

Entry ID 同时作为该 user/assistant/tool-result 消息的身份，不再额外保存 `messageId`，避免两个 ID 漂移。

### 2.3 共用值对象

```ts
interface ModelRef {
  provider: string;
  modelId: string;
}

type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

interface ToolCall {
  id: ToolCallId;
  name: string;
  args: unknown;
  argsParseError?: string;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
```

`TokenUsage` 的 provider 映射、缺失字段处理和本地估算不在 M2 决定，留到 M6。

### 2.4 对话 Entry

#### UserEntry

```ts
interface UserEntry extends BaseEntry {
  type: "user";
  content: string;
}
```

- 是 `/fork` 唯一可选类型。
- Tree 选中它时，实际导航目标是 `parentId`，`content` 回填编辑器作为草稿。

#### AssistantEntry

```ts
interface AssistantEntry extends BaseEntry {
  type: "assistant";
  content: string;
  toolCalls: ToolCall[];
  model: ModelRef;
  stopReason: StopReason;
  usage?: TokenUsage;
}
```

- `content` 和 `toolCalls` 使用必填空值（`""`/`[]`），避免持久化后区分 missing 与 empty。
- `model` 记录这条回复实际使用的模型，不依赖当前活动 model 状态反推。
- 只有 `content` 非空、出错/中断，或它是当前 leaf 时，才在 Tree 的 default 视图显示；纯 tool-call assistant 通常隐藏且不可选。
- 一个 assistant 可以包含多个 tool call；不拆成多个树节点。

#### ToolResultEntry

```ts
interface ToolResultEntry extends BaseEntry {
  type: "tool_result";
  toolCallId: ToolCallId;
  toolName: string;
  content: string;
  isError: boolean;
}
```

- `toolCallId` 必须能在活动祖先路径中找到对应的 `AssistantEntry.toolCalls[].id`。
- 每个 tool result 是独立树节点；同一 assistant 的多个结果按持久化顺序串在路径上。
- Tree 可以直接选中 tool result，下一轮上下文保留到该结果为止。

### 2.5 状态 Entry

#### ModelChangeEntry

```ts
interface ModelChangeEntry extends BaseEntry {
  type: "model_change";
  model: ModelRef;
}
```

- 表示从该节点之后使用的新模型。
- 不转成 provider message；沿活动路径扫描最后一个 model change 恢复状态。
- Tree default 视图隐藏且不可选。

#### ThinkingLevelChangeEntry

```ts
interface ThinkingLevelChangeEntry extends BaseEntry {
  type: "thinking_level_change";
  level: ThinkingLevel;
}
```

- 表示从该节点之后使用的新 thinking level。
- 不转成 provider message；沿活动路径扫描最后一个 thinking-level change 恢复状态。
- Tree default 视图隐藏且不可选。

### 2.6 摘要 Entry

#### CompactionEntry

```ts
interface CompactionEntry extends BaseEntry {
  type: "compaction";
  summary: string;
  firstKeptEntryId: EntryId | null;
  tokensBefore: number;
  trigger: "manual" | "automatic";
  model: ModelRef;
  usage?: TokenUsage;
}
```

- `parentId` 是压缩发生时的 active leaf。
- `firstKeptEntryId` 指向压缩后仍以原文保留的最早 entry；`null` 表示不保留旧的原文尾部。
- `tokensBefore` 是压缩前上下文 token 数，用于诊断和 UI。
- `model`/`usage` 记录摘要实际由哪个模型、以多少 token 生成。
- 构建模型上下文时转换为 synthetic summary message。

#### BranchSummaryEntry

```ts
interface BranchSummaryEntry extends BaseEntry {
  type: "branch_summary";
  sourceLeafId: EntryId | null;
  summary: string;
  model: ModelRef;
  usage?: TokenUsage;
}
```

- `parentId` 是 Tree 导航的目标位置；summary 作为该位置的 child，成为导航后的 active leaf。
- `sourceLeafId` 通常是导航前旧分支的 active leaf。结合 `parentId` 可以稳定推导最近公共祖先和被总结区间；fork 到独立 session 时，如果该 source leaf 不在复制路径中则置为 `null`，摘要文本仍然有效。
- 构建模型上下文时转换为 synthetic summary message。

按照本轮最新的可选节点列表，compaction 和 branch summary 可以在 transcript/Tree 中展示，但首版不是 Tree 的导航目标。如果希望它们也可选，需要回改 M1 的节点范围。

### 2.7 导航为何不需要 Entry

- `parentId` 已经完整表达所有历史分支的树关系。
- session 单独保存可变的 `activeLeafId`，表达用户当前停留的位置。
- 直接 Tree 导航只更新 `activeLeafId`，不创建 entry。
- 带摘要导航在目标位置追加 `BranchSummaryEntry`，再把 `activeLeafId` 指向该 summary。
- `/fork` 创建完全独立的新 session 并复制单条路径，不记录来源关系。
- 当前没有导航审计/撤销需求，因此记录每次指针移动只会增加引用和事务复杂度。

### 2.8 SessionEntry union 与不变量

```ts
type SessionEntry =
  | UserEntry
  | AssistantEntry
  | ToolResultEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry;
```

共同不变量：

- entry 一经提交不可修改、不可删除。
- `sequence` 按 session 严格递增。
- `parentId` 只能指向同一 session 中更早的 entry，或为 `null`。
- active leaf 只能指向当前 session 的 entry 或为 `null`。
- persisted entry 不保存可由 parent 链稳定推导的 previous model/thinking state。

### 2.9 M2 整体 Review 点

需要一起确认：

- 单一 `BaseEntry` 直接包含 `parentId`；
- 七种具体 Entry 及上述字段；
- tool call 内嵌 assistant、tool result 独立成节点；
- 不引入 navigation entry，active leaf 是 session 状态；
- compaction/branch summary 首版可见但不可作为 Tree 导航目标。

M2 已确认完成。

## 3. M3 SQLite 持久化模型

状态：已确认完成。

### 3.1 sessions

```sql
CREATE TABLE sessions (
  id                TEXT    NOT NULL PRIMARY KEY,
  workspace_root    TEXT    NOT NULL,

  initial_provider       TEXT NOT NULL,
  initial_model_id       TEXT NOT NULL,
  initial_thinking_level TEXT NOT NULL CHECK (
    initial_thinking_level IN (
      'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
    )
  ),

  active_leaf_id    TEXT,
  next_entry_seq    INTEGER NOT NULL DEFAULT 1
                            CHECK (next_entry_seq > 0),

  metadata_json     TEXT    NOT NULL DEFAULT '{}'
                            CHECK (json_valid(metadata_json)),

  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,

  FOREIGN KEY (id, active_leaf_id)
    REFERENCES session_entries(session_id, id)
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;
```

字段职责：

- `id`：session ID。
- `workspace_root`：session 所属工作区。
- `initial_provider`/`initial_model_id`：Session 第一次发送消息时使用的初始模型。它们是状态 Entry 的回放基线，不随应用默认配置变化。
- `initial_thinking_level`：Session 第一次发送消息时使用的初始 thinking level，同样作为回放基线。
- `active_leaf_id`：当前活动分支位置；直接 Tree 导航只改变这个状态，不写 navigation entry。
- `next_entry_seq`：下一次追加使用的 session 内 sequence，避免通过 `MAX(entry_seq)` 分配。
- `metadata_json`：暂存 runtime checkpoint 等非查询状态；M7 已确认 checkpoint 从 `ready_for_iteration` 开始承载整个 pending Turn。
- `created_at`/`updated_at`：创建时间和最近活动时间。

`active_leaf_id` 使用复合外键，保证它只能指向同一 session 的 entry；空 session 可以为 `null`。

### 3.2 session_entries

```sql
CREATE TABLE session_entries (
  session_id   TEXT    NOT NULL,
  id           TEXT    NOT NULL,
  entry_seq    INTEGER NOT NULL CHECK (entry_seq > 0),
  parent_id    TEXT,
  type         TEXT    NOT NULL CHECK (
    type IN (
      'user',
      'assistant',
      'tool_result',
      'compaction',
      'branch_summary',
      'model_change',
      'thinking_level_change'
    )
  ),
  created_at   TEXT    NOT NULL,
  payload_json TEXT    NOT NULL CHECK (json_valid(payload_json)),

  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, entry_seq),

  CHECK (parent_id IS NULL OR parent_id <> id),

  FOREIGN KEY (session_id)
    REFERENCES sessions(id)
    ON DELETE CASCADE,

  FOREIGN KEY (session_id, parent_id)
    REFERENCES session_entries(session_id, id)
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;
```

字段职责：

- `session_id`：entry 所属 session。
- `id`：session 内稳定的 entry ID。
- `entry_seq`：session 内严格递增的追加顺序，不表示树父子关系。
- `parent_id`：树上的父 entry；根 entry 为 `null`。
- `type`：M2 确认的七种 Entry discriminator。
- `created_at`：展示/诊断时间；稳定顺序使用 `entry_seq`。
- `payload_json`：保存具体 Entry 独有字段；不重复保存公共字段。

领域类型分开，但存储采用一张公共 entry 表。当前读取模式以整棵树、活动路径和 Entry union 为主，拆成七张子表只会增加 JOIN/UNION 与写入事务复杂度。

### 3.3 暂不引入的表

- legacy `messages` 表及迁移逻辑；开发期直接使用新数据库。
- 七种 Entry 子表。
- `session_sequences`；sequence 状态保存在 `sessions.next_entry_seq`。
- `branch_entries`、`session_materialized`、`entry_materialized` 等物化优化表。
- 搜索/FTS、标签或工具统计表。

### 3.4 索引设计

`sessions` 索引已确认：除 `PRIMARY KEY (id)` 自动提供的索引外，首版不建立额外索引。当前所有核心操作都按 session ID 定位；session picker、来源谱系和跨 workspace 排序均不在首版范围。

`session_entries` 首版同样不建立显式索引，使用约束已有的数据结构：

- `PRIMARY KEY (session_id, id)`：在 `WITHOUT ROWID` 表中作为表本身的组织方式，支持按 ID 读取 entry，以及沿 `parent_id` 向上重建路径。
- `UNIQUE (session_id, entry_seq)`：由 SQLite 自动建立唯一索引，既保证 session 内 sequence 唯一，也支持按 `entry_seq` 有序加载整个 session。

首版按 `(session_id, entry_seq)` 全量加载一个 session 的所有 entry，再在内存中构建 `id -> entry` 和 `parentId -> children` 映射。`/fork` 与 `/tree` 都基于这棵内存树工作，因此暂不建立 `(session_id, type, entry_seq)` 或 `(session_id, parent_id, entry_seq)` 索引，也不在 entry 中冗余保存 child ID 列表。

如果未来改为按树结构懒加载，再根据直接子节点查询引入 `(session_id, parent_id, entry_seq)`；不为未实现的分页或懒加载提前增加索引。

### 3.5 Turn 内工具状态与崩溃恢复

Session Entry 只保存已经完成提交的会话历史。一个 Turn 内尚未提交的 ReAct 轨迹继续由 `sessions.metadata_json` 中的 runtime checkpoint 承担，不新增 `tool_executions` 表：

- provider 产生一批 tool calls 后、执行任何工具前，必须先持久化 `awaiting_tools` checkpoint；如果该 checkpoint 写入失败，则不执行工具。
- checkpoint 保存当前 Turn 从第一轮 ReAct iteration 开始累计的 assistant/tool 消息，以及当前批次的 pending tool calls。
- 整批工具完成后，按 assistant 中原始 tool call 顺序组装结果，将完整 ToolResult 批次写入 `ready_for_iteration` checkpoint。
- Turn 正常结束后，再把累计轨迹转换为 Session Entry，并按照 3.7 在同一事务中统一写入 Session、推进 leaf/sequence 和清理 checkpoint。

首版 checkpoint 只记录“整批执行前”和“整批执行后”两个稳定状态，不记录同一批内每个工具的部分完成状态。若部分工具可能已经完成、但包含完整 ToolResult 批次的 `ready_for_iteration` checkpoint 尚未持久化时进程崩溃，恢复逻辑对该批所有 pending tool calls 补齐 `isError: true` 的 ToolResult。这个错误表达的是“结果未知”，不能表达成“工具明确执行失败”。错误内容必须明确告诉模型：

```text
Tool execution was interrupted before its result was durably recorded.
The tool may have completed and side effects may have occurred.
Its outcome is unknown. Do not retry automatically.
Verify external state or ask the user before retrying.
```

恢复只负责物化 checkpoint、闭合 tool-call/tool-result 边界，不自动继续旧 ReAct iteration，也不自动重试工具。幂等键与下游状态查询不是首版依赖；未来只有在需要自动确认结果或安全重试副作用工具时再引入。

该方案选择保守恢复：同批部分已完成工具的真实结果可能丢失，但不会把未知结果伪装成明确失败，也不会因恢复流程自动重复副作用。

### 3.6 Session 写入并发模型

首版采用“每个 Session 单一逻辑 writer”：同一时刻只允许一个会改变该 Session 状态的业务操作。后续通过消息队列串行调度同一 Session 的 Turn、checkpoint、`/tree`、`/compact`、`/fork` 等命令，不依赖 SQLite 的写锁决定业务顺序。

不同 Session 可以同时执行各自的模型请求、工具和其他内存/外部工作；SQLite 仍会在数据库层面串行提交短暂的写事务。

逻辑操作权与数据库事务分开：一个 Agent Turn 可以在整个运行期间占用该 Session 的逻辑 writer，但模型请求、工具执行和摘要生成不包含在数据库事务内。数据库事务只包围 checkpoint 更新和最终状态提交等短暂持久化步骤，避免长时间占用 SQLite writer。

首版不引入 session version 或乐观并发重试协议，也不只依赖“最后提交者覆盖”解决同一 Session 的写冲突。

### 3.7 Turn 最终提交

一个 Turn 在运行期间只更新统一的 runtime checkpoint；Turn 到达可提交终态后，再把 checkpoint 中累计的 user、assistant、tool result 以及可能在 Turn 内生成的 compaction 转换为一批有序 Session Entry。

整批 Entry 的写入使用一个短暂的 `BEGIN IMMEDIATE` 事务，并在同一事务中完成：

1. 读取并校验当前 `active_leaf_id` 仍等于 Turn 开始时的 leaf。
2. 从 `sessions.next_entry_seq` 开始，为本批 Entry 分配连续的 `entry_seq`。
3. 第一条 Entry 的 `parent_id` 指向原 active leaf；后续 Entry 按 Turn 内顺序依次连接前一条 Entry。空 Session 的第一条 Entry 使用 `parent_id = null`。
4. 插入本批全部 Entry。
5. 把 `active_leaf_id` 推进到本批最后一条 Entry，并把 `next_entry_seq` 增加本批 Entry 数量。
6. 仅从 `metadata_json` 中移除 `runtime_checkpoint`，保留其他 metadata，同时更新 `updated_at`。

任意步骤失败则整个事务回滚：不会留下部分 Entry，leaf 和 sequence 不推进，checkpoint 仍可用于恢复。事务提交成功后，Entry、leaf、sequence 和 checkpoint 清理同时可见，不会把同一 Turn 再次恢复。

模型请求、工具执行和其他 Turn 运行过程不包含在该数据库事务内。Entry ID 可以在事务前生成，但只有事务提交后才成为持久化事实。

### 3.8 Checkpoint 更新

checkpoint 的阶段性更新只修改 `sessions.metadata_json` 中的确定字段，使用单条 SQLite JSON 更新语句，不执行“先 SELECT 全量 metadata、在应用层合并、再 UPDATE”的读改写流程。例如 runtime checkpoint 使用：

```sql
UPDATE sessions
SET metadata_json = json_set(
      metadata_json,
      '$.runtime_checkpoint',
      json(:checkpoint_json)
    ),
    updated_at = :now
WHERE id = :session_id
RETURNING metadata_json;
```

单条 `UPDATE` 自带 SQLite 隐式事务，无需额外开启显式事务。崩溃后只可能保留完整旧 checkpoint 或完整新 checkpoint，不会留下部分 JSON；`json_set` 也不会覆盖其他 metadata 字段。

`awaiting_tools` checkpoint 必须成功提交后才能执行该批工具；包含完整 ToolResult 批次的 `ready_for_iteration` checkpoint 必须成功提交后才能进入下一轮 provider 调用。checkpoint 更新失败时停止当前 Runner 流程，不继续执行下一阶段。

Turn 最终提交仍按照 3.7 使用显式事务，因为它需要原子地修改多个 Entry、leaf、sequence 和 checkpoint 状态。

### 3.9 Tree 直接导航

Tree 直接导航不创建 Entry，只使用单条 `UPDATE` 修改 `sessions.active_leaf_id` 与 `updated_at`，依靠单语句的隐式事务：

```sql
UPDATE sessions
SET active_leaf_id = :target_leaf_id,
    updated_at = :now
WHERE id = :session_id
RETURNING active_leaf_id;
```

领域层先基于内存树验证节点是否可导航，并计算实际目标：user entry 使用其 `parent_id`，同时返回 user content 作为编辑器草稿；assistant/tool result 使用自身 ID。复合外键保证非空目标属于当前 session，`null` 表示根之前的空位置。

数据库更新成功后再重建 transcript 和更新编辑器。数据库失败时 UI 状态不变；更新成功后进程崩溃则保留新 leaf，但未发送草稿可以丢失，不进入 session 持久化。

### 3.10 带 Branch Summary 的 Tree 导航

摘要生成是外部模型调用，不能包含在数据库事务内。整个操作仍占用当前 session 的逻辑 writer，按两个阶段执行：

1. 在内存中确定导航前 `sourceLeafId`、实际目标 `targetLeafId` 和待总结区间，构造不可变的摘要输入。
2. 在没有数据库事务的情况下调用模型生成摘要。
3. 摘要成功后开启短暂的 `BEGIN IMMEDIATE` 事务，重新读取并校验 `active_leaf_id` 仍等于 `sourceLeafId`。
4. 使用当前 `next_entry_seq` 插入一条 `BranchSummaryEntry`：`parent_id = targetLeafId`、payload 中记录 `sourceLeafId`、摘要模型和 usage。
5. 同一事务把 `active_leaf_id` 指向新 summary，`next_entry_seq` 加一并更新 `updated_at`，然后提交。

摘要失败或取消时不写 Entry、不移动 leaf。数据库提交失败时整个写入回滚，原 leaf 保持不变；已经生成但未提交的摘要只存在内存中，可以重试数据库提交，不需要再次请求模型。

如果导航选择的是 user entry，草稿仍然只在数据库提交成功后回填编辑器。目标位置、总结区间和失败后的具体用户提示留在 M5 细化，不改变上述事务边界。

### 3.11 Compaction

手动和自动 compaction 使用相同事务形态，并作为 session 消息队列中的独占逻辑操作执行：

1. 捕获当前 `sourceLeafId`、活动路径、cut point 和摘要输入。
2. 在数据库事务外调用模型生成压缩摘要。
3. 成功后开启短暂的 `BEGIN IMMEDIATE` 事务，校验当前 active leaf 仍为 `sourceLeafId`。
4. 使用当前 `next_entry_seq` 插入 `CompactionEntry`，其 `parent_id = sourceLeafId`；领域层在写入前保证 `firstKeptEntryId` 为该活动路径中的合法节点或 `null`。
5. 同一事务把 active leaf 推进到 compaction entry、`next_entry_seq` 加一并更新 `updated_at`。

摘要生成失败或取消时不修改 session。提交失败时 Entry、leaf 和 sequence 一起回滚；成功后再重建模型上下文。触发条件、cut point 和摘要更新算法留到 M6，不在数据库事务中决定。

上述立即插入事务适用于 Agent 空闲时的手动 Compaction，以及新 Turn 正式进入 ReAct 前对已有持久化路径执行的 Compaction。M6 进一步确认：Turn 内也可以在完整 tool 批次结束后的安全点生成 pending Compaction。该 Entry 先进入 runtime checkpoint，与本 Turn 其他 pending Entry 一起在 Turn 最终提交事务中统一插入；Turn 内摘要生成期间不提前移动数据库中的 active leaf。具体 checkpoint 状态机在 M7 落实。

### 3.12 Fork

Fork 命令在源 session 的消息队列中串行执行。源 session 已全量加载且在操作期间没有其他逻辑 writer，因此先在内存中取得 root 到所选 user entry 之 parent 的稳定单路径，再用一个 `BEGIN IMMEDIATE` 事务原子创建新 session：

1. 插入新的 `sessions` 行，使用新 session ID，不保存源 session/parent session 关系；`workspace_root` 继承当前 workspace，初始 model/thinking-level 基线复制自源 Session，metadata 初始为空，active leaf 初始为 `null`。
2. 按路径顺序复制 Entry 行。Entry ID、tool call ID、内容和原始 `created_at` 保持不变；`entry_seq` 在新 session 中从 1 开始连续重排，parent 仍指向复制路径中的前驱。
3. 对 payload 中的 Entry 引用进行归一化：复制路径内的引用保持有效；`BranchSummaryEntry.sourceLeafId` 等指向路径外节点的引用置为 `null`。`CompactionEntry.firstKeptEntryId` 不在复制路径中时同样置为 `null`。
4. 把新 session 的 active leaf 设置为复制路径最后一条 Entry（空路径为 `null`），`next_entry_seq` 设置为复制数量加一并提交。

任意步骤失败则新 session 整体不存在，源 session 始终不修改。只有数据库提交成功后，runtime 才切换到新 session，并把所选 user 内容回填为未发送草稿；切换或 UI 更新失败不会回滚已经独立创建的 session。

复用 Entry ID 不会建立新旧 session 的持久化关系：Entry ID 的唯一性范围本来就是 session，数据库主键也包含 `session_id`。这样可以保留复制路径中已有的内部引用，同时避免无必要的 ID 重写。

### 3.13 Checkpoint 恢复提交

恢复 runtime checkpoint 时，从其 pending Entry 链物化出 user、assistant 和 tool result，走和 Turn 最终提交相同的批量追加事务：插入全部恢复 Entry、推进 active leaf/sequence，并在同一事务中移除 `runtime_checkpoint`。

恢复提交前崩溃时 checkpoint 仍在且没有部分 Entry；提交后 checkpoint 已清除且完整恢复路径已存在，因此不会重复物化。同批 pending tool calls 按 3.5 补“结果未知”的错误 ToolResult。非法 checkpoint 不产生 Entry，只用单条 JSON `UPDATE` 移除对应 metadata key。

### 3.14 SQLite 事务配置与共同规则

首版连接初始化明确设置：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

- `WAL` 允许读取旧快照时继续进行短写事务；同一时刻仍只有一个 SQLite writer。
- `synchronous = FULL` 优先保证 checkpoint 和 Session 提交在进程或系统异常后的持久性；若未来有实测性能瓶颈再评估 `NORMAL`。
- `busy_timeout` 只处理不同 session/连接之间短暂的 writer 竞争，不替代应用层消息队列。
- 修改 Entry 与 Session 行的复合操作统一使用短暂的 `BEGIN IMMEDIATE`；单条 `UPDATE` 使用隐式事务。
- 不在数据库事务中等待 provider、工具、用户输入或其他外部 I/O。
- 所有事务检查受影响行数；session 不存在、目标引用非法或约束失败都作为存储错误返回，不静默忽略。
- `DEFERRABLE INITIALLY DEFERRED` 外键在事务提交时统一检查，允许同一事务内先建立一组相互引用、最终整体合法的 Session/Entry 状态。

M3 至此确认了表结构、约束、索引、全量加载策略、checkpoint 边界、单 writer 并发模型以及各核心写操作的事务边界。具体上下文重建、导航摘要区间与 compaction 算法分别进入 M4、M5、M6 继续讨论。

## 4. M4 活动分支与模型上下文重建

状态：已确认完成。

### 4.1 活动路径重建（已确认）

Session 首版仍按 M3 的方案全量加载全部 Entry，并建立 `id -> entry` 映射。模型所使用的活动路径从 `sessions.active_leaf_id` 开始，沿 `parent_id` 逐级向上追溯至 `null`，再反转为从虚拟根到 active leaf 的顺序。

- `active_leaf_id = null` 时活动路径为空。
- `parent_id = null` 表示 Entry 直接挂在 Session 的虚拟根下；同一 Session 可以存在多个根级分支。
- sibling 和其他非祖先分支不进入活动路径，也不进入本次模型上下文。
- `entry_seq` 不参与树关系计算，只承担稳定顺序和结构校验；父 Entry 的 sequence 必须小于子 Entry。
- 全量加载与建表为 `O(n)`，在 `id -> entry` 映射上追溯活动路径为 `O(d)`，其中 `d` 是活动路径深度。

重建时必须检测以下损坏：

- 非空 active leaf 在当前 Session 中不存在；
- `parent_id` 指向不存在的 Entry；
- parent 链出现循环；
- parent 的 `entry_seq` 不早于 child；
- 其他违反 M2/M3 已确认不变量、导致路径身份不可信的情况。

发现上述问题时采用严格失败策略：直接报告 Session 已损坏，阻止构建 provider 上下文和继续发送消息；不截断路径继续运行，也不自动修改数据库修复。

### 4.2 模型与 thinking level 状态恢复（已确认）

Session 持久化创建时的初始 model 和 thinking level，作为活动路径状态回放的基线。恢复时从该基线开始，按 root 到 active leaf 的顺序扫描：

- 遇到 `ModelChangeEntry` 时覆盖当前 model；
- 遇到 `ThinkingLevelChangeEntry` 时覆盖当前 thinking level；
- 同类状态 Entry 出现多次时，以活动路径上最后一条为准；
- 非活动分支上的状态 Entry 不生效；
- `AssistantEntry.model` 只记录该回复实际使用的模型，不用于恢复后续运行状态；
- model/thinking-level Entry 不转换为 provider message。

Session 采用延迟创建：Home/New Session 页面不对应持久化 Session，也不新增 `NewSessionState` 领域类。应用仅用 `currentSessionId = null` 表示尚未进入已持久化会话；编辑器草稿、当前 model/thinking level 和 workspace 继续由各自已有的 UI/应用运行时状态持有。

用户第一次发送消息时，使用当时选中的 model/thinking level 原子创建 Session，并在同一条 Session 插入中写入 `phase = "ready_for_iteration"` 的 runtime checkpoint。创建成功后才设置 `currentSessionId` 并调用模型；创建失败则保留 Home 和编辑器内容，不调用模型。`/new` 只把当前 Session 选择恢复为 `null` 并清空当前 transcript，不预先插入空 Session。

Fork 创建的新 Session 复制源 Session 的初始 model/thinking-level 基线，使复制路径中的状态 Entry 在两个 Session 中得到相同的回放结果。

### 4.3 普通 Entry 到 provider message 的映射（已确认）

上下文重建层先把活动路径转换为项目统一的 `Message[]`，再由各 provider adapter 转换为 OpenAI、Anthropic 等具体协议。Session/ContextBuilder 不直接生成 provider 专属请求，也不在数据库中持久化 provider message JSON。

普通 Entry 的基础映射为：

- `UserEntry` 转换为 `UserMessage`；
- `AssistantEntry` 转换为 `AssistantMessage`，保留文本和内嵌 tool calls；
- `ToolResultEntry` 转换为 `ToolMessage`，保留 `toolCallId` 和 `content`；
- `ModelChangeEntry` 与 `ThinkingLevelChangeEntry` 不生成消息，只按 4.2 恢复运行状态；
- `BranchSummaryEntry` 与 `CompactionEntry` 的映射在后续小节单独定义。

Entry ID 继续作为转换后消息的内部 Message ID。`ToolResultEntry.toolName` 和 `isError` 用于领域校验、诊断和 UI，不要求成为 provider 协议字段；模型需要知道的错误性质和原因必须已经明确包含在 `content` 中。

provider adapter 只负责统一 Message 与具体 API 协议之间的格式转换，不感知 Session 树、active leaf、状态回放或 compaction 规则。

### 4.4 Tool call/result 归一化边界（沿用现有能力）

`/tree`、`/fork` 与其他 Session 命令只在完整 Turn 结束、Agent 处于空闲状态时执行，不在正在运行的 tool-call 批次中改变 active leaf。

项目已有的消息转换机制负责为缺少结果的 tool call 补占位 ToolResult；本设计不重复实现或扩展该行为，也不把 synthetic ToolResult 持久化成 Session Entry。M4 只负责从活动路径提供普通 Assistant/ToolResult 消息，之后复用现有归一化流程。

### 4.5 Branch Summary 的上下文映射（已确认）

`BranchSummaryEntry` 在统一模型上下文中转换为 `UserMessage`，但 UI 仍按独立的 Branch Summary Entry/组件展示，不伪装成真实用户消息。

转换使用固定说明和边界标记：

```text
The following is a summary of a branch that this conversation returned from:

<branch_summary>
{summary}
</branch_summary>
```

- 转换后消息的位置就是 `BranchSummaryEntry` 在有效活动路径中的位置；
- `sourceLeafId` 只用于领域追踪和诊断，不发送给模型；
- wrapper 固定，不允许首版自定义；自定义 branch-summary prompt 继续留在暂缓范围；
- 不使用 Assistant role，以免把摘要伪装成当时的模型回复；
- 不使用 system/developer role，避免给历史摘要不必要的指令优先级。

### 4.6 Compaction 的上下文裁剪规则（已确认）

如果完整活动路径上不存在 `CompactionEntry`，provider 上下文使用完整活动路径中的上下文 Entry。如果存在多个 Compaction，只由活动路径上最后一个 Compaction 控制当前上下文；不从头重复应用每次压缩。

假设最后一个 Compaction 在完整活动路径中的位置为 `C`，其合法 `firstKeptEntryId` 的位置为 `K`，则压缩感知的有效上下文 Entry 为：

```text
[C] + [K ... C 之前] + [C 之后 ... active leaf]
```

即先放最新 Compaction 摘要，再放压缩时决定保留的原文尾部，最后放压缩完成后新增的活动路径内容。`firstKeptEntryId = null` 时不保留 `C` 之前的原文尾部。

- 新 Compaction 的生成输入已经包含生成当时生效的旧摘要和保留尾部，因此它接替更早的 Compaction；旧摘要不会再次单独注入。
- 不在当前活动祖先路径上的 Compaction 完全不生效。
- Tree 跳到 Compaction 之前时，它不再是活动祖先，原始历史自然恢复；跳到它之后时则继续生效。
- 非空 `firstKeptEntryId` 必须位于同一条完整活动路径上、严格早于该 Compaction；否则报告 Session 损坏。
- Compaction 只裁剪发送给 provider 的消息范围，不裁剪 4.2 的运行状态回放。model/thinking level 始终从完整的 root 到 active leaf 路径恢复。

### 4.7 Compaction Summary 的上下文映射（已确认）

压缩感知路径中的 `CompactionEntry` 转换为 `UserMessage`，使用该 Entry ID 作为转换后的内部 Message ID。UI 仍按独立的 Compaction Entry/组件展示。

转换使用固定格式：

```text
The conversation history before this point was compacted into the following summary:

<compaction_summary>
{summary}
</compaction_summary>
```

- Compaction Summary 位于压缩感知有效上下文的最前面，后面依次为 `firstKeptEntryId` 开始的原文尾部和 Compaction 之后的新内容；
- `tokensBefore`、`trigger`、摘要使用的 `model` 与 `usage` 只用于 UI、审计和诊断，不发送给模型；
- wrapper 首版固定；
- 不使用 Assistant role 或 system/developer role，理由与 Branch Summary 相同。

### 4.8 恢复状态当前不可用（已确认）

model/thinking-level 状态始终按照 Session 基线和活动路径精确恢复，不因当前应用配置或 provider 能力变化而静默改写。如果恢复出的模型当前不存在、provider 凭据不可用，或 thinking level 不被恢复出的模型支持：

- Session 不判定为损坏；其持久化结构和历史状态仍然合法；
- 阻止新的模型请求，并明确报告当前运行环境无法执行该状态；
- 不静默回退到应用默认值；
- 不在打开 Session 或 Tree 导航时自动追加状态 Entry；
- 用户手动选择可用状态后，正常追加 `ModelChangeEntry` 或 `ThinkingLevelChangeEntry`，再允许发送消息。

### 4.9 上下文重建流水线（M4 收口）

一次完整重建按以下顺序执行：

1. 全量加载 Session Entry，建立内存索引并校验基础不变量。
2. 从 active leaf 沿 parent 链重建完整活动路径；结构损坏时严格失败。
3. 从 Session 初始基线开始扫描完整活动路径，恢复 model 与 thinking level。
4. 在完整活动路径中找到最后一个 Compaction，生成压缩感知的有效上下文 Entry。
5. 把普通 Entry、Branch Summary 和 Compaction Summary 转换为统一 `Message[]`；状态 Entry 不生成消息。
6. 复用现有 tool-call/tool-result 归一化机制补齐模型协议需要的占位结果。
7. 校验恢复出的运行状态在当前环境可执行；不可执行时阻止请求并等待用户明确切换。
8. 将统一消息交给 provider adapter，转换为具体 API 请求格式。

M4 至此确认了活动路径、状态回放、压缩可见性、摘要消息映射及最终上下文重建顺序。

## 5. M5 分支导航与摘要

状态：已确认完成。

### 5.1 执行时机与可选目标（已确认）

- `/tree` 只在 Agent 空闲、完整 Turn 已结束时执行；streaming、tool execution、compaction、fork 或 checkpoint 恢复期间不执行。
- 同一 Session 的消息队列串行调度导航和其他写操作。
- Tree selector 使用打开时的树快照，但提交选择时必须重新校验目标；数据已失效时不改变 Session。
- UserEntry 的实际目标是 `user.parentId`，并在导航成功后把原 content 回填编辑器。
- 非纯 tool-call AssistantEntry 和 ToolResultEntry 的实际目标是自身 ID，导航后编辑器为空。
- 纯 tool-call AssistantEntry 不可选；Compaction/BranchSummary 可见但不可选；状态 Entry 不显示、不可选。
- `targetLeafId = null` 合法，表示 Session 虚拟根。
- 现有 tool-call 占位 ToolResult 机制保持不变，不在 M5 重新设计。

### 5.2 直接导航（已确认）

直接导航不创建 Entry，只更新 `sessions.active_leaf_id`。数据库成功后才更新 transcript、运行状态和编辑器；数据库失败时 UI 与 active leaf 保持不变。不记录导航历史，也不提供导航撤销栈。

### 5.3 Branch Summary 的总结区间（已确认）

设导航前 active leaf 为 `S`、归一化后的实际目标为 `T`，两条路径的最近公共祖先为 `LCA`。Branch Summary 只总结旧活动分支的 `(LCA, S]`：不包含 LCA，包含旧 source leaf，不总结目标分支，也不重复总结公共历史。

- 选择 UserEntry 时，先令 `T = user.parentId`，再计算 LCA。
- `S = T`、`S = null` 或 S 是 T 的祖先时，没有离开的旧分支，不生成摘要。
- T 是 S 的祖先时，总结 T 之后到 S 的内容。
- 总结区间为空时，“总结后跳转”退化为直接导航，不调用摘要模型。
- 成功生成的 `BranchSummaryEntry.parentId = T`，其 `sourceLeafId = S`。

### 5.4 Branch Summary 的生成输入（已确认）

摘要请求不把分支 Entry 直接伪装成一段原生 provider 对话，而是把待总结区间序列化为受固定标签包裹的历史记录，再作为独立摘要请求发送，避免区间恰好从 tool result、assistant 等协议中间位置开始时产生非法 provider 消息序列。

输入包含区间内的：

- User 内容；
- Assistant 内容和 tool calls；
- ToolResult 内容、工具名和错误状态；
- 已有 Branch Summary；
- 有效的 Compaction Summary。

输入不包含 ModelChange、ThinkingLevelChange、Entry ID、sequence 等与摘要语义无关的字段。若区间内存在 Compaction，使用 M4 的“最后一次 Compaction 生效”规则裁剪该区间，避免重新展开已经压缩的超长历史。

首版固定摘要要求至少保留：用户在该分支尝试实现的目标、已确认决策、已完成工作、文件或外部状态变更、重要工具结果与错误、未解决问题以及合理的后续步骤。自定义 Branch Summary prompt 继续暂缓。

### 5.5 摘要模型与状态（已确认）

- 默认使用导航前 source leaf 恢复出的 model 和 thinking level 生成摘要。
- `BranchSummaryEntry.model/usage` 记录实际生成信息。
- 摘要生成完成并导航后，恢复目标分支的 model/thinking level；摘要所用模型不改变目标分支状态。
- source model 当前不可用时，摘要导航失败且 leaf 不移动；用户仍可改选直接导航，不自动切换模型生成摘要。

### 5.6 摘要生成与提交边界（已确认）

Branch Summary 操作从捕获 source/target 到最终提交期间持续占用同一 Session 的逻辑 writer，即应用层的 Session 写命令执行权。同一 Session 的新 Turn、Tree、Compact、Fork 和状态变更命令在队列中等待；其他 Session 不受影响。

逻辑 writer 不等于 SQLite writer，也不等于数据库事务。摘要模型调用期间不打开数据库事务：

1. 取得 Session 逻辑 writer，捕获 `S`、`T`、`LCA` 和不可变摘要输入。
2. 在数据库事务外调用摘要模型；UI 显示摘要生成状态并允许取消。
3. 摘要成功后才开启短暂的 `BEGIN IMMEDIATE` 事务。
4. 重新校验 active leaf 仍为 `S`。
5. 插入 `BranchSummaryEntry`，令 `parentId = T`、`sourceLeafId = S`。
6. 在同一事务中更新 active leaf、`next_entry_seq` 和 `updated_at`，然后提交。
7. 提交和 UI 重建完成后释放逻辑 writer，队列继续处理下一条命令。

摘要失败、取消或返回空摘要时，不写 Entry、不移动 leaf、不回填所选 User 文本，也不自动降级为直接导航。用户可以重试摘要或明确选择直接导航。数据库提交失败时 Entry、leaf 和 sequence 一起回滚；已经生成的摘要可以暂存在内存中重试数据库提交，不必自动重新调用模型。

该设计避免在外部模型调用期间长期持有 SQLite 写事务，同时保证同一 Session 的业务操作顺序稳定，不会在摘要生成过程中长出新的活动分支。进程在模型调用期间崩溃时数据库没有中间修改，重启后仍停留在原 leaf。

### 5.7 导航后的 transcript、状态与编辑器（已确认）

导航提交成功后依次从新 active leaf 重建活动路径、恢复目标分支 model/thinking level、重建 transcript，最后更新编辑器。

- 主 transcript 使用 M4 的压缩感知有效活动路径，而不是显示整棵树。
- 普通 Entry 正常显示；Branch Summary 和 Compaction 使用专用组件；状态 Entry 不显示。
- 被 Compaction 裁掉的旧消息不显示在主 transcript，但 `/tree` selector 仍可看到整棵树及被压缩节点。
- 导航到 Compaction 之前时，原始历史重新出现在 transcript。
- 选择 UserEntry 时回填原文本为未发送草稿；选择 Assistant/ToolResult 时编辑器为空。
- 带摘要选择 UserEntry 时，Summary Entry 成为 active leaf；草稿发送后，新 UserEntry 成为该 Summary 的 child。
- 恢复出的目标模型当前不可用时，导航仍成功，但按 M4 阻止发送，等待用户手动切换。
- 恢复 model/thinking level 只更新运行时和 UI，不自动追加状态 Entry。

### 5.8 No-op、错误与 UI 提交顺序（已确认）

- 选择当前 active leaf 时不执行数据库更新。
- 选择 UserEntry 且其 parent 已是 active leaf 时，只回填草稿。
- stale target、目标不属于当前 Session 或目标不再可导航时，报告导航错误且不改变 leaf。
- parent 链等 Session 结构损坏时沿用 M4，报告 Session 已损坏。
- UI 更新只发生在数据库提交之后；数据库已成功但 UI 重建失败时不回滚数据库，重新加载 Session 即可恢复。

### 5.9 M5 暂不包含（已确认）

- 搜索、过滤模式、标签和书签、复制节点；
- 自定义 Branch Summary prompt；
- 导航审计和撤销；
- Tree 命令主动中断正在运行的 Turn；
- 重新设计 tool-call 占位 ToolResult；
- Branch Summary 的 token budget、重试次数和超长输入截断策略，这些与 Compaction 一起在 M6 讨论。

M5 至此确认了 Tree 导航目标、直接导航、Branch Summary 区间与输入、摘要生成事务边界，以及导航后的 transcript、运行状态和编辑器恢复语义。

## 6. M6 上下文窗口与压缩策略

状态：已确认完成。

### 6.1 模型能力与未知模型（已确认）

首版在代码中维护内置模型能力表，以 `(provider, modelId)` 精确匹配：

```ts
interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens?: number;
}
```

- 只收录经过可靠资料确认的常用模型；dated model 和 alias 分别显式登记，不通过模糊前缀猜测。
- 切换模型后立即使用新模型的 context window。
- context window 不持久化到 Session；它属于当前运行环境能力，而不是历史事实。
- 未知模型不启用基于阈值的自动压缩，也不假定默认窗口大小；UI/错误信息明确说明自动压缩不可用。
- 未知模型仍可手动 `/compact`，使用本地估算和默认预算尽力执行；provider 明确报告 overflow 时也可尝试一次手动式压缩。失败不修改 Session。
- 用户自定义 context-window override 留待后续版本。

### 6.2 Token usage 与本地估算（已确认）

provider adapter 统一收集并输出 `TokenUsage`，streaming provider 必须读取最终 usage 数据；usage 持久化到对应 `AssistantEntry`。

- provider 的真实 usage 优先于本地估算。
- `cachedInputTokens` 是 input 的子集，不重复加入 total。
- 最近一次位于当前有效上下文、由同一模型成功生成的 assistant usage 可以作为估算锚点。
- Compaction、模型切换或分支变化使锚点不再对应当前有效上下文时，放弃锚点并重新全量估算。
- 有锚点时，下一次请求估算为最近 usage 的 total，加上其后新增消息、当前待发送 User 和新 ToolResult 的本地估算。

无合法 usage 时全量估算有效消息、tool definitions/schema 和 system prompt：ASCII 文本约按 `chars / 4`，非 ASCII 字符保守按约一个 token，加上每条消息的固定协议开销；tool-call 参数先稳定 JSON 序列化再估算。首版不引入完整 tokenizer 依赖。

### 6.3 默认预算与阈值（已确认）

已知 context window 时使用动态默认值：

```ts
reserveTokens = Math.min(16_384, Math.floor(contextWindow * 0.25));
keepRecentTokens = Math.min(20_000, Math.floor(contextWindow * 0.50));
maxSummaryOutputTokens = Math.min(
  8_192,
  Math.floor(reserveTokens * 0.50),
  model.maxOutputTokens,
);
```

- `reserveTokens` 为下一次模型输出和估算误差预留空间。
- `keepRecentTokens` 是压缩后保留的最近原文预算。
- `maxSummaryOutputTokens` 是摘要最大输出预算；模型没有已知输出上限时忽略该项的第三个约束。
- 首版这些参数是内部策略，不提供设置 UI。

预测下一次完整 provider 请求的 token 大于 `contextWindow - reserveTokens` 时触发自动压缩。压缩后必须重新估算；仍高于安全阈值时阻止 provider 请求并报告无法压缩到安全范围，不降低安全余量强行发送。

### 6.4 触发入口与安全点（已确认）

手动 `/compact`、新 User 后第一次 provider 调用前的自动检查，以及 ReAct 中完整工具批次结束后、下一次 provider 调用前的自动检查，共用同一套压缩算法。

- 不在 provider streaming、tool call 正在执行、同批工具部分完成或 checkpoint 尚未稳定持久化时压缩。
- Turn 最终回复完成后不立即自动压缩；等到下一次用户发送时再检查，避免没有后续对话时产生额外模型调用。
- 手动 `/compact` 忽略触发阈值，但仍要求存在至少一段可摘要的旧内容；没有可压缩内容时返回友好 no-op，不写 Entry。

### 6.5 Turn 内 Compaction（已确认）

首版支持 Turn 内 Compaction，但只允许发生在完整 tool 批次结束、包含完整 ToolResult 批次的 `ready_for_iteration` checkpoint 已持久化之后。单个 ToolResult 的 24,000 字符上限不能约束最多十轮 ReAct 的累计上下文，因此不能只依赖单工具截断。

Turn 内压缩流程：

1. 估算下一次 provider 请求并判定需要压缩。
2. 在数据库事务外生成 Compaction Summary。
3. 为 pending `CompactionEntry` 分配 ID，连接当前逻辑 pending leaf；`firstKeptEntryId` 可以引用已持久化或本 Turn pending Entry。
4. 把 Compaction 与完整逻辑 parent 链写入 runtime checkpoint。
5. 使用压缩后的 `workingMessages` 继续 ReAct。
6. Turn 终止时，将本 Turn 的 User、Assistant、ToolResult 与 Compaction 按逻辑顺序在一个最终事务中统一落库。

Turn 内压缩不提前提交半个 Turn，也不提前移动数据库 active leaf。崩溃发生在包含完整 CompactionEntry 的 `ready_for_iteration` checkpoint 持久化后时，恢复逻辑可以物化该 Compaction；发生在之前时，最后稳定、已包含完整 ToolResult 批次的 checkpoint 仍可恢复完整工具轨迹。

### 6.6 Cut point、工具批次与交互段切分（已确认）

Compaction 明确区分 Runtime Turn 与用户交互段：

- **Runtime Turn** 是一次 checkpoint、Session 逻辑 writer 和最终提交事务的运行时生命周期。按 M7 的补充消息设计，一个 Runtime Turn 可以包含多条 UserEntry。
- **用户交互段（Interaction Segment）** 由一条 UserEntry 开始，到下一条 UserEntry 之前结束。它是 Compaction 判断用户意图边界的单位，与 Runtime Turn 的事务分组无关。
- 补充 User 只在 `ready_for_iteration` 安全点进入 pending 链，此时不存在未闭合的 tool calls，因此每条 UserEntry 都是合法的交互段边界，不会把一个工具批次拆开。
- Runtime checkpoint 的 `turnId` 只服务运行时恢复与校验，不写入最终 Session Entry；首版不为恢复 Runtime Turn 分组而给 `BaseEntry` 增加 `turnId`。

从 active leaf 向前累计估算 token，达到 `keepRecentTokens` 后选择合法 cut point。优先从 UserEntry 开始完整保留一个用户交互段；BranchSummaryEntry 等既有模型可见边界仍按原规则作为候选切点。

- 保留区间不得从孤立 ToolResult 开始。
- 如果预算落在工具结果批次中，cut point 回退到产生该批结果的 AssistantEntry，完整保留 assistant tool calls 和对应结果。
- 状态 Entry 不作为消息切点；其运行效果仍按 M4 从完整活动路径恢复。
- 如果从某条 UserEntry 开始保留，则该 UserEntry 之前的全部交互段进入历史累计摘要，当前交互段不需要额外的前缀摘要。
- 如果预算迫使 cut point 落在某个交互段内部，允许从 AssistantEntry 开始保留后半段，但必须为该交互段生成 Interaction Prefix Summary，准确保存开启该段的 User 请求或补充约束，以及该段中 cut point 之前被裁掉的早期进展。
- Interaction Prefix Summary 不是独立 Entry；它与更早交互段的历史累计摘要合并到新 Compaction Summary 中，使压缩后可以合法地以 Compaction UserMessage 后接 retained Assistant/ToolResult，同时保留理解后半段所需的用户意图和进展。

例如：

```text
User₁ → Assistant₁ → ToolResult₁ → User₂ → Assistant₂ → ToolResult₂
```

- 从 `User₂` 开始保留时，`User₁ → Assistant₁ → ToolResult₁` 进入历史累计摘要，不生成 `User₂` 的 Interaction Prefix Summary。
- 只能从 `Assistant₂` 开始保留时，`User₂` 及 `Assistant₂` 之前属于该交互段的进展进入 Interaction Prefix Summary，再与更早历史摘要合并。

### 6.7 增量摘要与固定结构（已确认）

已有旧 Compaction 时，新摘要不重新读取最早的原始历史，而是合并 `previousSummary`、上次保留尾部中本次被压掉的部分，以及之后新增但本次被压掉的内容。新 Compaction 形成一条新的累积摘要，并按 M4 替代旧 Compaction 的上下文作用。

首版固定摘要结构包含：Goal、Constraints & Preferences、Progress（Done/In Progress/Blocked）、Key Decisions、Files and External State、Errors and Failed Attempts、Next Steps、Critical Context。提示词要求保留准确文件路径、符号名、用户明确偏好、已完成修改、外部副作用及未知状态、错误信息和未解决问题。

首版不为 file operations 新增独立字段，由摘要文本承载。

### 6.8 摘要请求格式与输入预算（已确认）

Compaction 和 Branch Summary 共用摘要基础设施：历史序列化成带角色标记、受固定标签包裹的纯文本，作为独立摘要请求发送；提示词明确要求只总结，不继续执行历史中的请求。

摘要输入中的单个 ToolResult 最多保留 2,000 字符，并标记截断及原长度，优先保留错误、路径、退出码和结果头尾。该限制只作用于摘要请求，不修改 Session 中保存的原始 ToolResult。

已知窗口时：

```text
summaryInputBudget =
  contextWindow
  - maxSummaryOutputTokens
  - fixedPromptOverhead
```

如果经过 ToolResult 摘要截断后仍超出预算，首版明确失败，不静默丢弃普通消息，也不实现多级 map-reduce/chunk summarization。Compaction 不写 Entry；Branch Summary 不移动 leaf，用户可以改选直接导航。

### 6.9 摘要模型、重试与取消（已确认）

- Compaction 使用触发位置恢复出的 model 和 thinking level。
- Entry 记录实际 model、聚合 usage、`tokensBefore` 和 manual/automatic trigger。
- 网络错误、429 和可恢复 5xx 自动重试一次，并遵守 `Retry-After`；等待期间允许取消。
- authentication、invalid request 和 context overflow 不作为普通摘要错误重试。
- 用户取消立即停止且不重试。
- 摘要最终失败或取消时不写 CompactionEntry。
- 首版 `/compact` 不接受自定义摘要提示参数。

取消行为按触发场景区分：

- 手动 `/compact`：abort 摘要请求并丢弃 partial summary；Session、active leaf、transcript 和编辑器保持不变。
- 新 Turn 第一次 provider 调用前的自动压缩：取消整个待发送 Turn，原子移除统一 runtime checkpoint，把其中的用户文本恢复为未发送编辑器草稿；不发送原始超阈值请求。
- Turn 内完整工具批次后的自动压缩：取消当前 Turn，但不能回滚已经完成的 Assistant/ToolResult 或工具副作用。恢复/最终提交事务保存已完成轨迹，并在末尾追加内容明确的 cancelled AssistantEntry（例如 `[Turn cancelled while compacting context.]`），随后清理 checkpoint。

三种场景都不自动重试、不自动换模型，并在清理或最终提交完成后释放 Session 逻辑 writer。对于 overflow 后触发的自动压缩，取消同样意味着不再重试原 provider 调用。

取消是否还能撤销 Compaction 以 durable 边界为准：

- Compaction 尚未提交数据库，Turn 内完整 CompactionEntry 也尚未成功写入 checkpoint 时，取消有效，不保留 CompactionEntry。
- 空闲期 Compaction 已提交，或 Turn 内 `ready_for_iteration` checkpoint 已包含完整 CompactionEntry 时，压缩已经完成，不能由取消回滚；此时取消只停止后续 Turn。Turn 内已 checkpoint 的 Compaction 最终随恢复或正常终止提交物化。

### 6.10 自动压缩失败与 overflow 恢复（已确认）

手动 Compaction 或 Branch Summary 失败时 Session/leaf 不变。自动 Compaction 失败时，不继续发送已经判定接近或超过安全阈值的 provider 请求；当前操作明确失败，已完成工具调用和 checkpoint 仍按既有恢复规则保存，不自动换模型。

provider adapter 负责把各厂商错误归一化为明确的 context-overflow 分类，AgentLoop 不直接解析厂商异常文本，并排除 rate limit、quota、authentication 等非 overflow 错误。

provider 调用发生 overflow 时，在最近安全 checkpoint 上自动压缩并重试该 provider 调用一次：失败请求的 partial stream 被丢弃，已完成工具不会重新执行。同一次调用最多恢复一次；压缩后仍 overflow 时停止并建议切换更大窗口模型。成功响应若 usage 已接近阈值，不重试该响应，只在下一个安全点压缩。

### 6.11 成功提交与可见性（已确认）

Compaction 提交成功后，active leaf 指向 CompactionEntry，按 M4 重建有效上下文和完整路径状态，重新估算压缩后 token，并用专用 Compaction 组件更新 transcript。自动和手动 Compaction 都在 transcript 与 `/tree` 中可见，但首版不可作为 Tree 导航目标。

摘要生成成功但数据库提交失败时，Entry、leaf 和 sequence 一起回滚；摘要可以暂存在内存中重试提交，不必重新调用模型。

### 6.12 M6 暂缓范围（已确认）

- 用户自定义 context window、reserve 或 keepRecent；
- 精确 tokenizer 包；
- 多级 chunk/map-reduce 摘要；
- 自定义 Compaction prompt；
- 自动切换更大模型；
- token 使用图表和历史统计 UI；
- 按成本选择专用廉价摘要模型。

M6 至此确认了模型窗口来源、token 统计、自动与手动触发、Turn 内压缩、cut point、增量与 Interaction Prefix Summary、失败重试和 provider overflow 恢复策略。
