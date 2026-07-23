# Agent Loop 状态机与 Checkpoint 实现计划

## 当前实施进度

更新时间：2026-07-23

| Batch | 状态 | 说明 |
| --- | --- | --- |
| Batch 1: Session metadata contract | GREEN 已完成 | InMemory / SQLite metadata 实现、测试和 typecheck 已通过 |
| Batch 2: AgentLoop state machine and TurnContext trace | GREEN 已完成 | 状态机、trace 和结构化错误已实现并通过验证 |
| Batch 3: Pending user turn and SAVE semantics | GREEN 已完成 | pending user turn、RESTORE 修复和 SAVE 清理已通过验证 |
| Batch 4: AgentRunner checkpoint and runtime restore | GREEN 已完成 | 累计 checkpoint、runtime restore、tail dedupe 与 SQLite reopen 已实现；全量 149 tests 通过 |
| Batch 4.5: checkpoint persistence failure closure | GREEN 已完成 | checkpoint 失败闭合、全仓 151 tests、typecheck、lint、build 已通过 |

当前执行点：本计划的实现批次已全部完成。AgentHook 已从本分支移除，后续使用独立 design、plan 和分支推进；当前分支下一步执行最终验收与收尾。

## 1. 目标

按 `.agents/.design/agent-loop-state-machine-checkpoint-design.md` 实现 `feat/agent-loop-state-machine-checkpoint` 分支。

本分支目标是继续完善 Byte Mentor 的 agent 基座，使当前 headless agent runtime 具备：

```text
AgentLoop 状态机
  -> TurnContext / state trace
  -> Session metadata
  -> pending user turn restore
  -> AgentRunner checkpoint
  -> runtime checkpoint restore
```

本计划是 review-oriented handoff，不重复设计文档的完整说明。实现时遇到设计未覆盖的架构决策，应先回到 design review，不在代码中临时拍板。

## 2. 实现原则

- 保持 `AgentLoop.runTurn(input, options)` 的 public API 入口不变。
- `TurnContext` 只能由 `AgentLoop` 内部创建，调用方不传入。
- `AgentRunner` 不依赖 `SessionStore`、SQLite、CLI、TUI、Knowledge。
- checkpoint 只承担恢复职责；后续独立实现的 hook 只承担监控职责，两者不要合并。
- `RuntimeEvent` 不新增 state-level 事件，本分支用 `StateTraceEntry` 表达状态机埋点。
- `COMPACT` 和 `COMMAND` 在本分支保留为 no-op / 最小 handler，只固定扩展点。
- 不实现 Knowledge、真实 compact、command router、MessageBus、subagent、mid-turn injection、AgentHook。
- 每个批次都要先补测试，再实现。
- 批次粒度比之前分支适当放宽，但每个批次仍必须能独立 review。

## 3. 接口协议约束

### 3.1 Session metadata

`@byte-mentor/session` 需要扩展：

```ts
export type SessionMetadata = Record<string, unknown>;

export interface Session {
  id: SessionId;
  metadata: SessionMetadata;
}

export interface SessionStore {
  create(): Promise<Session>;
  get(id: SessionId): Promise<Session | undefined>;
  appendMessages(id: SessionId, messages: Message[]): Promise<void>;
  getHistory(id: SessionId): Promise<Message[]>;
  updateMetadata(
    id: SessionId,
    updater: (metadata: SessionMetadata) => SessionMetadata,
  ): Promise<SessionMetadata>;
  close(): Promise<void>;
}
```

约束：

- `create()` 返回的 session metadata 必须是 `{}`。
- `get()` 返回的 session 必须包含当前 metadata。
- `updateMetadata()` 必须保留 updater 返回值，并返回持久化后的 metadata。
- `updateMetadata()` 不理解 metadata key 的业务语义。
- `SqliteSessionStore` 使用现有 `metadata_json` 字段。
- `InMemorySessionStore.close()` 后仍按现有宽松语义可用；`SqliteSessionStore.close()` 后 metadata API 也必须抛 `SessionStoreClosedError`。

### 3.2 Turn state / context / trace

`@byte-mentor/agent` 需要新增或导出：

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

export type TurnStateEvent = "ok" | "dispatch" | "shortcut";

export interface StateTraceEntry {
  state: TurnState;
  startedAt: number;
  durationMs: number;
  event: TurnStateEvent;
}

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

