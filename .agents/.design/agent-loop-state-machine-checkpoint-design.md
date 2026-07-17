# Agent Loop 状态机与 Checkpoint 设计

## 1. 文档定位

本文档定义 `feat/agent-loop-state-machine-checkpoint` 分支的设计结论。

本分支目标是继续完善 Byte Mentor 的 agent 基座，而不是推进 Knowledge、TUI 或产品教学能力。

本设计严格参考 nanobot 中以下工程实践：

- `AgentLoop` 使用显式 turn 状态机驱动一次消息处理。
- `TurnContext` 作为一次 turn 内跨状态共享的数据容器。
- 状态机 trace 记录每个 state 的耗时、事件和异常。
- `AgentRunner` 在关键执行阶段通过 callback / hook 暴露中间状态。
- `AgentLoop` 将 runner checkpoint 写入 session metadata。
- 下一次 turn 的 `RESTORE` 阶段能够恢复未完成 turn 的 assistant / tool 上下文。

本分支不是要照搬 nanobot 的完整平台能力。nanobot 中的 MessageBus、多聊天平台、subagent、mid-turn injection、MCP、auto compact、command router 和 WebUI 协调都不在本分支范围内。

## 2. 背景

当前 Byte Mentor 已完成最小 agent runtime bring-up：

```text
CLI 输入
  -> SQLite SessionStore
  -> ContextBuilder
  -> AgentRunner
  -> OpenAIChatProvider
  -> 保存 user / assistant / tool messages
  -> CLI 输出 assistant 回复
```

当前 `AgentLoop.runTurn()` 仍是线性 pipeline：

```text
create/get session
  -> get history
  -> append user message
  -> build context
  -> runner.run
  -> append runner messages
  -> return result
```

这个结构能跑通 smoke，但后续扩展会变困难：

- 增加 restore / checkpoint 时会混进 runTurn 主流程。
- 增加 compact 时需要插入 history 读取前后。
- 增加 command / slash command 时需要分叉 build/run/save 流程。
- 增加 Teaching Brief / Observation Log 时缺少稳定挂载点。
- 调试一次 turn 的内部阶段耗时和异常路径不直观。

因此本分支先把 `AgentLoop` 改造成 nanobot 风格的状态机，把后续扩展点固定下来。

## 3. 总体目标

本分支交付三项能力：

1. `AgentLoop` 状态机。
2. `TurnContext` 与 state trace 埋点。
3. `AgentRunner` checkpoint 监控与 `AgentLoop` restore。

完成后，一次 headless turn 的外部行为应保持兼容：

```ts
await loop.runTurn({ userMessage: "..." })
```

但内部执行方式变为：

```text
RESTORE
  -> COMPACT
  -> COMMAND
  -> BUILD
  -> RUN
  -> SAVE
  -> RESPOND
  -> DONE
```

其中 `COMPACT` 和 `COMMAND` 在本分支先保留为最小实现或 no-op，用于固定扩展点。

## 4. 非目标

本分支不实现：

- Knowledge / Teaching Brief / Observation Log。
- 真实 compact / summarization。
- slash command router。
- TUI 或 WebUI。
- MessageBus。
- per-session lock / concurrent task manager。
- `/stop` command。
- mid-turn user message injection。
- subagent。
- MCP。
- provider registry / fallback provider。
- 多 provider runtime switch。
- session list / title / resume UX。

这些能力后续可以挂在本分支建立的状态机和 checkpoint 基础上。

## 5. 与 nanobot 的对齐原则

### 5.1 对齐的工程形状

本分支对齐 nanobot 的以下核心形状：

```text
TurnState enum
TurnContext
StateTraceEntry
transition table
state handler method
runner checkpoint callback
session metadata restore
early user persist
pending user turn repair
```

### 5.2 不照搬的部分

nanobot 的完整 `AgentLoop` 同时承担 channel bus、commands、WebUI、subagent、MCP、auto compact、provider snapshot 等职责。

Byte Mentor 当前阶段只保留 headless runtime 的必要职责：

```text
runTurn input
  -> state machine
  -> session
  -> context
  -> runner
  -> checkpoint/restore
  -> result/events/trace
```

这样既能学习 nanobot 的工程结构，又不会把 Byte Mentor 的第一阶段基座扩成完整通用 agent 平台。

