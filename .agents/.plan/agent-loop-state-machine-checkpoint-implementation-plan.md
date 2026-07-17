# Agent Loop 状态机与 Checkpoint 实现计划

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
  -> 最小 AgentHook 监控面
```

本计划是 review-oriented handoff，不重复设计文档的完整说明。实现时遇到设计未覆盖的架构决策，应先回到 design review，不在代码中临时拍板。

## 2. 实现原则

- 保持 `AgentLoop.runTurn(input, options)` 的 public API 入口不变。
- `TurnContext` 只能由 `AgentLoop` 内部创建，调用方不传入。
- `AgentRunner` 不依赖 `SessionStore`、SQLite、CLI、TUI、Knowledge。
- checkpoint 是恢复机制，hook 是监控机制，两者不要合并。
- `RuntimeEvent` 不新增 state-level 事件，本分支用 `StateTraceEntry` 表达状态机埋点。
- `COMPACT` 和 `COMMAND` 在本分支保留为 no-op / 最小 handler，只固定扩展点。
- 不实现 Knowledge、真实 compact、command router、MessageBus、subagent、mid-turn injection。
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
  event: TurnStateEvent | "";
  error?: string;
}
```

约束：

- `TurnContext` 是 AgentLoop 内部 mutable workspace，不作为外部调用入参。
- `HeadlessTurnResult` 新增 `trace: StateTraceEntry[]`。
- completed turn 的 trace 至少覆盖 `RESTORE -> COMPACT -> COMMAND -> BUILD -> RUN -> SAVE -> RESPOND`。
- handler 抛错时，trace 应记录当前 state、空 event 和 error 字符串，然后继续抛出异常。

### 3.3 RuntimeCheckpoint

checkpoint payload 使用 discriminated union，而不是一个宽泛 interface：

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

约束：

- checkpoint payload 必须可 JSON serialize。
- `final_response` 不允许携带 pending tool calls。
- `awaiting_tools` 不允许携带 completed tool results。
- `tools_completed` 不允许携带 pending tool calls。
- checkpoint key 属于 `@byte-mentor/agent` 内部协议，不放入 `@byte-mentor/core`。

### 3.4 AgentRunner checkpoint / hook

`AgentRunnerInput` 需要扩展：

```ts
checkpoint?: (payload: RuntimeCheckpoint) => Promise<void>;
hooks?: AgentHook[];
```

约束：

- checkpoint callback 失败时，runner 返回 failed result，不继续执行。
- hook 用于监控，不负责 session 恢复。
- hook 异常策略按 design 执行：生命周期 hook 默认隔离；`finalizeContent` 不隔离。
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
- 人为制造缺失 transition 时，runTurn 抛出包含 state 和 event 的错误。
- 人为制造某个 state handler 抛错时，trace 中记录对应 state 的 `error`，错误继续向外抛出。
- 原有 tool call integration test 在状态机改造后仍通过。

Review 重点：

- `TurnContext` 是否只在 AgentLoop 内部创建和流转。
- `runTurn()` 是否只负责创建 ctx、驱动状态机、返回 result。
- 各 state handler 的职责是否清晰，没有把所有逻辑继续堆在 driver 里。
- `RuntimeEvent` 与 `StateTraceEntry` 是否没有混用。

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
- AgentLoop 将 checkpoint 写入 session metadata。
- RESTORE 阶段将 metadata 中的 runtime checkpoint materialize 到 session history。
- restore 具备 tail dedupe。

测试：