- `TurnContext` 是 AgentLoop 内部 mutable workspace，不作为外部调用入参。
- `HeadlessTurnResult` 新增 `trace: StateTraceEntry[]`。
- completed turn 的 trace 至少覆盖 `RESTORE -> COMPACT -> COMMAND -> BUILD -> RUN -> SAVE -> RESPOND`。
- trace 只记录成功完成的 state 流转和耗时。
- handler、存储或 transition 异常包装为 `AgentLoopStateError` 后继续向外抛出，由 `runTurn()` 调用方捕获。
- `AgentLoopStateError.trace` 是成功完成 trace 的快照。handler 失败时不包含当前 state；transition 失败时包含已成功返回 event 的当前 state。
- `AgentLoopStateError.cause` 保留原始异常；transition 缺失时 `event` 记录 handler 返回的 event。
- Runner 的 failed / max_iterations 仍通过 `HeadlessTurnResult` 返回，不包装为 `AgentLoopStateError`。
- `nextTurnState(state, event)` 是 package internal 纯函数，不从 `@byte-mentor/agent` public API 导出。

### 3.3 RuntimeCheckpoint

checkpoint payload 使用 discriminated union，而不是一个宽泛 interface：

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

约束：

- checkpoint payload 必须可 JSON serialize。
- metadata 只保存一个 latest checkpoint，但 `newMessages` 必须是当前未提交 turn 从第一轮 iteration 开始的累计快照。
- 每次 callback 获得独立数组快照，后续 runner mutation 不得改变已发出的 payload。
- `awaiting_tools.newMessages` 包含当前 assistant tool-call message，`pendingToolCalls` 与尚未完成的调用对应。
- `tools_completed.newMessages` 包含截至当前 iteration 的全部 assistant/tool messages。
- `final_response.newMessages` 包含此前全部 iteration 消息和最终 assistant message。
- `final_response` 不允许携带 pending tool calls。
- `tools_completed` 不允许携带 pending tool calls。
- checkpoint key 属于 `@byte-mentor/agent` 内部协议，不放入 `@byte-mentor/core`。

### 3.4 AgentRunner checkpoint

`AgentRunnerInput` 需要扩展：

```ts
checkpoint?: (payload: RuntimeCheckpoint) => Promise<void>;
```

约束：

- checkpoint callback 失败时，runner 返回 failed result，不继续执行。
- `awaiting_tools` checkpoint callback 失败时，runner 不执行 pending tools，为每个 pending call 追加对应 tool error，再返回 failed result。
- checkpoint 失败返回的 `error.message` 保留原始 callback 错误原因。
- `tools_completed` / `final_response` 失败时没有 pending call，不额外合成 tool error。
- 现有 `onStreamEvent` 行为保持不变。

## 4. 批次拆分

### Batch 1: Session metadata contract

范围：

- `packages/session/src/session-store.ts`
- `packages/session/src/in-memory-session-store.ts`
- `packages/session/src/sqlite-session-store.ts`
- `packages/session/src/index.ts`
- `test/session/**`

目标：

- 为 session 增加 metadata 能力。
- 让 in-memory 和 SQLite store 都支持 `updateMetadata()`。
- 为 AgentLoop 后续保存 `pending_user_turn` 和 `runtime_checkpoint` 做持久化基础。

测试：

- 创建新 session 时，返回的 `metadata` 是空对象。
- 调用 `updateMetadata()` 写入 `{ a: 1 }` 后，`get()` 能读回 `{ a: 1 }`。
- 连续调用 `updateMetadata()` 时，updater 能看到上一次 metadata；预期不会无意清空旧字段。
- SQLite store 写入 metadata 后关闭，再用同一路径创建新 store，`get()` 能恢复 metadata。
- SQLite store close 后调用 `get()`、`appendMessages()`、`getHistory()`、`updateMetadata()` 都抛 `SessionStoreClosedError`。
- InMemory store 的 close 保持 no-op，close 后 metadata 方法仍可用。

Review 重点：

- `SessionStore` 接口是否仍然只表达通用 session 能力。
- `@byte-mentor/session` 是否没有引入 agent-specific key。
- SQLite 是否复用 `metadata_json`，没有新增复杂迁移系统。
- 现有 session/message 测试是否仍然通过。

### Batch 2: AgentLoop state machine and TurnContext trace

范围：

- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/turn-state.ts`（如拆文件）
- `packages/agent/src/turn-context.ts`（如拆文件）
- `packages/agent/src/index.ts`
- `test/agent/agent-loop.test.ts`
- `test/agent/turn-state.test.ts`
- `test/agent/headless-turn.integration.test.ts`

目标：

- 将 `AgentLoop.runTurn()` 从线性 pipeline 改为显式状态机 driver。
- 引入 `TurnContext` 和 `StateTraceEntry`。
- 保持现有 headless turn 外部行为。
- `COMPACT` 和 `COMMAND` 先作为 no-op / dispatch handler 固定扩展点。

测试：

- 无工具 completed turn 仍返回 completed result，包含 `sessionId`、`finalMessage`、`newMessages`、`events`。
- completed turn 的 `trace.map(t => t.state)` 等于 `RESTORE, COMPACT, COMMAND, BUILD, RUN, SAVE, RESPOND`。
- 每条 trace 都有非空 `state`、`startedAt`、`durationMs` 和成功 event。
- `COMMAND` 当前返回 `dispatch`，因此正常进入 BUILD。
- `nextTurnState` 对合法 state/event 返回预期 next state；缺失 transition 时抛出包含 state 和 event 的清晰错误。
- 人为制造 handler 抛错时，runTurn 抛出 `AgentLoopStateError`，包含失败 state、原始 cause 和此前成功完成的 partial trace；trace 不包含失败 state。
- 原有 tool call integration test 在状态机改造后仍通过。

Review 重点：

- `TurnContext` 是否只在 AgentLoop 内部创建和流转。
- `runTurn()` 是否只负责创建 ctx、驱动状态机、返回 result。
- 各 state handler 的职责是否清晰，没有把所有逻辑继续堆在 driver 里。
- `RuntimeEvent` 与 `StateTraceEntry` 是否没有混用。
- 状态机异常是否保留失败 state、原始 cause 和 immutable partial trace，且没有被错误转换为 RuntimeEvent。

### Batch 3: Pending user turn and SAVE semantics

范围：

- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/runtime-checkpoint.ts`（如先放 metadata key）
- `test/agent/agent-loop.test.ts`
- `test/agent/headless-turn.integration.test.ts`

目标：

- 在 BUILD 阶段提前保存本轮 user message。
- 使用 session metadata 标记 `pending_user_turn`。
- 在 RESTORE 阶段修复上一次只保存了 user message 的 interrupted turn。
- 在 SAVE 阶段统一保存 runner new messages，并清理 pending/checkpoint metadata。
- 失败 turn 需要关闭 session turn boundary。

测试：

- BUILD 阶段之后、RUN 之前，session 中已经包含当前 user message，metadata 中 `pending_user_turn` 为 true。
- completed turn SAVE 后，metadata 中不再有 `pending_user_turn`。
- 手动构造 session：最后一条是 user 且 metadata 中 `pending_user_turn` 为 true；下一次 runTurn 的 RESTORE 会先追加 assistant interrupted placeholder，再处理当前输入。
- 手动构造 session：metadata 有 `pending_user_turn`，但最后一条不是 user；下一次 RESTORE 只清理 flag，不追加 placeholder。
- provider 在 RUN 阶段失败且没有产生 assistant/tool message 时，SAVE 后 session 中有 user message 和 assistant error placeholder，metadata 被清理。
- tool turn 完成时，session message 顺序仍是 user -> assistant(tool calls) -> tool -> final assistant。

Review 重点：

- history 是否在当前 user message 保存前读取，避免当前 user 被重复放入模型输入。
- pending user turn key 是否只在 agent 包内部解释。
- SAVE 是否成为清理 metadata 的唯一正常出口。
- failed turn 的用户可见错误和 session placeholder 是否分离。

### Batch 4: AgentRunner checkpoint and runtime restore

范围：

- `packages/agent/src/agent-runner.ts`
- `packages/agent/src/runtime-checkpoint.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/index.ts`
- `test/agent/agent-runner.test.ts`
- `test/agent/agent-loop.test.ts`
- `test/agent/headless-turn.integration.test.ts`

目标：

- AgentRunner 在 `awaiting_tools`、`tools_completed`、`final_response` 三个阶段产生 checkpoint。
- 每个 checkpoint 携带当前未提交 turn 的累计 `newMessages`，后续 ReAct iteration 不覆盖早期消息。
- AgentLoop 将 checkpoint 写入 session metadata。
- RESTORE 阶段将 metadata 中的累计 runtime checkpoint materialize 到 session history，并为仍 pending 的 tool calls 合成 interrupted tool results。
- RESTORE 终结旧 turn，不重新执行 pending tool，也不续跑旧 ReAct；当前输入基于恢复后的 history 启动新 turn。
- restore 具备 tail dedupe。

测试：

- 无工具 completed turn 中，runner 调用一次 `final_response` checkpoint；`newMessages` 包含 final assistant message，且 payload 可 JSON serialize。
- tool turn 中，runner 先调用 `awaiting_tools` checkpoint；`newMessages` 包含 assistant tool-call message，pending tool calls 与之对应。
- tool 执行完成后，runner 调用 `tools_completed` checkpoint；`newMessages` 累计包含 assistant tool-call message 和 completed tool messages，pending tool calls 为空。
- 连续两次 tool iteration 中，第二轮 `awaiting_tools` / `tools_completed` checkpoint 的 `newMessages` 保留第一轮 assistant/tool messages，并按实际执行顺序累计第二轮消息。
- 每次 checkpoint 的 `newMessages` 是独立数组快照，不会被后续 iteration 的追加反向修改。
- `ToolCall.argsParseError` 场景中，runner 不执行 tool registry，但仍产生 `awaiting_tools` 和 `tools_completed` checkpoint，后者包含合成 tool message。
- checkpoint callback 抛错时，runner 返回 failed result，error message 包含 checkpoint 失败原因。
- 手动写入包含多轮累计 `newMessages` 的 `runtime_checkpoint` metadata：RESTORE 会按顺序追加全部 assistant 和 completed tool messages。
- 手动写入 `runtime_checkpoint` metadata 且包含 pending tool calls：RESTORE 会为 pending call 合成 interrupted tool message。
- 同时存在 runtime checkpoint 和 `pending_user_turn` 时，RESTORE 不追加通用 assistant interrupted placeholder。
- session 尾部已包含 checkpoint 部分消息时，RESTORE 不重复追加重叠消息。
- RESTORE 成功后清理 `runtime_checkpoint` 和 `pending_user_turn`。
- 非法 checkpoint metadata 被清理，不阻断当前 turn。
- SQLite store 关闭重开后，runtime checkpoint 仍能被下一次 AgentLoop 恢复。

