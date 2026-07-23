# Agent Loop 状态机与 Checkpoint 设计

## 1. 文档定位

本文档定义 `feat/agent-loop-state-machine-checkpoint` 分支的设计结论。

本分支目标是继续完善 Byte Mentor 的 agent 基座，而不是推进 Knowledge、TUI 或产品教学能力。

本设计严格参考 nanobot 中以下工程实践：

- `AgentLoop` 使用显式 turn 状态机驱动一次消息处理。
- `TurnContext` 作为一次 turn 内跨状态共享的数据容器。
- 状态机 trace 记录每个成功完成 state 的耗时和事件；状态机异常通过携带 partial trace 的结构化错误向外抛出。
- `AgentRunner` 在关键执行阶段通过 checkpoint callback 暴露可恢复状态。
- `AgentLoop` 将 runner checkpoint 写入 session metadata。
- 下一次 turn 的 `RESTORE` 阶段能够恢复未完成 turn 跨多个 ReAct iteration 累积的 assistant / tool 上下文。

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
3. `AgentRunner` checkpoint 产出与 `AgentLoop` restore。

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
- AgentHook / runner 生命周期监控；后续使用独立设计与实现计划推进。

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

异常不作为 state event 返回。状态机自身错误由 `runTurn()` 包装为 `AgentLoopStateError` 后继续抛出，交给调用方捕获；trace entry 不记录 error，避免把状态流转追踪与错误处理混用。

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

transition lookup 实现为 package internal 的纯函数 `nextTurnState(state, event)`。它供 driver 使用，不从 `@byte-mentor/agent` public API 导出。

如果缺少 transition，抛出错误：

```text
No transition from <state> on event "<event>"
```

纯函数单元测试必须覆盖 transition 缺失路径；AgentLoop 测试负责覆盖 driver 对 handler 异常的结构化包装。

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
  const state = ctx.state;
  const startedAt = clock.now();
  let event: TurnStateEvent | undefined;
  try {
    event = await handler(ctx);
    ctx.trace.push(...);
    ctx.state = nextState(state, event);
  } catch (cause) {
    throw createAgentLoopStateError(ctx, state, event, cause);
  }
}

return ctx.result;
```

`runTurn()` 不再直接写完整 pipeline。

handler、SessionStore、ContextBuilder 或 transition 抛出的异常属于状态机执行异常。driver 必须在当前 state 边界包装异常，从而保留失败位置和此前成功完成的状态流转。

Runner 的 provider / max-iterations 等预期失败不属于此类异常。它们继续通过 `AgentRunnerResult` 和 `HeadlessTurnResult` 的 failed / max_iterations 分支返回，因此仍能得到正常的 result trace。

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
  event: TurnStateEvent;
}
```

设计原则：

- `startedAt` 使用毫秒时间戳，便于测试和输出。
- `durationMs` 记录 handler 耗时。
- handler 成功时写入返回 event。
- handler 抛错时不写入失败 state 的 trace entry。
- 状态机 driver 抛出的 `AgentLoopStateError.trace` 保存此前成功完成 entry 的快照。

`StateTraceEntry` 不放入 `RuntimeEvent`。

原因：

- `RuntimeEvent` 表示稳定运行事实，未来给 UI / CLI 消费。
- `StateTraceEntry` 表示状态机成功流转埋点，主要给测试、日志和开发诊断使用。

### 7.4 AgentLoopStateError

状态机执行异常使用结构化错误：

```ts
export class AgentLoopStateError extends Error {
  readonly state: TurnState;
  readonly event?: TurnStateEvent;
  readonly turnId: TurnId;
  readonly sessionId?: SessionId;
  readonly trace: readonly StateTraceEntry[];
  readonly cause: unknown;
}
```

约束：