## 6. 状态机设计

### 6.1 TurnState

新增 `TurnState`：

```ts
export type TurnState =
  | "RESTORE"
  | "COMPACT"
  | "COMMAND"
  | "BUILD"
  | "RUN"
  | "SAVE"
  | "RESPOND"
  | "DONE";
```

这里使用字符串 union，而不是 enum。

原因：

- 与现有 TypeScript 代码风格更轻量。
- 测试断言和 trace 输出更直接。
- 不需要运行时 enum 对象参与 public API。

### 6.2 TurnStateEvent

新增 `TurnStateEvent`：

```ts
export type TurnStateEvent = "ok" | "dispatch" | "shortcut";
```

第一版事件只覆盖 nanobot 当前核心流：

```text
RESTORE -> ok
COMPACT -> ok
COMMAND -> dispatch | shortcut
BUILD -> ok
RUN -> ok
SAVE -> ok
RESPOND -> ok
```

异常不作为 state event 返回。handler 抛错时由状态机 driver 记录 trace error 后继续抛出，保持问题可见。

### 6.3 transition table

新增 transition table：

```ts
const TURN_TRANSITIONS: Record<string, TurnState> = {
  "RESTORE:ok": "COMPACT",
  "COMPACT:ok": "COMMAND",
  "COMMAND:dispatch": "BUILD",
  "COMMAND:shortcut": "DONE",
  "BUILD:ok": "RUN",
  "RUN:ok": "SAVE",
  "SAVE:ok": "RESPOND",
  "RESPOND:ok": "DONE",
};
```

状态机 driver 每次 handler 返回 event 后查表。

如果缺少 transition，抛出错误：

```text
No transition from <state> on event "<event>"
```

测试必须覆盖 transition 缺失路径。

### 6.4 state handlers

`AgentLoop` 内部新增以下 handler：

```ts
private async stateRestore(ctx: TurnContext): Promise<TurnStateEvent>
private async stateCompact(ctx: TurnContext): Promise<TurnStateEvent>
private async stateCommand(ctx: TurnContext): Promise<TurnStateEvent>
private async stateBuild(ctx: TurnContext): Promise<TurnStateEvent>
private async stateRun(ctx: TurnContext): Promise<TurnStateEvent>
private async stateSave(ctx: TurnContext): Promise<TurnStateEvent>
private async stateRespond(ctx: TurnContext): Promise<TurnStateEvent>
```

职责划分：

- `RESTORE`：创建或读取 session，恢复 runtime checkpoint，修复 pending user turn。
- `COMPACT`：本分支 no-op，后续承载 compact / summary。
- `COMMAND`：本分支默认返回 `dispatch`，后续承载 slash command。
- `BUILD`：读取 history，创建并提前保存 user message，设置 pending user turn，构建 model messages。
- `RUN`：调用 `AgentRunner.run()`，传入 checkpoint callback。
- `SAVE`：保存 runner 产出的 assistant / tool messages，清理 pending/checkpoint。
- `RESPOND`：组装 `HeadlessTurnResult`。

### 6.5 runTurn public API

`AgentLoop.runTurn()` 保持 public API 不变：

```ts
runTurn(input: HeadlessTurnInput, options?: HeadlessTurnOptions): Promise<HeadlessTurnResult>
```

内部改为：

```ts
const ctx = createTurnContext(input, options);

while (ctx.state !== "DONE") {
  const startedAt = clock.now();
  const event = await handler(ctx);
  ctx.trace.push(...);
  ctx.state = nextState(ctx.state, event);
}

return ctx.result;
```

`runTurn()` 不再直接写完整 pipeline。

## 7. TurnContext 设计

### 7.1 定位

`TurnContext` 是一次 turn 内部的 mutable runtime object。

它负责承载状态间共享数据，不作为业务数据模型，也不直接暴露给 CLI/TUI/Knowledge。

`TurnContext` 与 `HeadlessTurnResult` 的关系：

- `TurnContext`：内部执行过程。
- `HeadlessTurnResult`：外部调用方看到的稳定结果。

### 7.2 初版结构

