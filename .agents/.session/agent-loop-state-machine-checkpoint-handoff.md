# Agent Loop 状态机与 Checkpoint 接棒记录

更新时间：2026-07-23

## 1. 当前执行点

- 分支：`feat/agent-loop-state-machine-checkpoint`
- HEAD：`0195b4b docs: plan agent loop checkpoint runtime`
- 设计文档：`.agents/.design/agent-loop-state-machine-checkpoint-design.md`
- 实现计划：`.agents/.plan/agent-loop-state-machine-checkpoint-implementation-plan.md`
- Batch 1–4.5 已完成 GREEN。
- 用户已 review 并理解 Batch 4 生产代码。
- Batch 4.5 checkpoint persistence failure closure 已实现并通过全量验证。
- 用户决定取消本分支的 Batch 5；AgentHook 后续使用独立 design、plan 和分支推进。

新会话的下一步：

1. 读取本文档、design、plan、`plan-driven-implementation` 和 `test-driven-development` skill。
2. 不进入 AgentHook 实现，也不在当前分支预先定义 Hook API。
3. 执行 plan 中的分支最终验收，处理全仓 `format:check` 的已知遗留项。
4. 完成最终 review 和分支收尾。

## 2. 用户约定的开发节奏

用户已覆盖默认的小步 TDD 节奏：以 plan 中一个 Batch 作为一次开发单位。

每个 Batch：

1. 一次写完该 Batch 的全部 RED 测试。
2. 运行测试并确认按预期失败。
3. 暂停等待用户 review。
4. 用户确认后，一次写完该 Batch 的生产代码并完成 GREEN 验证。
5. 再次暂停等待用户 review。

所有非代码沟通使用中文。不引入 Knowledge、TUI、MessageBus、subagent 等 design 排除项。

## 3. Batch 1–4 完成摘要

### Batch 1: Session metadata

- `Session` 始终包含 `metadata`。
- InMemory / SQLite store 已实现 `updateMetadata(id, updater)`。
- SQLite 复用 `metadata_json`，metadata 可跨 store reopen 恢复。
- Session 包不理解 agent-specific metadata key。

### Batch 2: AgentLoop state machine

- `AgentLoop.runTurn()` 已由 `RESTORE -> COMPACT -> COMMAND -> BUILD -> RUN -> SAVE -> RESPOND` 显式状态机驱动。
- `HeadlessTurnResult` 已暴露 `StateTraceEntry[]`。
- 状态机执行异常包装为 public `AgentLoopStateError`，保留 partial trace 和原始 `cause`。
- `nextTurnState` 是 package internal 纯函数，不从 public API 导出。

### Batch 3: Pending user turn / SAVE

- BUILD 提前保存 user message，并设置 `pending_user_turn`。
- RESTORE 能修复只保存 user message 的 interrupted turn。
- stale pending flag 会被清理，但不会多追加 placeholder。
- SAVE 保存 runner messages，并清理 `pending_user_turn` / `runtime_checkpoint`。
- runner 没有产生任何 assistant/tool message 的 failed turn 会写 assistant error placeholder，闭合 session turn boundary。

### Batch 4: Cumulative checkpoint / restore

- metadata 只保留一个 latest checkpoint，但 payload 的 `newMessages` 累计当前未提交 turn 从第一轮开始的所有 ReAct iteration。
- AgentRunner 在 `awaiting_tools`、`tools_completed`、`final_response` 三个阶段产生独立数组快照。
- RESTORE 将 checkpoint 的累计 messages 追加到 session，并为 `pendingToolCalls` 合成 interrupted tool results。
- RESTORE 有 session-tail overlap dedupe，避免重复追加。
- RESTORE 只闭合旧 turn：不重新执行 pending tool，不续跑旧 ReAct；当前 user input 基于恢复后的 history 开启新 turn。
- runtime checkpoint 可跨 SQLite store instance 恢复。

累计示例：

```text
iteration 0 awaiting_tools:  [assistant A]
iteration 0 tools_completed: [assistant A, tool A]
iteration 1 awaiting_tools:  [assistant A, tool A, assistant B]
iteration 1 tools_completed: [assistant A, tool A, assistant B, tool B]
```

## 4. Batch 4.5 完成摘要

问题：当 `awaiting_tools` checkpoint callback 失败时，当前 AgentRunner 会在执行工具前返回 failed，但 `newMessages` 只有 assistant tool-call message，因此 SAVE 可能保存孤儿 tool calls。

采用方案：Runner 现场补全，不在 RESTORE 增加全局扫描孤儿 tool call 的兜底逻辑。

`awaiting_tools` checkpoint callback 失败后：

```text
不执行工具
  -> 为每个 pendingToolCall 合成 ToolMessage error
  -> 返回 failed RunnerResult
  -> AgentLoop SAVE 保存闭合后的 transcript
```