- `state` 是异常发生时正在执行或计算 transition 的 state。
- `event` 只在 handler 已成功返回、但 transition 计算失败时存在。
- `trace` 使用 `ctx.trace` 的数组快照，只包含成功完成的 state。handler 失败时不包含当前 state；transition 失败时包含已成功返回 event 的当前 state。
- `cause` 保留原始异常，不能只复制 message，以免丢失原始 stack 和错误类型。
- error message 至少包含失败 state；transition 缺失时同时包含 event。
- `AgentLoopStateError` 从 `@byte-mentor/agent` 导出，使调用方可以使用 `instanceof` 和结构化字段进行日志与诊断。

调用方负责捕获和决定处理策略。CLI 可以只输出包含 state 的 message；日志、测试或未来 TUI 可以进一步读取 partial trace。`RuntimeEvent` 不承担状态机异常诊断职责。

### 7.5 HeadlessTurnResult 扩展

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

checkpoint 保存的是当前 turn 尚未由 `SAVE` 提交的累计消息快照，而不是最近一次 ReAct iteration 的局部结果。session metadata 仍然只保留一个最新 checkpoint；每次写入会覆盖旧 checkpoint，但新 payload 的 `newMessages` 包含当前 turn 从第一轮 iteration 开始累积的全部消息。

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
      newMessages: Message[];
      pendingToolCalls: ToolCall[];
    }
  | {
      phase: "tools_completed";
      iteration: number;
      newMessages: Message[];
      pendingToolCalls: [];
    }
  | {
      phase: "final_response";
      iteration: number;
      newMessages: Message[];
      pendingToolCalls: [];
    };
```

字段说明：

- `phase`：checkpoint 所处 runner 阶段。
- `iteration`：runner iteration index。
- `newMessages`：当前 turn 从第一轮 iteration 开始、尚未由 `SAVE` 提交的累计 assistant/tool 消息快照。
- `pendingToolCalls`：尚未完成的 tool calls。

使用 discriminated union 的原因是让 TypeScript 在类型层面阻止非法组合，例如 `final_response` 携带 `pendingToolCalls`。

三个 phase 对 `newMessages` 的约束：

- `awaiting_tools`：末尾包含当前 iteration 的 assistant tool-call message；`pendingToolCalls` 与这批尚未完成的调用对应。
- `tools_completed`：包含此前所有 iteration 的消息，以及当前 iteration 的 assistant tool-call message 和 tool results。
- `final_response`：包含此前所有 iteration 的消息和最终 assistant message。

`newMessages` 必须是 checkpoint 生成时的数组快照，不能与 runner 后续继续追加的 mutable array 共享引用。

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
newMessages.push(assistantMessage);
await checkpoint({
  phase: "awaiting_tools",
  iteration,
  newMessages: [...newMessages],
  pendingToolCalls: assistantMessage.toolCalls,
});
```

#### tools_completed

工具执行完成并构造所有 tool messages 后：

```ts
newMessages.push(...toolMessages);
await checkpoint({
  phase: "tools_completed",
  iteration,
  newMessages: [...newMessages],
  pendingToolCalls: [],
});
```

#### final_response

runner 得到最终 assistant message 后、返回给 AgentLoop 前：

```ts
newMessages.push(finalAssistantMessage);
await checkpoint({
  phase: "final_response",
  iteration,
  newMessages: [...newMessages],
  pendingToolCalls: [],
});
```

连续两轮工具调用时，metadata 中虽然始终只有一个 latest checkpoint，但 payload 持续累积：

```text
iteration 0 awaiting_tools:  [assistant A]
iteration 0 tools_completed: [assistant A, tool A]
iteration 1 awaiting_tools:  [assistant A, tool A, assistant B]
iteration 1 tools_completed: [assistant A, tool A, assistant B, tool B]
```

### 10.5 checkpoint 失败策略

checkpoint callback 失败时，runner 应返回 failed result，而不是继续执行。`RunnerResult.error.message` 保留原始 checkpoint 错误，便于调用方定位持久化失败原因。

`awaiting_tools` 阶段是特殊情况：此时 assistant tool-call message 已经进入 runner 的 `newMessages`，但 checkpoint 尚未成功持久化。Runner 掌握这一批准确的 `pendingToolCalls`，因此必须当场闭合 tool boundary：

