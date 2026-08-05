# Write-tools 开发进度

## 目标

按 `.agents/.design/write-tools-design.md` 与 `.agents/.plan/write-tools-implementation-plan.md` 实现 `edit_file`、turn 级取消链路、`bash` 三个能力的 Batch 1–6。Batch 0 设计契约已冻结。

## 状态总览

| Batch | 内容 | 状态 | Commit |
|---|---|---|---|
| 0 | 设计契约冻结 | ✅ 完成 | — |
| 1 | 共享路径边界 + 原子编辑能力 | ✅ 完成 | `2981678 refactor(agent): establish workspace edit boundary` |
| 2 | `edit_file` 纵向切片 | ✅ 完成 | `5510492 feat(agent): add workspace file edit tool` |
| 3 | turn 级取消链路 | ✅ 完成 | `97ac75f feat(agent): propagate turn cancellation` |
| 4 | 受控 Shell 环境 + 一次性进程执行器 | ✅ 完成 | `d644826 feat(agent): add managed shell executor` |
| 5 | Shell 输出累加 + 完整日志生命周期 | ✅ 完成 | `38221ee feat(agent): capture bounded shell output` |
| 6 | `bash` Tool 与 CLI 闭环 | ✅ 完成 | `d536827 feat(agent): add bash execution tool` |

分支：`feat/agent-write-tools`。

## 工作方式约定

- 以 batch 为单位一次性写完整测试 + 生产代码，全量验证后停等 review，不逐小步暂停。
- 汇报时区分「测试可直接验证」与「架构重点 review」两类。
- 每个 batch 完成确认后按 plan 建议的 commit message 提交。
- 测试一律使用临时目录/本地子进程，不调用真实模型 API。

## Batch 1 已交付（`2981678`）

范围：`WorkspacePathResolver` / `WorkspaceReader` 重构 / `WorkspaceEditor` / `workspace-policy`。

- **`workspace-path-resolver.ts`（新）**：`WorkspaceError` 单一来源（从 Reader 迁出）、`WorkspacePathResolver.resolveAccessiblePath()` 返回 `{ relativePath, absolutePath, canonicalTarget, canonicalRelativePath, type, isSymbolicLink }`，共享 `isOutsideRoot`/`toWorkspacePath`/`isMissingPathError`。
- **`workspace-reader.ts`（重构）**：持有 resolver 实例，`resolvePath` 委托后投影窄返回；`export { WorkspaceError }` 保持 builtin import 兼容。公共 API 不变，现有测试保持 GREEN。
- **`workspace-editor.ts`（新）**：
  - `readTextSnapshot(path)` → `{ path, content, bom }`：剥离 BOM、严格 UTF-8（NUL/非法拒绝 → `unsupported_content`）、2 MiB 上限（stat 后 + 读取后双检查 → `resource_limit`）。
  - `writeTextAtomically(path, content)`：链接编辑真实目标（`canonicalTarget`）并保留链接目录项；同目录随机名 exclusive-create 0600 临时文件 → 写内容 → chmod 原 mode → rename 原子提交；失败只清理本次临时文件。
- **`workspace-policy.ts`**：`limits.maxEditableFileBytes` 默认 2 MiB；Editor 用 `min(policy, 2 MiB)` 钳制，Runtime 只能降低。
- 测试：`workspace-editor.test.ts` 26 个 + resolver 1 个。全量 34 文件 / 314 测试 + typecheck/lint/format 通过。
- 修复的缺陷：Reader 残留本地 `WorkspaceError` 定义导致 `instanceof` 失效（18 个回归），改为单一来源 + re-export。

## Batch 2 已交付（`5510492`）

范围：`edit-diff` 纯函数 / `edit_file` Tool / `contracts` 扩展 / CLI 注册。

- **依赖**：`packages/agent` 增加 `diff@8.0.4`（jsdiff），同步 lockfile。
- **`edit-diff.ts`（新，纯函数）**：`applyEdits(source, edits)` 返回 `{ text, replacements, diff, patch, firstChangedLine? }` 或结构化 edit 错误。
  - 匹配空间：先精确（LF 空间），任一 edit 精确不唯一则全部在模糊空间重定位（NFKC、去行尾空白、智能引号→ASCII、dash→`-`、特殊空格→空格）。
  - 唯一性按最终选定空间计算，重叠候选统计（`aa` 在 `aaa` 计 2 次）；缺失/重复/重叠/嵌套/no-op 返回稳定错误码 + `editIndex`/`occurrences`。
  - 换行：CRLF/CR/LF 统一 LF 匹配，写回按「最先检测到的有效换行」恢复；`rebuildText` 只重建受影响行块（按 B 空间区间切片），未触及行从 A 原始文本复制，避免全文归一化副作用。
  - diff：自定义带行号 + 有限上下文展示；patch：jsdiff `createTwoFilesPatch("a","b",...)`。