```ts
export interface TurnContext {
  input: HeadlessTurnInput;
  options?: HeadlessTurnOptions;

  turnId: TurnId;
  state: TurnState;

  session?: Session;
  sessionId?: SessionId;

  history: Message[];
  userMessage?: UserMessage & { id: MessageId };
  initialMessages: Message[];

  runnerResult?: AgentRunnerResult;
  finalMessage?: AssistantMessage & { id: MessageId };

  newMessages: Message[];
  stopReason?: StopReason;
  error?: { message: string };

  events: RuntimeEvent[];
  trace: StateTraceEntry[];

  userPersistedEarly: boolean;
  result?: HeadlessTurnResult;
}
```

字段说明：

- `input` / `options`：保留本轮 public input。
- `turnId`：本轮运行 ID。
- `state`：当前状态机状态。
- `session` / `sessionId`：当前 session。
- `history`：进入本轮 build 前读取到的历史。
- `userMessage`：本轮用户消息。
- `initialMessages`：传给 runner 的模型输入。
- `runnerResult`：runner 执行结果。
- `finalMessage`：最终 assistant message。
- `newMessages`：本轮新增消息，返回给调用方。
- `events`：运行时事件。
- `trace`：状态机埋点。
- `userPersistedEarly`：用户消息是否已在 BUILD 阶段提前保存。
- `result`：`RESPOND` 阶段最终组装的结果。

### 7.3 StateTraceEntry

新增：

```ts
export interface StateTraceEntry {
  state: TurnState;
  startedAt: number;
  durationMs: number;
  event: TurnStateEvent | "";
  error?: string;
}
```

设计原则：

- `startedAt` 使用毫秒时间戳，便于测试和输出。
- `durationMs` 记录 handler 耗时。
- handler 成功时写入返回 event。
- handler 抛错时写入 `event: ""` 和 `error`。

`StateTraceEntry` 不放入 `RuntimeEvent`。

原因：

- `RuntimeEvent` 表示稳定运行事实，未来给 UI / CLI 消费。
- `StateTraceEntry` 表示状态机调试埋点，主要给测试、日志和开发诊断使用。

### 7.4 HeadlessTurnResult 扩展

`HeadlessTurnResultBase` 新增：

```ts
trace: StateTraceEntry[];
```

原因：

- 本项目用于学习 agent runtime 工程细节，调用方应该能直接检查一次 turn 经过了哪些 state。
- 测试也需要通过 public API 验证状态机顺序。

## 8. Session metadata 设计

### 8.1 Session 结构扩展

当前 `Session` 只有：

```ts
interface Session {
  id: SessionId;
}
```

本分支扩展为：

```ts
export type SessionMetadata = Record<string, unknown>;

export interface Session {
  id: SessionId;
  metadata: SessionMetadata;
}
```

### 8.2 SessionStore metadata API

新增：

```ts
updateMetadata(
  id: SessionId,
  updater: (metadata: SessionMetadata) => SessionMetadata,
): Promise<SessionMetadata>;
```

选择 `updateMetadata` 而不是 `setMetadata` 的原因：

- checkpoint 和 pending user turn 都是 metadata 的局部字段。
- 使用 updater 可以减少调用方读改写时覆盖其它 metadata 字段的风险。
- SQLite 和 in-memory 都能直接实现。

语义：

- 读取当前 metadata。
- 传给 updater。
- updater 返回新的 metadata object。
- store 持久化新 metadata。
- 返回持久化后的 metadata。

SQLite 实现使用现有 `sessions.metadata_json` 字段。

### 8.3 metadata key

新增两个 AgentLoop 内部 metadata key：

```ts
const RUNTIME_CHECKPOINT_KEY = "runtime_checkpoint";
const PENDING_USER_TURN_KEY = "pending_user_turn";
```

它们属于 `@byte-mentor/agent` 的运行时协议，不放入 `@byte-mentor/core`。

原因：

- 这是 AgentLoop 与 SessionStore 的内部恢复机制。
- 不是跨包通用业务契约。
- 后续若 TUI/CLI 需要显示 checkpoint 状态，再从 agent 暴露只读视图。

## 9. Pending User Turn

### 9.1 问题

如果用户消息已经保存，但进程在 assistant 回复前崩溃，session 历史会停在最后一条 user message。

下一轮如果直接拼接新 user message，模型会看到不完整 turn 边界。

nanobot 用 `pending_user_turn` 记录这种情况，并在下一次 restore 时补一个 assistant 占位。