Review 重点：

- `RuntimeCheckpoint` 是否使用 discriminated union，避免非法字段组合。
- checkpoint 是否是 latest cumulative snapshot，而不是 latest iteration delta。
- AgentRunner 是否仍然不知道 SessionStore。
- AgentLoop restore 是否发生在 BUILD 读取 history 之前。
- restore 的 interrupted tool result 是否保持合法 tool boundary。
- restore 是否只闭合旧 turn，没有重执行工具或续跑旧 ReAct。
- checkpoint 写入失败是否不会被静默吞掉。

### Batch 4.5: checkpoint persistence failure closure

范围：

- `packages/agent/src/agent-runner.ts`
- `test/agent/agent-runner.test.ts`

目标：

- 当 `awaiting_tools` checkpoint 持久化失败时，由 AgentRunner 当场闭合 assistant tool-call message。
- 不执行这一批 pending tools。
- 为每个 pending tool call 合成内容为 `Error: Tool execution skipped because checkpoint persistence failed.` 的 tool message。
- 返回 failed runner result，但 `error.message` 保留原始 checkpoint callback 错误；后续由现有 SAVE 路径持久化闭合后的 transcript。
- 不在 RESTORE 增加扫描孤儿 tool call 的第二套修复逻辑。

测试：

- `awaiting_tools` checkpoint callback 抛错后，`newMessages` 包含 assistant tool-call message 和每个 pending call 对应的 tool error message。
- checkpoint 写入失败后，tool registry 中对应工具没有被执行。
- runner 返回 `stopReason: "failed"`，且 `error.message` 包含原始 checkpoint 失败原因。

Review 重点：

- tool error 是否与 assistant message 中的每个 pending tool call 一一回链。
- checkpoint 失败后是否在任何工具执行前终止。
- failed result 是否同时保留可持久化的闭合 transcript 和原始错误原因。
- 是否没有修改 RESTORE，也没有扩大到同批多 tool call 的部分完成 checkpoint。

已知限制：同一 assistant 发出多个 tool call 时，当前仍只在整批执行前后写 checkpoint，不保存同批中部分工具已完成的中间状态。该问题留待后续 Tool 体系完善时处理。

### 后续独立工作：AgentHook

AgentHook 不属于本实现计划。后续需要重新确认 lifecycle、streaming、异常隔离、`finalizeContent` 和 UI 监控边界，并使用独立 design、plan 和分支按 TDD 推进。

## 5. 最终验收

完成全部批次后必须通过：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

功能验收：

- `AgentLoop.runTurn()` 内部由状态机驱动。
- `HeadlessTurnResult.trace` 能观察 turn state 顺序和耗时。
- `SessionStore` metadata 在 in-memory 和 SQLite 中行为一致。
- interrupted pending user turn 能在下一次 RESTORE 中被修复。
- AgentRunner 三个 checkpoint phase 都有测试覆盖。
- `awaiting_tools` checkpoint 写入失败时，工具不执行，孤儿 assistant tool calls 被对应 tool error 闭合，且 failed result 保留原始失败原因。
- 连续多轮 ReAct iteration 的 checkpoint 累计消息不会被后续 iteration 覆盖。
- runtime checkpoint 能跨 SQLite store instance 恢复。
- restore 具备 tail dedupe。
- 原有 headless turn、tool call、streaming、CLI smoke 行为保持兼容。

## 6. Review 前检查清单

- 本计划是否与 design 文档一致。
- design 与 plan 中的 `RuntimeCheckpoint` 是否都使用累计 `newMessages` 的 discriminated union。
- 是否接受 `HeadlessTurnResult.trace` 作为 public API。
- 是否接受 failed turn 写 assistant placeholder 以保持 session turn boundary。
- 是否接受 checkpoint callback 失败直接使 runner failed。
- AgentHook 是否已完整移出本分支目标、接口、批次和验收范围。