- **`edit-file.ts`（新）**：协议硬上限（path ≤ 4096、edits 1–64、单字段 ≤ 65536、聚合 ≤ 262144 Unicode 字符，读取文件前校验）；成功 payload `{ path, replacements, diff, patch, firstChangedLine? }`；预算超限在写入前返回 `resource_limit`；BOM 在写回时恢复；未声明 `concurrency: "safe"`。
- **`contracts.ts`**：`ToolErrorCode` 增加 `edit_target_not_found/not_unique/overlap/no_change`；`ToolExecutionContext` 增加必填 `workspaceEditor`。
- **`run-chat.ts`**：创建 `WorkspaceEditor`、注入 context、注册 `edit_file`。
- 测试：`edit-diff.test.ts` 24 个（纯函数）+ `edit-file.test.ts` 16 个（集成）；4 个只读工具测试补 context、`run-chat.test.ts` 工具列表改 5 个。全量 36 文件 / 356 测试 + typecheck/lint/format 通过。
- 修复的缺陷：`rebuildText` 丢块尾换行；模糊模式 `placeEdit` 用 `oldLf.length` 导致 end 越界（改用归一化后 needle 长度）。

## 待确认的实现决策（Batch 2）

- BOM 恢复在 `edit-file` 层（快照剥离 + 写回加回），`edit-diff` 只处理换行。
- 展示 diff 格式 `@@ -old,count +new,count @@` + 行号前缀行；模糊模式下 `newText` 不做模糊归一化。
- 行号对齐不变量：LF/模糊归一化都不改行结构，A 与 B 行号一一对应，`rebuildText` 才能从未触及行直接复制 A。

## Batch 3 已交付（`97ac75f`）

范围：core 类型 / Provider signal / contracts / Editor+edit_file 提交点 / Runner 取消算法 / Loop+checkpoint / CLI Controller / TUI cancelled 终态。

- **core**：`StopReason` 增加 `"cancelled"`；`RuntimeEvent` 增加 `tool.cancelled`（`started`/`durationMs`/`errorCode: "tool_cancelled"|"command_cancelled"`/`message`）与 `turn.cancelled`（`sessionId`/`messageId`/`stopReason: "cancelled"`），`messageId` 指向合成 AssistantMessage。
- **provider**：新增 `ProviderInvocationOptions { signal?: AbortSignal }`；`OpenAIChatProvider.invokeStream` 用 `chat.completions.create(request, { signal })` 中止模型流；signal 不进静态 `ProviderRequest`。
- **contracts**：`ToolErrorCode` 增加 `tool_cancelled`/`command_cancelled`（后者仅表示已启动 Bash 被取消）；新增 `ToolExecutionOptions`；`AgentTool.execute`/`ToolRegistry.execute` 加可选第三参透传。
- **workspace-editor**：`writeTextAtomically(path, content, { signal? })` 在临时文件创建前与 rename 前检查取消，abort 清理临时文件并抛 `WorkspaceError("tool_cancelled")`；rename 成功后不再检查（迟到 abort 不追溯）。
- **edit-file**：execute 消费 `options.signal`（I/O 前返回 `tool_cancelled`），把 signal 传给 editor 提交点。
- **runner**（`AgentRunnerInput.signal`）：迭代前检查 signal；Provider 因 signal 中止 → 取消终态；取消终态追加合成消息 `[Assistant reply cancelled.]`、保存 `pendingToolCalls: []` 的 `cancelled` checkpoint（失败优先返回 `failed`）、不携带 `error`；未启动调用生成 `tool_cancelled` ToolMessage + `tool.cancelled { started: false, durationMs: 0 }`；已启动调用只在实际错误码为 `tool_cancelled`/`command_cancelled` 时产生 `started: true`；并发 safe 批次经 signal-aware `mapWithConcurrency` 停止领取。`cancelledToolCall`/`terminalToolEvent` 为模块级纯函数。
- **runtime-checkpoint**：`RuntimeCheckpoint` 增加 `cancelled` phase 变体（`pendingToolCalls` 必须为空）+ 校验。
- **agent-loop**：`HeadlessTurnOptions.signal`、`stateRun` 透传、新增 `CancelledHeadlessTurnResult`（不携带 `error`）、`stateRespond` 发 `turn.cancelled` 并返回 `status: "cancelled"`。
- **interactive-chat-controller**：每 turn 独立 `AbortController` 传入 runTurn，turn 完成后释放引用；忙碌 `requestExit` abort 当前 turn 并等收敛后 cleanup；`tool.cancelled` → `cancelToolCall` 收敛为终态卡片；cancelled 结果结束流式卡片但不 `showError`。
- **tui（plan 范围外，经确认）**：`ToolExecutionState` 增加 `cancelled` + `cancel(message)` + glyph `⊘` + 专属背景（theme 新增 `toolCancelled`）；`ToolViewStore.cancel`；`ByteMentorTui.cancelToolCall`。
- 测试：core 2 文件、provider signal、registry 第三参、editor/edit-file 取消、runner 8 个取消用例、loop cancelled 分支、controller 忙碌退出、TUI cancelled 渲染；`agent-loop.stream.test.ts` 契约补 `signal`。全量 **36 文件 / 382 测试** + typecheck/lint/format 通过。
- 修复：`RuntimeCheckpoint`/`ToolErrorCode` 缺 `cancelled`/`command_cancelled` 类型；`cancelledToolCall`/`terminalToolEvent` 从私有方法改为模块级纯函数；`agent-loop.stream.test.ts` 契约测试补 `signal` 字段。