合成的 tool error content 固定为：

```text
Error: Tool execution skipped because checkpoint persistence failed.
```

其他约束：

- 为每个 pending tool call 合成一条 tool message，`toolCallId` 一一回链。
- `RunnerResult.error.message` 保留原始 checkpoint callback 错误。
- `tools_completed` / `final_response` checkpoint 失败时已没有 pending call，不补 tool error。
- 责任归 AgentRunner，因为它掌握此刻准确的 pending 集合；checkpoint 根本没写入时，RESTORE 也无法从 metadata 推断它们。

### Batch 4.5 验收结果

- checkpoint 失败后，`newMessages` 包含 assistant tool-call message 和每个 pending call 对应的 tool error。
- tool registry 中对应工具没有被执行。
- result 的 `stopReason` 为 `failed`，`error.message` 包含原始 checkpoint 失败原因。
- 双 pending tool call 测试验证 tool error 与 `toolCallId` 一一回链。

## 5. 已知限制，本分支暂不处理

同一 assistant message 发出多个 tool call 时，当前只在整批工具执行前后写 checkpoint。如果进程在同批工具部分完成后崩溃，latest checkpoint 仍把整批视为 pending，无法保留已完成子集。

用户已确认本次不改。后续完善整体 Tool 体系时，再考虑 per-tool checkpoint 或逐个工具的执行状态机。

## 6. Batch 4.5 实现结果

`packages/agent/src/agent-runner.ts` 当前已有：

```ts
if (awaitingToolsError !== undefined) {
  newMessages.push(
    ...assistantMessage.toolCalls.map<ToolMessage>((toolCall) => ({
      id: createMessageId(),
      role: "tool",
      toolCallId: toolCall.id,
      content: CHECKPOINT_PERSISTENCE_FAILURE_TOOL_ERROR,
    })),
  );
  return checkpointFailed(newMessages, events, awaitingToolsError);
}
```

因此：

- 工具已经不会在 checkpoint 失败后执行。
- failed result 已保留 checkpoint 错误。
- 每个 pending tool call 都会在返回前获得对应的 tool error message。
- AgentLoop 后续可以通过现有 SAVE 路径持久化闭合后的 transcript。

## 7. 已完成验证

Batch 4 GREEN 完成时：

```text
Batch 4 定向测试                    34 passed
test/agent                          81 passed
pnpm test                          149 passed
pnpm typecheck                     PASS
pnpm lint                          PASS
pnpm build                         PASS
本轮相关文件 Prettier / diff check  PASS
```

Batch 4.5 GREEN 完成时：

```text
test/agent/agent-runner.test.ts      16 passed
test/agent                           83 passed
pnpm test                           151 passed
pnpm typecheck                      PASS
pnpm lint                           PASS
pnpm build                          PASS
相关文件 Prettier / diff check       PASS
```

全仓 `pnpm format:check` 仍报告 4 个本轮开始前已修改的文件：

- `packages/session/src/sqlite-session-store.ts`
- `test/agent/turn-state.test.ts`
- `test/session/session-store.test.ts`
- `test/session/sqlite-session-store.test.ts`

不要在 Batch 4.5 中擅自格式化这些文件。

## 8. 工作区保护

当前存在大量已确认且 staged / unstaged 混合的改动。不要 `reset`、`checkout` 或还原任何现有文件，也不要覆盖用户改动。

本次文档交接后的 `git status --short` 应包含：

```text
MM .agents/.design/agent-loop-state-machine-checkpoint-design.md
MM .agents/.plan/agent-loop-state-machine-checkpoint-implementation-plan.md
AM .agents/.session/agent-loop-state-machine-checkpoint-handoff.md
MM packages/agent/src/agent-loop.ts
 M packages/agent/src/agent-runner.ts
MM packages/agent/src/index.ts
A  packages/agent/src/turn-state.ts
M  packages/session/src/in-memory-session-store.ts
M  packages/session/src/session-store.ts
M  packages/session/src/sqlite-session-store.ts
M  test/agent/agent-loop.test.ts
MM test/agent/agent-runner.test.ts
M  test/agent/headless-turn.integration.test.ts
A  test/agent/turn-state.test.ts
M  test/cli/run-chat.test.ts
M  test/session/session-store.test.ts
M  test/session/sqlite-session-store.test.ts
?? packages/agent/src/runtime-checkpoint.ts
```

当前没有新 commit。Batch 4.5 的测试和生产代码改动保留在工作区；不要还原或覆盖。

## 9. 分支收尾与 AgentHook 后续

当前分支不再进入 Batch 5。AgentHook 后续需要独立确认 lifecycle、streaming、异常隔离、`finalizeContent` 和 UI 监控边界，再创建新的 design、plan 和实现分支。

分支最终仍需执行 plan 中的全量验收：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