- 无工具 completed turn 中，runner 调用一次 `final_response` checkpoint；payload 包含 final assistant message，且可 JSON serialize。
- tool turn 中，runner 先调用 `awaiting_tools` checkpoint；payload 包含 assistant tool-call message 和 pending tool calls。
- tool 执行完成后，runner 调用 `tools_completed` checkpoint；payload 包含 completed tool messages，pending tool calls 为空。
- `ToolCall.argsParseError` 场景中，runner 不执行 tool registry，但仍产生 `awaiting_tools` 和 `tools_completed` checkpoint，后者包含合成 tool message。
- checkpoint callback 抛错时，runner 返回 failed result，error message 包含 checkpoint 失败原因。
- 手动写入 `runtime_checkpoint` metadata：RESTORE 会追加 assistant message 和 completed tool messages。
- 手动写入 `runtime_checkpoint` metadata 且包含 pending tool calls：RESTORE 会为 pending call 合成 interrupted tool message。
- session 尾部已包含 checkpoint 部分消息时，RESTORE 不重复追加重叠消息。
- RESTORE 成功后清理 `runtime_checkpoint` 和 `pending_user_turn`。
- 非法 checkpoint metadata 被清理，不阻断当前 turn。
- SQLite store 关闭重开后，runtime checkpoint 仍能被下一次 AgentLoop 恢复。

Review 重点：

- `RuntimeCheckpoint` 是否使用 discriminated union，避免非法字段组合。
- AgentRunner 是否仍然不知道 SessionStore。
- AgentLoop restore 是否发生在 BUILD 读取 history 之前。
- restore 的 interrupted tool result 是否保持合法 tool boundary。
- checkpoint 写入失败是否不会被静默吞掉。

### Batch 5: AgentHook monitor and final integration

范围：

- `packages/agent/src/agent-hook.ts`
- `packages/agent/src/agent-runner.ts`
- `packages/agent/src/index.ts`
- `test/agent/agent-runner.test.ts`
- `test/agent/tool-contracts.test.ts`
- `test/agent/headless-turn.integration.test.ts`
- 受 public type 变化影响的 CLI 测试

目标：

- 引入最小 AgentHook lifecycle。
- 让 AgentRunner 通过 hook 暴露 iteration、stream、tool execution、after iteration、finalize content 等监控点。
- 不把 hook 设计成插件系统，不接 TUI，不改变 checkpoint 恢复机制。
- 完成全量回归和文档校准。

测试：

- 无工具 completed turn 中，hook 调用顺序为 beforeIteration -> stream/onStreamEnd（如有 streaming）-> afterIteration。
- tool turn 中，hook 调用顺序包含 beforeIteration -> beforeExecuteTools -> afterIteration，并且 hook context 能看到 tool calls 和 tool results。
- 多 hooks 按注册顺序调用。
- 生命周期 hook 抛错时，不导致 runner 崩溃；错误按设计记录或暴露。
- `finalizeContent` 能修改 final assistant content；如果 `finalizeContent` 抛错，runner 按设计失败或抛出，不能静默吞掉。
- 现有 `onStreamEvent` 仍只接收最终完成轮次的 content delta。
- CLI `run-chat` 测试无需理解 hook，仍通过。
- 完整 fake provider + fake tool + SQLite session 集成测试通过。

Review 重点：

- hook 是否只是 runner 监控面，没有承担 checkpoint 持久化职责。
- hook context 是否没有泄露 SessionStore / CLI / TUI 概念。
- runner 主循环是否仍然可读，没有为了 hook 过度抽象。
- 本分支是否没有引入 Knowledge/TUI/MessageBus 等非目标能力。

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
- runtime checkpoint 能跨 SQLite store instance 恢复。
- restore 具备 tail dedupe。
- AgentHook 能观察 runner 生命周期，且不与 checkpoint 职责混淆。
- 原有 headless turn、tool call、streaming、CLI smoke 行为保持兼容。

## 6. Review 前检查清单

- 本计划是否与 design 文档一致。
- 是否需要把 design 文档中的 `RuntimeCheckpoint` 从普通 interface 同步改为 discriminated union。
- 是否接受 `HeadlessTurnResult.trace` 作为 public API。
- 是否接受 failed turn 写 assistant placeholder 以保持 session turn boundary。
- 是否接受 checkpoint callback 失败直接使 runner failed。
- 是否接受本分支实现最小 hook，而不是把 hook 推迟到后续分支。