## Batch 4 已交付（`d644826`）

范围：`shell-environment.ts` / `shell-executor.ts` / index.ts 公共导出，为 Batch 6 的 `bash` 提供受控环境与一次性进程执行器（不组装 ToolResult）。

- **`shell-environment.ts`（新）**：
  - `ShellError`（`code` 仅 `shell_unavailable`，Batch 6 bash.ts 直接映射 ToolError）。
  - `resolveShellPath({ parentEnv, explicitShellPath?, defaultShellPath? })`：按「显式配置 → 默认 `/bin/bash` → 受控 PATH 查找 `bash`」选路径，绝不降级 `sh`；校验存在/普通文件/`X_OK`；**显式配置不可用即报错不回退**，默认路径「不存在」才走 PATH 查找、「存在但不可用」也报错。
  - `createShellEnvironment({ parentEnv, allowlist, shellPath })`：基础集合 `PATH/HOME/USER/LOGNAME/TMPDIR/LANG` + 全部 `LC_*` → 白名单（denylist 优先：`OPENAI_API_KEY`、全部 `BYTE_MENTOR_*`、`PWD/OLDPWD/BASH_ENV/ENV/CDPATH/PROMPT_COMMAND`）→ 固定值 `SHELL=shellPath/TERM=dumb/NO_COLOR=1`；不复制 `PWD`、不设 `CI`。
- **`shell-executor.ts`（新）**：
  - `ShellChunk { stream, seq, data: Buffer }` / `ShellChunkConsumer`（可等待异步边界）/ `ShellExit` 判别联合：`{kind:"exit",exitCode}`、`{kind:"signal",signal}`（外部 signal，不虚构 128+signal）、`{kind:"killed",reason:"timeout"|"turn"|"runtime",termSignal:"SIGTERM"|"SIGKILL"}`、`{kind:"consumer-failed"}`。
  - `runCommand({ command, cwd, env, shellPath, timeoutMs?, turnSignal?, runtimeCloseSignal?, onChunk? })`：`spawn(--noprofile --norc -c, detached, cwd, ignore/pipe/pipe)`；背压式 pipe 消费（consumer 未完成暂停流，全局单调 `seq`）；spawn 失败抛 `ShellError("shell_unavailable")`。
  - 终止状态机：**用 `exit` 事件触发裁决**（`close` 会被后台后代持有的 pipe 阻塞）；统一 `terminateProcessGroup` = SIGTERM → 250ms → SIGKILL；`exitSettled`/`termination`/`naturalExitLocked` 三重防护保证第一个终止原因获胜、自然退出后的迟到 timeout/abort 不改写；自然退出后 best-effort 清理同进程组后台后代，等 stdio 与 consumer 收敛才 resolve。