### 9.2 写入时机

`BUILD` 阶段：

1. 创建 `userMessage`。
2. `sessionStore.appendMessages(session.id, [userMessage])`。
3. `sessionStore.updateMetadata(... pending_user_turn = true)`。
4. `ctx.userPersistedEarly = true`。
5. 使用原始 `history + userMessage` 构建 `initialMessages`。

注意：history 应该在保存本轮 user 前读取，避免当前 user 被重复放入 model messages。

### 9.3 清理时机

`SAVE` 阶段正常完成后：

- 清除 `pending_user_turn`。
- 清除 `runtime_checkpoint`。

### 9.4 restore 行为

`RESTORE` 阶段：

如果 metadata 中 `pending_user_turn === true`，且 session history 最后一条消息是 user：

```ts
append assistant message:
{
  role: "assistant",
  content: "Error: Task interrupted before a response was generated."
}
```

然后清除 `pending_user_turn`。

如果最后一条不是 user，也清除 `pending_user_turn`，避免 stale flag 影响后续 turn。

## 10. Runtime Checkpoint

### 10.1 设计目标

checkpoint 用于恢复 AgentRunner 执行到一半时已经产生的 assistant/tool 上下文。

典型场景：

- 模型已经返回 tool calls，assistant tool-call message 应该被保存。
- 部分工具已经完成，tool result 应该被保存。
- 部分工具还没完成，应该合成 interrupted tool result。
- 模型已经产生 final assistant，但 SAVE 前崩溃，下一轮应该恢复 final assistant。

### 10.2 checkpoint payload

新增 `RuntimeCheckpoint`。这里使用 `phase` 作为判别字段，而不是一个宽泛 interface。

```ts
export type RuntimeCheckpoint =
  | {
      phase: "awaiting_tools";
      iteration: number;
      assistantMessage: AssistantMessage & { id: MessageId };
      completedToolResults: [];
      pendingToolCalls: ToolCall[];
    }
  | {
      phase: "tools_completed";
      iteration: number;
      assistantMessage: AssistantMessage & { id: MessageId };
      completedToolResults: ToolMessage[];
      pendingToolCalls: [];
    }
  | {
      phase: "final_response";
      iteration: number;
      assistantMessage: AssistantMessage & { id: MessageId };
      completedToolResults: [];
      pendingToolCalls: [];
    };
```

字段说明：

- `phase`：checkpoint 所处 runner 阶段。
- `iteration`：runner iteration index。
- `assistantMessage`：本阶段对应 assistant message。
- `completedToolResults`：已完成并可恢复的 tool messages。
- `pendingToolCalls`：尚未完成的 tool calls。

使用 discriminated union 的原因是让 TypeScript 在类型层面阻止非法组合，例如 `final_response` 携带 `pendingToolCalls`。

### 10.3 checkpoint callback

`AgentRunnerInput` 新增：

```ts
checkpoint?: (payload: RuntimeCheckpoint) => Promise<void>;
```

Runner 不直接依赖 session。

AgentLoop 在 `RUN` 阶段传入 callback：

```ts
checkpoint: (payload) => this.setRuntimeCheckpoint(ctx.session.id, payload)
```

### 10.4 checkpoint 写入点

#### awaiting_tools

当 provider 返回 tool calls，runner 构造 assistant tool-call message 后、执行工具前：

```ts
await checkpoint({
  phase: "awaiting_tools",
  iteration,
  assistantMessage,
  completedToolResults: [],
  pendingToolCalls: assistantMessage.toolCalls,
});
```

#### tools_completed

工具执行完成并构造所有 tool messages 后：

```ts
await checkpoint({
  phase: "tools_completed",
  iteration,
  assistantMessage,
  completedToolResults: toolMessages,
  pendingToolCalls: [],
});
```

#### final_response

runner 得到最终 assistant message 后、返回给 AgentLoop 前：

```ts
await checkpoint({
  phase: "final_response",
  iteration,
  assistantMessage: finalAssistantMessage,
  completedToolResults: [],
  pendingToolCalls: [],
});
```

### 10.5 checkpoint 失败策略

checkpoint callback 失败时，runner 应返回 failed result，而不是继续执行。

原因：

- checkpoint 是本分支的恢复保证。
- 如果 checkpoint 写不进去却继续执行，崩溃恢复语义会变得不可预测。
- 当前没有复杂 logger / metrics，显式 failed 更容易测试和诊断。