1. 不执行任何 pending tool。
2. 为每个 pending tool call 合成对应的 tool error message：

   ```text
   Error: Tool execution skipped because checkpoint persistence failed.
   ```

3. 将合成的 tool messages 追加到 `newMessages`。
4. 返回 failed runner result，由 AgentLoop 的 `SAVE` 持久化这段已闭合 transcript，并清理 `pending_user_turn` / `runtime_checkpoint`。

`tools_completed` 和 `final_response` 阶段的 checkpoint 失败时已经没有 pending tool call，因此不合成 tool error，只保留已产生的 `newMessages` 并返回 failed result。

这一补全责任属于 AgentRunner，而不是 RESTORE：

- Runner 掌握本次 checkpoint 对应的准确 pending 集合。
- checkpoint 写入失败后，metadata 可能根本没有这份 payload，RESTORE 无法可靠地推断应补哪些 tool call。
- Runner 返回前闭合 transcript，可以让当前 turn 经由正常 `SAVE` 路径一次性持久化，无需把修复逻辑推迟到下一轮。

原因：

- checkpoint 是本分支的恢复保证。
- 如果 checkpoint 写不进去却继续执行，崩溃恢复语义会变得不可预测。
- 当前没有复杂 logger / metrics，显式 failed 更容易测试和诊断。

后续如果需要更高可用性，可以改成 best-effort checkpoint，但不在本分支做。

### 10.6 已知限制：同批多 tool call 的部分完成状态

当同一条 assistant message 包含多个 tool call 时，当前 runner 只在整批工具执行前写 `awaiting_tools` checkpoint，在整批执行完成后写 `tools_completed` checkpoint。

因此，如果进程在同批工具的部分调用完成后崩溃，最新 checkpoint 仍会把整批调用视为 pending，无法保留已完成子集的精确状态。

本分支不引入 per-tool checkpoint 或逐个工具执行状态机。该限制留待后续完善整体 Tool 体系时统一处理。

## 11. Restore Runtime Checkpoint

### 11.1 restore 时机

`RESTORE` 阶段读取 session metadata。

如果存在 `runtime_checkpoint`，调用：

```ts
restoreRuntimeCheckpoint(session)
```

### 11.2 materialize 规则

将 checkpoint 转换为 session messages：

1. 按原顺序复制累计的 `newMessages`。
2. 对每个 `pendingToolCalls` 合成 tool message：

```ts
{
  id: createMessageId(),
  role: "tool",
  toolCallId: toolCall.id,
  content: "Error: Task interrupted before this tool finished."
}
```

然后将尚未出现在 session 尾部的消息追加到 session。

runtime checkpoint 表示 LLM 已经至少产生了一条 assistant 消息。因此成功处理 runtime checkpoint 时会同时清除 `pending_user_turn`，不会再追加“response 尚未生成”的通用 assistant interrupted placeholder。

RESTORE 只把中断 turn 的累计上下文物化并闭合孤儿 tool call，不会重新执行 pending tool，也不会从原 iteration 继续旧 ReAct。随后到来的当前请求会基于恢复后的 history 启动一个新 turn。

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
restoredMessages = checkpoint.newMessages + synthesized pending tool errors
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

## 12. AgentHook 延后

2026-07-23 决定：AgentHook 不在 `feat/agent-loop-state-machine-checkpoint` 分支实现，后续作为独立能力重新设计和实施。

本分支因此不定义 `AgentHookContext`、`AgentHook`、`CompositeAgentHook` 或 `AgentRunnerInput.hooks`，也不改变现有 streaming 与 final content 处理语义。

checkpoint callback 继续只承担恢复职责：payload 必须稳定、可序列化、可持久化。后续 AgentHook 只承担监控职责，不应与 checkpoint 合并；具体 lifecycle、异常隔离和 `finalizeContent` 语义留给独立设计确认。