- **index.ts**：`export * from "./tools/shell/shell-environment.js"` / `shell-executor.js`。
- 测试：`shell-environment.test.ts` 21 个（环境三层覆盖、denylist、路径解析与各类不可用失败）+ `shell-executor.test.ts` 20 个（自然退出/分流/seq/背压、外部 signal、timeout SIGTERM 与 SIGKILL 升级、turn/runtime 取消、后台后代清理）。全量 **38 文件 / 423 测试** + typecheck/lint/format 通过。
- 过程中确认的签名决策（Phase 1 提问全选推荐项）：纯函数集 vs 类 → 纯函数；`runCommand` 单函数 vs 类实例 → 单函数；consumer 收原始 `Buffer`+序号（解码留给 Batch 5）；`ShellExit` 判别联合；两个 signal 分开传 + 内部推导 `cancelledBy`；resolve 失败抛 `ShellError`；`shellPath` 必填（调用方先 resolve）；consumer 抛错 → `{kind:"consumer-failed"}`；`ShellErrorCode` 仅 `shell_unavailable`。
- 修复：后台后代持 pipe 导致 `close` 永不触发 → 改用 `exit` 事件 + 先清理进程组；自然退出后迟到终止的竞态 → `naturalExitLocked`；macOS `/var`→`/private/var` 链接使 `pwd` 断言失败 → 测试期望改 `realpath(cwd)`；`kill(-pgid, 0)` 类型 → `NodeJS.Signals | number`。

## 下一步

Batch 5：Shell 输出累加与完整日志生命周期（`shell-output.ts` 流式 UTF-8 解码 + ANSI/控制字符清理 + 2,000 行尾部累加 + JSON 预算 + `shell-log-store.ts` session 临时目录/100 MiB 日志/幂等清理）。实现前先读 plan 该 batch 细节并确认跨包决策。

## Batch 5 已交付（`38221ee`）

范围：`shell-output.ts` / `shell-log-store.ts` / index.ts 公共导出，为 bash 提供有界输出捕获与完整日志生命周期。

- **`shell-output.ts`（新）**：
  - `ShellOutputAccumulator({ maxLines? })`：stdout/stderr 各自独立流式 `TextDecoder` + 跨 chunk ANSI 状态机（CSI/OSC/DCS）；保留 LF/tab，移除 CR、DEL、其余 C0/C1 与 escape sequence；`push(chunk)` 返回本次清理文本；tail 只保留最近 maxLines 行（内存有界），`totalLines()` 精确统计（空输出 0 行、末尾 LF 不新增空行、无末尾 LF 最后一段计一行）；`extractFullText()` 首次接管返回全部已清理文本并清空；`maxLines` 注入超 2,000 协议上限抛 TypeError。
  - `computeShellTail({ text, totalLines?, fields, maxLines?, maxSerializedCharacters? })`：先 2,000 行尾部限制，再按实际 `JSON.stringify()` 预算二分缩短 output 尾部（`truncatedBy: "lines"|"output_limit"` + total/returned 元数据），Unicode scalar 边界（无孤立 surrogate）。
- **`shell-log-store.ts`（新）**：`ShellLogStore({ sessionTempDirectory, maxLogBytes? })` 懒创建 mode 0700 session 临时目录 + 随机 mode 0600 日志；`backfill`/`append` 经单一异步写链串行并背压，返回 `{ fullOutputPath, limitReached }`（恰好达到上限允许、下一段超限写 UTF-8 scalar 前缀并置位）；create/chmod/写失败抛 `ShellLogError`；`close()` 幂等清理整个 session 目录；`maxLogBytes` 注入超 100 MiB 协议上限抛 TypeError。
- 测试：`shell-output.test.ts` 20 个（跨 chunk UTF-8/双流独立解码/交错合并/跨 chunk CSI/OSC/控制字符/行数边界/tail 有界/extract 接管/行与预算截断/surrogate）；`shell-log-store.test.ts` 12 个（权限/随机名/写链顺序/limitReached 边界/scalar 前缀/失败路径/close 幂等/懒创建）。
- 过程中确认的决策（全选推荐项）：类 + 纯函数分离；`extractFullText` 接管式保证内存有界；写操作返回 `limitReached` + 抛 `ShellLogError`；`close` 清理整个 session 目录；push 调用序即 seq 序。
- 修复：`keepLastLines` 尾空串占位多丢一行；单字节 C1 CSI（`0x9B`）参数序列未清理；预算测试的 truncation 元数据固定部分约 160 字符需留余量。