后续如果需要更高可用性，可以改成 best-effort checkpoint，但不在本分支做。

## 11. Restore Runtime Checkpoint

### 11.1 restore 时机

`RESTORE` 阶段读取 session metadata。

如果存在 `runtime_checkpoint`，调用：

```ts
restoreRuntimeCheckpoint(session)
```

### 11.2 materialize 规则

将 checkpoint 转换为 session messages：

1. 如果存在 `assistantMessage`，加入恢复列表。
2. 加入所有 `completedToolResults`。
3. 对每个 `pendingToolCalls` 合成 tool message：

```ts
{
  id: createMessageId(),
  role: "tool",
  toolCallId: toolCall.id,
  content: "Error: Task interrupted before this tool finished."
}
```

然后追加到 session。

### 11.3 tail dedupe

restore 之前需要和 session 尾部做重叠去重，避免重复恢复。

新增内部函数：

```ts
checkpointMessageKey(message: Message): unknown[]
```

比较字段：

- `role`
- `content`
- `toolCallId`
- `toolCalls`

算法：

```text
restoredMessages = checkpoint materialized messages
maxOverlap = min(sessionMessages.length, restoredMessages.length)
for size from maxOverlap down to 1:
  if session tail(size) equals restored head(size):
    overlap = size
    break
append restoredMessages.slice(overlap)
```

### 11.4 restore 后清理

restore 完成后清除：

- `runtime_checkpoint`
- `pending_user_turn`

无论本次是否实际追加消息，只要 checkpoint payload 被识别并处理，就清除 checkpoint。

### 11.5 非法 checkpoint

如果 metadata 中 `runtime_checkpoint` 不是合法 object：

- 不追加消息。
- 清除该 metadata key。
- 不让 turn 失败。

原因：metadata 是持久化数据，可能来自旧版本或手工修改。restore 应该尽量修复并前进。

## 12. AgentRunner 监控 Hook

### 12.1 为什么需要 hook

checkpoint callback 可以解决恢复，但不能完整表达 runner 监控。

nanobot 用 `AgentHook` 给 runner 提供生命周期扩展点：

- iteration 开始
- stream delta
- stream end
- tool 执行前
- iteration 结束
- final content 处理

Byte Mentor 当前只有 `RuntimeEvent[]` 和 `onStreamEvent`。这能表达结果，但不方便插入 runner 内部监控。

### 12.2 本分支最小 hook

新增：

```ts
export interface AgentHookContext {
  iteration: number;
  messages: Message[];
  response?: ProviderResponse;
  toolCalls: ToolCall[];
  toolResults: ToolMessage[];
  finalMessage?: AssistantMessage & { id: MessageId };
  stopReason?: StopReason;
  error?: string;
}

export interface AgentHook {
  beforeIteration?(context: AgentHookContext): Promise<void> | void;
  onStream?(
    context: AgentHookContext,
    event: Extract<ProviderStreamEvent, { type: "content_delta" }>,
  ): Promise<void> | void;
  onStreamEnd?(
    context: AgentHookContext,
    options: { resuming: boolean },
  ): Promise<void> | void;
  beforeExecuteTools?(context: AgentHookContext): Promise<void> | void;
  afterIteration?(context: AgentHookContext): Promise<void> | void;
  finalizeContent?(
    context: AgentHookContext,
    content: string | undefined,
  ): string | undefined;
}
```

`AgentRunnerInput` 新增：

```ts
hooks?: AgentHook[];
```

### 12.3 CompositeHook

新增内部 `CompositeAgentHook`：

- 多 hook 顺序执行。
- async lifecycle hook 默认隔离异常，记录到 context error 并继续。
- `finalizeContent` 是 pipeline，异常不隔离。

如果当前项目没有 logger，第一版可以把 hook 异常写入 context 的 `error` 字段，并通过 `RuntimeEvent` 或 runner failed result 暴露。

但本分支不实现复杂 hook 插件系统。

### 12.4 hook 与 checkpoint 的关系

checkpoint callback 是恢复机制，hook 是监控机制。

两者不合并：

- checkpoint payload 必须稳定、可序列化、可恢复。
- hook context 可以更丰富，服务观察和未来 UI。