## 13. AgentRunner 行为调整

### 13.1 保持职责边界

`AgentRunner` 仍然不依赖：

- SessionStore
- CLI/TUI
- Knowledge
- Teaching Brief
- SQLite

它只通过 checkpoint callback 暴露可恢复的中间状态。

### 13.2 streaming 语义保持

现有行为：

- runner 消费 provider `invokeStream`。
- 只把最终完成轮次的 content delta 透传给 `onStreamEvent`。
- tool-call 中间轮次不对 CLI 打印 content delta。

本分支保持该行为。

本分支不增加 hook 相关 streaming 行为。

### 13.3 final response checkpoint

无工具直接完成时，也必须产生 `final_response` checkpoint。

原因：如果 provider 返回最终 assistant 后、AgentLoop SAVE 前崩溃，下一轮仍应恢复该 assistant message。

`final_response.newMessages` 同样是整个未提交 turn 的累计快照，而不是只包含最终 assistant message。

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

RESTORE 不会续跑上一次 turn 的 ReAct。上一次 turn 通过恢复累计消息、为 pending tool calls 合成 interrupted tool results 而结束；当前输入再启动新的 ReAct。

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
- handler 抛错时抛出 `AgentLoopStateError`，其中包含失败 state、原始 cause 和此前成功完成的 partial trace。
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
- 连续多轮工具调用时，每个新 checkpoint 的 `newMessages` 都包含此前 iteration 的 assistant/tool 消息，不被后一轮覆盖。
- `argsParseError` 合成 tool message 后也调用 `tools_completed` checkpoint。
- `awaiting_tools` checkpoint callback 抛错时，runner 不执行工具，并为每个 pending tool call 合成对应的 tool error message。
- checkpoint callback 抛错时 runner 返回 failed，`error.message` 保留原始 checkpoint 失败原因。
- `tools_completed` / `final_response` checkpoint callback 抛错时不额外合成 tool error。
- checkpoint payload 可 JSON serialize。

### 16.5 Runtime checkpoint restore tests

新增或扩展 `test/agent/agent-loop.test.ts`：

- restore 累计 `newMessages` 中跨多个 iteration 的 assistant + completed tool results。
- restore pending tool calls 为 interrupted tool messages。
- runtime checkpoint 存在时不再追加 pending user turn 的通用 assistant interrupted placeholder。
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
7. checkpoint persistence failure closure。
8. final integration and docs。

每个提交必须有对应测试。

## 19. 分支完成定义

本分支完成时应满足：

- `AgentLoop.runTurn()` 内部由显式状态机驱动。
- `HeadlessTurnResult` 暴露 state trace。
- `SessionStore` 支持 session metadata。
- 用户消息在 BUILD 阶段提前保存，并通过 `pending_user_turn` 修复 interrupted turn。
- `AgentRunner` 在 awaiting tools、tools completed、final response 三个阶段产生 checkpoint。
- 每个 checkpoint 都携带当前未提交 turn 的累计 `newMessages` 快照，连续 ReAct iteration 不覆盖早期消息。
- `AgentLoop` 将 checkpoint 写入 session metadata。
- `awaiting_tools` checkpoint 写入失败时，runner 跳过工具执行、补齐对应 tool error，并返回保留原始失败原因的 failed result。
- 下一次 `RESTORE` 能 materialize checkpoint 到 session history。
- restore 具备 tail dedupe。
- 正常 SAVE 清除 pending/checkpoint metadata。
- 原有 headless turn、tool call、streaming、CLI smoke tests 保持通过。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。

## 20. Open Questions

以下问题需要 review 后再定：

1. `HeadlessTurnResult.trace` 是否作为 public API 长期保留，还是仅作为 debug 字段？
2. failed turn 是否追加 assistant error placeholder？本文档当前选择追加，以保持 session turn boundary 合法。
3. 本分支是否实现 no-op `COMPACT` / `COMMAND`，还是只在 transition table 保留？本文档当前选择实现 no-op handler。