## Batch 6 已交付（`d536827`）

范围：`contracts` shell 错误码与 context 扩展 / `builtins/bash.ts` / index.ts / CLI config 与 Runtime 组装，完成 bash 的模型可调用闭环。

- **contracts**：`ToolErrorCode` 增加 `shell_unavailable`/`command_timed_out`；`ToolExecutionContext` 增加可选 `shell?: ToolShellContext`（shellPath/shellEnv），Registry 注入。
- **`builtins/bash.ts`（新）**：`createBashTool({ sessionTempDirectory, runtimeCloseSignal? })` 薄适配层：
  - schema `{ command, timeout? }`（command ≤ 32,768 Unicode 字符、非空白、原字符串保留；timeout 有限正数 ≤ 2,147,483.647 秒；`additionalProperties: false`）。
  - spawn 前用 command + 最小成功 payload 预检序列化预算，超限返回 `resource_limit` 不启动进程。
  - 每次执行前 `resolveShellPath(explicit)` 校验 shell 可用，失败返回 `shell_unavailable`。
  - 流式日志：`onChunk` 轻量检测（totalLines>2000 或 tailText 超预算）触发 `backfill(extractFullText())`，之后每 chunk `append`；`limitReached`/`ShellLogError` → consumer 抛错 → `runCommand` 返回 consumer-failed → `resource_limit`。
  - 结果：自然退出任意 exitCode 成功 payload；外部 signal → `execution_failed` + details.signal + 终止前输出；timeout/turn/runtime → `command_timed_out`/`command_cancelled` + `cancelledBy`；均保留 output/truncation/fullOutputPath 且遵守预算。
- **CLI config**：`CliConfig` 加可选 `bashPath`/`bashEnvAllowlist`；`BYTE_MENTOR_BASH_PATH` 只要设置就必须非空绝对路径否则 `CliConfigError`；`BYTE_MENTOR_BASH_ENV_ALLOWLIST` 逗号分隔 trim/删空/首次去重/`[A-Za-z_][A-Za-z0-9_]*` 校验。
- **run-chat**：`createRuntime` 用 `config.bashPath ?? resolveShellPath` 选 shell、`createShellEnvironment` 构造受控环境、注入 context.shell、注册 `createBashTool`；`close` 按「abort runtime signal → 关 session store → rm 日志目录」收尾。
- 测试：`bash.test.ts` 22 个（参数校验/成功执行/终止语义/预算与日志）；`agent-runner.test.ts` 追加非 safe bash 混合批次串行（真实 bash 输出进 ToolMessage）；`config.test.ts` 追加 bashPath/allowlist 解析与非法配置；`run-chat.test.ts` 工具断言 5→6、bash 非零退出 + close 清理日志、端到端验收。
- 修复：`ShellTruncation` interface → type alias（兼容 JsonObject index signature，连锁解决 agent dist 未构建导致 cli 找不到导出）；runner 混合批次 provider 需第二轮 completed 防无限循环。

## 整体验收（`6531c86`）

- 自动化（`run-chat.test.ts` 新增用例）：fake-provider 驱动 `read_file → edit_file（两个不相交替换，diff/patch）→ bash cat+exit 7（非零退出码成功 payload）→ bash seq 1 3000（截断 + fullOutputPath）` 完整闭环，验证单文件原子性与完整日志生命周期。
- 计划 316-325 的第 5-6 项（Ctrl+C 取消、跨 session 恢复）依赖交互式 CLI 与真实模型，已由 Batch 3 的 turn 取消测试与 checkpoint 持久化测试覆盖；受控人工 smoke 留待真实环境执行。
- 当前全量：**41 测试文件 / 484 测试** + typecheck/lint/format 全绿。

## 下一步

受控人工 smoke（真实模型 + 交互式 CLI）：验证长命令 Ctrl+C 取消的进程树/checkpoint/日志收敛，以及重进 session 后取消前消息可恢复。之后可将此计划标记为完结。