## 13. AgentRunner 行为调整

### 13.1 保持职责边界

`AgentRunner` 仍然不依赖：

- SessionStore
- CLI/TUI
- Knowledge
- Teaching Brief
- SQLite

它只通过 callback / hook 暴露中间状态。

### 13.2 streaming 语义保持

现有行为：

- runner 消费 provider `invokeStream`。
- 只把最终完成轮次的 content delta 透传给 `onStreamEvent`。
- tool-call 中间轮次不对 CLI 打印 content delta。

本分支保持该行为。

新增：

- 透传最终轮次 delta 时调用 hook `onStream`。
- 最终轮次结束时调用 `onStreamEnd({ resuming: false })`。
- tool-call 中间轮次如果内部产生 content delta，不调用 public `onStreamEvent`，但可以调用 hook `onStreamEnd({ resuming: true })`。

### 13.3 final response checkpoint

无工具直接完成时，也必须产生 `final_response` checkpoint。

原因：如果 provider 返回最终 assistant 后、AgentLoop SAVE 前崩溃，下一轮仍应恢复该 assistant message。

### 13.4 tool parse error

现有 `ToolCall.argsParseError` 分支仍保留。

该分支合成 tool message 后，也应参与 checkpoint：

- assistant tool-call message 进入 `awaiting_tools` checkpoint。
- parse error 合成 tool message 后进入 `tools_completed` checkpoint。

### 13.5 max iterations

runner 达到 max iterations 时：

- 返回 `stopReason: "max_iterations"`。
- 如果已有 `newMessages`，SAVE 阶段仍保存。
- 是否额外写 final assistant max-iterations message，本分支不新增；保持当前行为。

## 14. SAVE 语义

### 14.1 completed turn

正常完成：

```text
history before turn
  + userMessage
  + runner.newMessages
```

SAVE 阶段：

- append `runnerResult.newMessages`
- clear `pending_user_turn`
- clear `runtime_checkpoint`
- assemble completed result

### 14.2 failed turn

provider 或 runner 失败：

- 保存已产生的 `runnerResult.newMessages`。
- 如果本轮没有 assistant/tool 输出，追加 assistant error placeholder：

```text
[Assistant reply unavailable due to model error.]
```

该 placeholder 的目的是关闭 turn 边界，不让 session 最后停在 user。

返回给调用方的 `error.message` 仍使用真实错误信息。

### 14.3 checkpoint restore 后的新 turn

如果 `RESTORE` 阶段恢复了上一次 checkpoint：

```text
previous user
  + restored assistant/tool context
  + current user
  + current assistant/tool context
```

当前 turn 的 `history` 应包括 restore 后的 session history。

这意味着 restore 必须发生在 BUILD 读取 history 之前。

## 15. RuntimeEvent 调整

本分支不新增 state-level RuntimeEvent。

保留现有事件：

- `turn.started`
- `context.built`
- `model.requested`
- `model.responded`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `turn.completed`
- `turn.failed`

后续如果 TUI 需要显示 state progress，再新增：

```text
turn.state.started
turn.state.completed
```

但本分支先用 `trace`。

## 16. 测试策略

本分支必须按 TDD 小步推进。

测试继续放在根目录 `test/`，优先通过 public API 导入。

### 16.1 Session metadata tests

新增或扩展 `test/session/**`：

- create session 默认 metadata 为 `{}`。
- in-memory store 支持 metadata update。
- SQLite store 支持 metadata update。
- SQLite store 关闭重开后 metadata 保留。
- close 后调用 metadata API 抛 `SessionStoreClosedError`。
- updater 不应隐式丢失已有 metadata 字段。

### 16.2 AgentLoop state machine tests

新增或扩展 `test/agent/agent-loop.test.ts`：

- completed turn 的 trace 顺序为：

  ```text
  RESTORE, COMPACT, COMMAND, BUILD, RUN, SAVE, RESPOND
  ```

- 每条 trace 有 `startedAt`、`durationMs`、`event`。
- `COMMAND` 第一版返回 `dispatch`。
- transition 缺失时抛清晰错误。
- handler 抛错时 trace 记录 `error`。
- public `HeadlessTurnResult` 仍包含原有 `sessionId/newMessages/finalMessage/events`。

### 16.3 Pending user turn tests

- BUILD 阶段提前保存 user message。
- BUILD 后 metadata 中 `pending_user_turn` 为 true。
- SAVE 后 metadata 中 `pending_user_turn` 被清除。
- RESTORE 发现 pending user turn 时追加 assistant interrupted placeholder。
- 如果 pending flag 存在但最后一条不是 user，只清理 flag，不追加 placeholder。

### 16.4 Runner checkpoint tests

新增或扩展 `test/agent/agent-runner.test.ts`：

- 无工具完成时调用 `final_response` checkpoint。
- 工具调用时先调用 `awaiting_tools` checkpoint。
- 工具完成后调用 `tools_completed` checkpoint。
- `argsParseError` 合成 tool message 后也调用 `tools_completed` checkpoint。
- checkpoint callback 抛错时 runner 返回 failed。
- checkpoint payload 可 JSON serialize。

### 16.5 Runtime checkpoint restore tests

新增或扩展 `test/agent/agent-loop.test.ts`：

- restore assistant + completed tool results。
- restore pending tool calls 为 interrupted tool messages。
- restore 后清除 `runtime_checkpoint` 和 `pending_user_turn`。
- restore 时对 session tail overlap 去重。
- 非法 checkpoint metadata 被清理且不阻断当前 turn。
- restore 发生在 BUILD 前，因此当前 provider 请求能看到恢复后的 history。

### 16.6 Integration tests

扩展 `test/agent/headless-turn.integration.test.ts`：

- fake provider + fake tool 完整 turn 行为不变。
- SQLite-backed session 下 checkpoint metadata 能跨 store instance 恢复。
- CLI `run-chat` 测试不需要改 public API。

## 17. 文件范围

预计修改：

```text
packages/session/src/session-store.ts
packages/session/src/in-memory-session-store.ts
packages/session/src/sqlite-session-store.ts
packages/session/src/index.ts

packages/agent/src/agent-loop.ts
packages/agent/src/agent-runner.ts
packages/agent/src/provider.ts
packages/agent/src/index.ts
```

预计新增：

```text
packages/agent/src/turn-state.ts
packages/agent/src/turn-context.ts
packages/agent/src/runtime-checkpoint.ts
packages/agent/src/agent-hook.ts
```

是否拆文件以实现时保持代码清晰为准。

默认不修改：

```text
packages/knowledge/**
packages/tui/**
apps/cli/**
```

除非 public API 类型变化导致测试或导入需要同步。

## 18. 实现顺序建议

本分支较大，建议按以下提交推进：

1. Session metadata API。
2. AgentLoop state machine skeleton。
3. TurnContext trace 暴露。
4. pending user turn persist / restore。
5. AgentRunner checkpoint callback。
6. runtime checkpoint restore。
7. hook monitor 最小实现。
8. final integration and docs.

每个提交必须有对应测试。

## 19. 分支完成定义

本分支完成时应满足：

- `AgentLoop.runTurn()` 内部由显式状态机驱动。
- `HeadlessTurnResult` 暴露 state trace。
- `SessionStore` 支持 session metadata。
- 用户消息在 BUILD 阶段提前保存，并通过 `pending_user_turn` 修复 interrupted turn。
- `AgentRunner` 在 awaiting tools、tools completed、final response 三个阶段产生 checkpoint。
- `AgentLoop` 将 checkpoint 写入 session metadata。
- 下一次 `RESTORE` 能 materialize checkpoint 到 session history。
- restore 具备 tail dedupe。
- 正常 SAVE 清除 pending/checkpoint metadata。
- 原有 headless turn、tool call、streaming、CLI smoke tests 保持通过。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。

## 20. Open Questions

以下问题需要 review 后再定：

1. `HeadlessTurnResult.trace` 是否作为 public API 长期保留，还是仅作为 debug 字段？
2. checkpoint callback 失败时是否应该使 turn failed？本文档当前选择 failed。
3. hook 异常是否隔离？本文档当前倾向生命周期 hook 隔离、`finalizeContent` 不隔离，但实现时可再确认。
4. failed turn 是否追加 assistant error placeholder？本文档当前选择追加，以保持 session turn boundary 合法。
5. 本分支是否实现 no-op `COMPACT` / `COMMAND`，还是只在 transition table 保留？本文档当前选择实现 no-op handler。
