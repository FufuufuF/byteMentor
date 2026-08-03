# 写工具实现计划

## 1. 计划状态

- 状态：Batch 0 设计契约已确认，Batch 1–6 待实现
- 架构依据：`.agents/.design/write-tools-design.md`
- 实现范围：`edit_file`、`bash`、turn 级取消链路及 CLI 组装

本计划面向人工 Review 和后续编码 Agent，按可独立验证的 commit 批次组织。具体 Tool 参数、结果字段、安全边界、错误语义和非目标以设计文档为准；实现过程中如需改变这些结论，应先回到 Design Review，不在代码中临时扩展协议。

## 2. Batch 与验证约定

- Batch 0 是不含生产代码的设计冻结；Batch 1–6 各对应一个预期 commit，每个实现 commit 同时包含生产代码与使该能力可验证的测试。
- 每个可观察行为都必须独立完成一次严格的 RED → GREEN → REFACTOR，不得先写完整批测试再统一实现，也不得实现后补测：
  1. RED：先写一个最小行为测试和测试职责注释，运行目标测试，并确认它因缺少该行为产生预期的 assertion failure，而不是语法、类型、fixture 或配置错误。
  2. GREEN：只写使该测试通过的最小生产代码；为本步新增或修改的每个函数、方法和函数值紧邻添加简洁的职责注释，设置职责不能从字段声明直接看出的 constructor 也必须注释，再运行目标测试确认 GREEN。
  3. REFACTOR：只在 GREEN 后消除重复或改善命名；不得增加未测试行为，重构后重新运行目标测试并保持 GREEN。
  4. 对下一个行为重复上述过程，并在 Batch Review 记录每个 RED 的命令和预期失败原因。
- 每个 `test(...)` 或 `it(...)` 紧邻上方必须有简洁注释，说明场景、被验证的行为和可观察结果；不可只复述测试名称。非平凡 inline callback 在职责无法直接看出时也必须注释。
- 每个新增函数或方法都必须由至少一个行为测试经由生产入口实际执行；优先验证公开结果和副作用，不为测试暴露新的生产 API。
- 每个 Batch 完成所有行为循环后，再运行全量 `pnpm test`、`pnpm typecheck`、`pnpm lint` 和 `pnpm format:check`，保持输出无错误和警告后再提交。
- Batch 完成后停下等待 Review，不自动进入下一批。
- 测试使用临时目录、fake provider 和本地短生命周期子进程，不调用真实模型 API，不依赖用户真实项目文件。
- 测试优先执行真实代码，只在模型 API、时钟、文件系统故障注入等不可控边界使用最小 test double；不得断言 mock 自身行为、提供不完整的假响应或向生产类加入仅测试使用的方法。新增 mock 或测试工具前先阅读 TDD skill 的 `testing-anti-patterns.md`。
- 不为了缩小 diff 而拆散必须一起编译或共同保证行为的契约与消费者。
- 不实现用户审批、PTY、交互式 stdin、后台 Shell session、多 session 锁或进程间锁。

## 3. 实现顺序

### Batch 0：设计契约冻结（已完成）

交付物：

- `.agents/.design/write-tools-design.md`
- `.agents/.plan/write-tools-implementation-plan.md`

已确认：

- 冻结 `edit_file` 的单文件原子边界、原始快照匹配、有限模糊匹配、工作区路径策略、稳定错误码和结果预算行为。
- 冻结 turn 级取消的 signal 传递、`cancelled` 终态、checkpoint、合成 AssistantMessage、Tool Call 收敛和原子 rename 提交点。
- 冻结 `bash` 的本地可信执行模型、受控环境、一次性 Bash、进程组清理、输出尾部、完整日志和稳定错误语义。
- 冻结协议硬上限及“Runtime 只能降低、不能提高”的规则；后续 Batch 不得自行放宽或增加兼容协议。
- 明确不包含 legacy edit 参数、per-file mutation queue、用户审批、PTY、交互式 stdin、后台 Shell session、多 session 锁、进程间锁和 OS sandbox。

退出条件：

- Design 与 Plan 对参数、限制、终态、错误码、文件边界和 Batch 顺序使用同一套术语。
- 实现中如发现必须改变已冻结契约，先暂停当前 Batch 并回到 Design Review，不用实现细节隐式改写协议。

### Batch 1：共享工作区路径边界与原子编辑能力

建议 commit：`refactor(agent): establish workspace edit boundary`

范围：

- `packages/agent/src/tools/workspace/workspace-path-resolver.ts`
- `packages/agent/src/tools/workspace/workspace-reader.ts`
- `packages/agent/src/tools/workspace/workspace-editor.ts`
- `packages/agent/src/tools/workspace/workspace-policy.ts`
- `packages/agent/src/index.ts`
- `test/agent/workspace-reader.test.ts`
- `test/agent/workspace-editor.test.ts`

目标：

- 从 `WorkspaceReader` 抽取 Reader 与 Editor 共用的词法路径、canonical realpath、符号链接和 denied policy 校验。
- 保持现有只读 Tool 行为不变，避免为写入能力复制第二套路径安全逻辑。
- 建立 `WorkspaceEditor` 的严格 UTF-8 文本读取与同目录临时文件加 rename 的原子替换能力；临时文件使用随机名称、exclusive create 和初始 mode `0600`，rename 成功是不可回退的提交点。
- 将可编辑文件的 2 MiB 原始字节数设为协议硬上限，Runtime 配置只能降低；目标 `stat` 后和实际读取后各检查一次。
- 编辑允许的工作区内符号链接目标时保留链接本身，并保留目标文件 mode。
- 失败路径清理临时文件，目标文件保持原内容。

测试：

- 现有 WorkspaceReader 路径、策略和符号链接测试保持 GREEN。
- Editor 覆盖普通文件、目录、特殊文件、绝对路径、越界路径、denied path、断裂链接和工作区外链接。
- 覆盖 UTF-8、BOM、NUL、非法 UTF-8、不可写目标、原子 rename 失败，以及文件大小低于、等于和超过 2 MiB 的边界。
- 验证 `stat` 后增长到上限以上的文件仍返回 `resource_limit`，且 Runtime 较低限制生效、较高配置不能突破协议硬上限。
- 验证编辑工作区内链接不会用普通文件替换链接目录项。
- 验证成功保留 mode，失败不留下 Runtime 临时文件。
- 验证临时文件名称碰撞不会覆盖既有文件，失败清理只作用于本次成功创建的临时文件；不把 owner、ACL 或扩展属性纳入首版保证。

Review 重点：

- Reader 与 Editor 是否真正共享同一个路径解析边界。
- 原子 rename 是否作用于校验后的真实目标，而不是覆盖符号链接。
- 文件系统操作是否全部使用 Node.js 异步 API，错误是否仍转换为稳定的 WorkspaceError。

### Batch 2：`edit_file` 纵向切片

建议 commit：`feat(agent): add workspace file edit tool`

范围：

- `packages/agent/package.json`
- `pnpm-lock.yaml`
- `packages/agent/src/tools/contracts.ts`
- `packages/agent/src/tools/builtins/edit-diff.ts`
- `packages/agent/src/tools/builtins/edit-file.ts`
- `packages/agent/src/index.ts`
- `apps/cli/src/run-chat.ts`
- `test/agent/edit-diff.test.ts`
- `test/agent/edit-file.test.ts`
- 受 `ToolExecutionContext` 扩展影响的 Registry、Runner 和 CLI 测试

目标：

- 以精确版本 `diff: "8.0.4"` 增加生成展示 diff 和 unified patch 所需的直接运行时依赖，并同步 lockfile。
- 将 pi 的成熟匹配逻辑适配为无文件系统副作用的纯函数：原始快照批量匹配、唯一性检查、重叠检查、有限模糊归一化、BOM 与换行恢复。
- 扩展稳定 edit 错误码和 `ToolExecutionContext`，由 `edit_file` 通过注入的 `WorkspaceEditor` 完成单文件修改。
- 实施协议硬上限：`path` 为 1–4,096 个 Unicode 字符，`edits` 为 1–64 项，每个 `oldText`/`newText` 至多 65,536 个 Unicode 字符，全部 `oldText` 与 `newText` 聚合至多 262,144 个 Unicode 字符；Runtime 只能降低这些限制。
- schema 设为 `additionalProperties: false`；聚合字符限制在读取文件前校验，拒绝 legacy 顶层参数和字符串形式的 `edits`。
- 在实际写入前完成全部 edit 校验、diff/patch 构造和 ToolResult 序列化预算检查；任何失败均不得留下部分修改。
- 注册 `edit_file` 到真实 CLI Runtime，保持其未声明 `concurrency: "safe"`。

测试：

- 单项替换、同文件多个不相交替换，以及所有 edit 基于同一原始快照。
- 参数各上下界、未知字段、空 `oldText`、聚合字符超限和旧式参数返回 `invalid_arguments`，并验证聚合超限时未读取文件。
- 未找到、重复、重叠、嵌套和 no-op 返回对应稳定 edit 错误及 `path`、`editIndex`、`occurrences` details。
- 精确匹配优先，有限模糊匹配覆盖 NFKC、引号、dash、特殊空格和尾部空白。
- 唯一性在最终选定的统一匹配空间计算，重复计数包含重叠候选；任一 edit 需要模糊匹配时，全部 edit 都在同一模糊快照重新定位。
- LF、CRLF、CR、BOM 和未修改行内容保持设计语义。
- 成功 payload 的 replacements、diff、patch 和 firstChangedLine 正确。
- 超过结果预算时在写入前返回 `resource_limit`，文件保持不变。
- CLI Registry 暴露 `edit_file`，包含 edit 的 Tool Call 批次保持模型顺序。

Review 重点：

- 匹配与 diff 是否保持纯函数，文件访问是否只通过 WorkspaceEditor。
- 模糊匹配是否仅改写实际受影响的行块。
- 任一失败是否都发生在原子替换前，避免“文件已改但 Tool 返回失败”。
- 是否没有引入 pi 的旧参数兼容、绝对路径解析、直接文件系统写入、TUI preview 或 per-file mutation queue。

### Batch 3：turn 级取消链路

建议 commit：`feat(agent): propagate turn cancellation`

范围：

- `packages/core/src/messages.ts`
- `packages/core/src/runtime-event.ts`
- `packages/agent/src/providers/provider.ts`
- `packages/agent/src/providers/openai-chat-provider.ts`
- `packages/agent/src/tools/contracts.ts`
- `packages/agent/src/tools/tool-registry.ts`
- `packages/agent/src/tools/workspace/workspace-editor.ts`
- `packages/agent/src/tools/builtins/edit-file.ts`
- `packages/agent/src/runner/agent-runner.ts`
- `packages/agent/src/loop/agent-loop.ts`
- `packages/agent/src/loop/runtime-checkpoint.ts`
- `apps/cli/src/interactive-chat-controller.ts`
- `apps/cli/src/run-chat.ts`
- `test/core/messages.test.ts`
- `test/core/runtime-event.test.ts`
- 相关 Provider、Registry、WorkspaceEditor、`edit_file`、Runner、Loop、headless turn 与 CLI 测试

目标：

- 扩展 `StopReason: "cancelled"`、`HeadlessTurnResult.status: "cancelled"`、`turn.cancelled`、`tool.cancelled`、通用 `tool_cancelled` 错误码和 `RuntimeCheckpoint.phase: "cancelled"`；取消分支不携带通用 `error`，两个新增事件严格采用 Design 第 11.1 节定义的字段。
- 为每个 turn 建立独立 `AbortController`，将只读 `AbortSignal` 从 CLI 贯穿 Loop、Runner，并通过动态 `ProviderInvocationOptions` 与 `ToolExecutionOptions` 传给 Provider、Registry 和当前 Tool；不得把 turn signal 放入静态 `ProviderRequest` 或 `ToolExecutionContext`。
- 忙碌时用户请求退出，先标记退出意图，再 abort 当前 turn、等待其收敛后关闭 Runtime；空闲时仍直接退出。Controller 在 turn 完成后释放 controller 引用和监听器。
- OpenAI Provider 使用 SDK 请求 options 的 `signal` 中止流，使模型生成阶段也可取消；最终 `done` 已提交后到达的 abort 不得追溯改写成功结果。
- Runner 在发起模型请求和每个 Tool Call 前检查 signal。Provider 已产出 Tool Calls 时先保存 `awaiting_tools` checkpoint；已启动调用等待真实 I/O 与清理收敛并保留真实结果，未启动调用按原顺序生成 `tool_cancelled` ToolMessage 和 `tool.cancelled` 事件，其中 `started: false`。
- 已启动调用只有在真实错误码为 `tool_cancelled` 或 `command_cancelled` 时产生 `tool.cancelled { started: true }`；越过提交点后成功或因其他原因失败时仍产生 `tool.completed` 或 `tool.failed`。
- 并发 safe 批次取消后停止领取新任务，等待已领取调用结束，再按原 Tool Call 顺序组装全部 ToolMessage；全部调用有结果后不再请求模型。
- 取消终态写入 `pendingToolCalls: []` 的 `cancelled` checkpoint，并追加固定内容 `[Assistant reply cancelled.]` 的合成 AssistantMessage；该消息同时出现在 checkpoint、最终 `newMessages` 和持久化 session 中。
- `edit_file` 在 I/O 前、等待中的文件操作收敛后和 rename 前响应取消；rename 前取消清理临时文件并返回 `tool_cancelled`，rename 成功后不得因迟到 abort 把已提交修改报告为取消。
- 取消不跳过 checkpoint/session 持久化、临时资源清理或等待已经发起的异步操作收敛。
- 为 Runtime 关闭保留同一取消入口，避免退出逻辑另建一套中断机制。

测试：

- signal 在 OpenAI SDK 调用边界正确透传；模型流期间取消会中止 Provider 且不进入 Tool 阶段，最终 `done` 与迟到 abort 的竞争保留 completed。
- 串行批次不启动后续调用，并发 safe 批次不领取新调用；已启动调用按真实结果产生 `tool.cancelled { started: true }`、`tool.completed` 或 `tool.failed`，所有未启动调用都有 `tool_cancelled` ToolMessage 和 `tool.cancelled { started: false }`。
- 取消结果使用 `status/stopReason: "cancelled"`，包含固定合成 AssistantMessage；`turn.cancelled.messageId` 指向该消息。`cancelled` checkpoint 的 `pendingToolCalls` 为空，恢复后不会留下半条消息轨迹。
- rename 前取消时文件不变且临时文件已清理；rename 成功后的迟到 abort 保留 edit 成功结果。
- CLI 忙碌时 Ctrl+C 触发 abort、等待清理并退出；空闲退出行为不退化。
- Controller 将 `tool.cancelled` 收敛为终态 Tool 卡片；turn 取消会结束已有的流式 Assistant 卡片，但不调用 `showError`。
- 已经发起且不能同步取消的操作在返回前完成必要收尾，不出现取消后继续后台修改状态的 Promise。
- checkpoint、session 保存或必要清理失败时返回 `failed`，数据完整性错误优先于取消；正常取消不调用 CLI `showError`。

Review 重点：

- AbortSignal 是否只是单向通知，具体消费者是否负责安全停止和等待收敛。
- signal 是否没有被当作取消持久化与清理工作的理由。
- 一次 turn 的 controller 和监听器是否在完成后释放，避免跨 turn 泄漏。
- 取消后的消息、checkpoint、ToolMessage 和 RuntimeEvent 是否完整、顺序稳定且可恢复。
- 所有副作用是否以明确提交点裁决迟到 abort，而不是仅依据 `signal.aborted` 覆盖真实结果。

### Batch 4：受控 Shell 环境与一次性进程执行器

建议 commit：`feat(agent): add managed shell executor`

范围：

- `packages/agent/src/tools/shell/shell-environment.ts`
- `packages/agent/src/tools/shell/shell-executor.ts`
- `packages/agent/src/index.ts` 中确有调用方需要的公共导出
- `test/agent/shell-environment.test.ts`
- `test/agent/shell-executor.test.ts`
- 测试用短生命周期子进程 fixture

目标：

- 按“基础变量 → 用户白名单 → Runtime 固定值”构造 Bash 环境，不全量继承 `process.env`，也不允许模型扩大白名单；固定 denylist 在所有阶段优先。
- 基础集合仅包含 `PATH`、`HOME`、`USER`、`LOGNAME`、`TMPDIR`、`LANG` 和 `LC_*`；Runtime 固定 `SHELL=<shellPath>`、`TERM=dumb`、`NO_COLOR=1`，不复制 `PWD` 或设置 `CI`。
- 固定拒绝 `OPENAI_API_KEY`、所有 `BYTE_MENTOR_*`、`PWD`、`OLDPWD`、`BASH_ENV`、`ENV`、`CDPATH` 和 `PROMPT_COMMAND`；allowlist 只复制启动时父进程中存在的合法名称。
- 默认先使用 `/bin/bash`，不存在时只通过受控 `PATH` 查找 `bash`，不降级到 `sh`；执行前确认选定路径存在、可执行且为普通文件，否则返回 `shell_unavailable`。
- 使用 `spawn(shellPath, ["--noprofile", "--norc", "-c", command])` 启动 detached、non-login、non-interactive 的一次性 Bash，stdin 为 ignore，cwd 固定为 workspaceRoot；detached 仅用于建立可统一终止的独立 Unix 进程组。
- 提供 stdout/stderr 分流的可等待异步 chunk consumer、自然 exit code 或外部 signal、可选 timeout、turn signal 和 Runtime close signal，不在执行器内组装模型 ToolResult；consumer 未完成时暂停 pipe，避免无界 Promise 队列。
- 为每次调用建立独立进程组；用户取消、timeout、Runtime 关闭或输出资源失败时先发送 SIGTERM，等待最多 250 ms，再对仍存活的进程组发送 SIGKILL，并等待直接子进程、pipe 和 consumer 收敛。
- Shell 自然退出后 best-effort 清理同进程组普通后台后代，不支持 daemonize 或跨 Tool 生命周期后台任务。

测试：

- 基础环境、三层覆盖顺序、固定 denylist 优先、合法白名单、缺失白名单值，以及 `PWD`/`CI` 的特殊行为。
- workspace cwd、profile/rc/项目 `.env` 不加载、`/bin/bash`/受控 `PATH` 选择、Shell 不存在、不可执行、非普通文件和其他 spawn 失败。
- stdout、stderr、可等待 consumer 背压、零/非零退出码、外部 signal 和无输出命令。
- timeout、turn abort、Runtime close、输出 consumer 失败、自然退出竞争，以及监听器和 timer 清理；第一个终止原因获胜。
- 验证 SIGTERM 后自然收敛与 250 ms 后升级 SIGKILL 两条路径。
- 普通子进程树和后台后代在执行器返回前终止，不遗留测试进程。

Review 重点：

- spawn 的输入是否直接使用已经确认的 command，没有隐式重写。
- timeout、用户取消、Runtime 关闭和输出资源失败是否能区分原因并共享同一安全清理状态机。
- Promise 是否只在子进程、pipe、consumer 和 decoder 所需收尾真正收敛后返回。
- 代码是否明确承认当前用户权限执行，而没有伪装成 workspace 沙箱。

### Batch 5：Shell 输出累加与完整日志生命周期

建议 commit：`feat(agent): capture bounded shell output`

范围：

- `packages/agent/src/tools/shell/shell-output.ts`
- `packages/agent/src/tools/shell/shell-log-store.ts`
- `test/agent/shell-output.test.ts`
- `test/agent/shell-log-store.test.ts`

目标：

- stdout/stderr 各自使用流式 UTF-8 decoder 和流式 ANSI 清理状态，按父进程分配的单调 chunk 序号合并；保留 LF/tab，移除 CR、DEL、其他 C0/C1 控制字符和跨 chunk ANSI sequence。
- 合并后的文本进入有界尾部累加器，执行 2,000 行协议硬上限并统计完整行数；空输出为 0 行，末尾 LF 不新增空行，未以 LF 结尾的最后一段计一行。
- 根据包含 command、exitCode、truncation 和 `fullOutputPath` 的实际 `JSON.stringify()` 结果缩减 output 尾部，保证完整 ToolResult 不超过 Registry 预算；按 Unicode scalar 边界截取，不产生孤立 surrogate。
- 先应用行限制，再应用 JSON 预算；后者继续缩短时使用 `truncatedBy: "output_limit"`，否则使用 `"lines"`，并准确返回 total/returned 行数。
- 首次超过任一返回限制时，`ShellLogStore` 懒创建 mode `0700` 的 session 临时目录和随机 mode `0600` 日志，补写从命令开始累计的全部已清理文本，后续通过单一异步写链追加并施加背压。
- 单条命令的清理后完整日志硬上限为 100 MiB UTF-8 字节，Runtime 只能降低；恰好达到上限允许完成，下一段会超限时写入 scalar 边界内可容纳的最长前缀，再通知执行器终止进程、排空 pipe、等待写链收敛并形成 `resource_limit`。日志 create/chmod/backfill/append 失败执行同一终止路径。
- 只有最终结果发生截断时保留并暴露绝对 `fullOutputPath`；session 结束时幂等、best-effort 清理 Runtime 创建的日志和目录，异常退出残留交给系统临时目录策略。

测试：

- chunk 任意切分、两个流分别跨 chunk UTF-8、交错顺序、跨 chunk CSI/OSC ANSI sequence 和控制字符清理。
- 未截断输出、空输出、末尾换行、无末尾换行、2,000 行上下界、JSON 输出预算和超长单行 Unicode 尾部。
- 行截断与预算截断分别产生准确的 `truncatedBy`、total/returned 元数据，所有成功和失败 JSON 都不超过 Registry 上限。
- 日志目录/文件权限分别为 `0700`/`0600`，名称不可预测，完整内容覆盖触发截断前后的全部已清理文本。
- 通过可注入且只能降低的测试限额，覆盖与 100 MiB 协议上限相同的 UTF-8 单/多字节低于、恰好达到和超过边界语义；超限日志只包含 scalar 边界内可容纳的前缀。create/chmod/backfill/append 失败均触发 `resource_limit`，关闭与 session 清理幂等。
- 未截断结果不保留或暴露日志；截断结果的绝对路径在 Runtime close 前可读、close 后被清理。

Review 重点：

- 内存是否始终有界，同时完整日志没有遗漏截断前内容。
- UTF-8 和 JSON 字符预算是否分别在正确边界计算。
- 两条 pipe 是否拥有独立 decoder/ANSI 状态，异步日志写入是否向上游施加真实背压。
- 完整日志路径和清理责任是否由 `ShellLogStore`/Runtime 持有，而不是泄漏给通用 WorkspaceReader。

### Batch 6：`bash` Tool 与 CLI 执行闭环

建议 commit：`feat(agent): add bash execution tool`

范围：

- `packages/agent/src/tools/contracts.ts`
- `packages/agent/src/tools/builtins/bash.ts`
- `packages/agent/src/index.ts`
- `apps/cli/src/config.ts`
- `apps/cli/src/run-chat.ts`
- `test/agent/bash.test.ts`
- `test/agent/agent-runner.test.ts`
- `test/cli/config.test.ts`
- `test/cli/run-chat.test.ts`

目标：

- 增加 `bash` schema、稳定 Shell 错误码和结构化成功 payload，将 ShellExecutor 与输出组件组合成模型可调用 Tool。
- `command` 必须含非空白字符且最多 32,768 个 Unicode 字符；`timeout` 单位为秒，必须有限且大于 0，最大为 2,147,483.647。两者都是协议硬上限，Runtime 只能降低；缺省 timeout 表示不设默认超时。
- schema 设为 `additionalProperties: false`，不暴露 `cwd` 或 `env`；空白判断不得改变实际传给 Bash 的 command 原字符串，非法参数不得 spawn。
- spawn 前使用 command 和最小成功 payload 预检完整 ToolResult；固定字段已超过 Registry 预算时返回 `resource_limit` 且不得执行命令，command 本身不得为适配结果预算而截断。
- 自然退出的任意 exit code 都返回成功 payload；外部 signal 返回带 signal details 的 `execution_failed`，不虚构 `128 + signal`。Shell 不可用、timeout、已启动 Bash 的取消和基础设施失败分别使用 `shell_unavailable`、`command_timed_out`、`command_cancelled` 和 `execution_failed`。
- 成功 payload 固定返回 command、exitCode、output、truncated；仅截断时返回 truncation 和绝对 `fullOutputPath`，无输出使用空字符串。
- 截断时返回尾部、明确元数据和完整日志路径；未截断时不创建或暴露日志文件。
- CLI 从 `BYTE_MENTOR_BASH_PATH` 读取可选绝对 Bash 路径；变量只要已设置就必须非空且为绝对路径，否则在 Runtime 启动前抛出 `CliConfigError`，存在性、文件类型和可执行权限留到每次 Tool 执行前检查。CLI 从逗号分隔的 `BYTE_MENTOR_BASH_ENV_ALLOWLIST` 读取额外环境变量名，执行 trim、删空、首次出现去重和 `[A-Za-z_][A-Za-z0-9_]*` 校验，非法名称同样在启动前抛出 `CliConfigError`。
- 从 CLI 配置与启动时父进程环境建立受控 Bash 环境，注册 `bash`，并在 Runtime close 中按“请求取消 → 等待当前 turn/进程/pipe/日志写链收敛 → 清理日志 → 关闭 session store”完成收尾。
- `bash` 不声明 `concurrency: "safe"`，复用现有 Runner 串行策略，不增加锁。

测试：

- command 在 32,768 字符上下界、空/纯空白、原字符串保留、timeout 在 0、有限正数和 2,147,483.647 秒边界，以及未知字段校验；所有非法参数都不启动进程。
- 覆盖普通字符和 JSON escape 密集 command 的结果预算预检；固定字段超限返回 `resource_limit` 且进程未启动。
- 零退出码、多个非零退出码、无输出和 stdout/stderr 合并结果；非零 exit code 不产生 `tool.failed`。
- timeout、turn 取消与 Runtime close 保留终止前输出和截断信息；已启动 Bash 返回 `command_cancelled`，未启动调用仍由 Runner 返回 `tool_cancelled`。
- 无 timeout 默认值、外部 signal 返回 `execution_failed` 和 signal details、Shell 不可用返回 `shell_unavailable`。
- 截断时完整日志可用且结果不超过 Registry 上限，Runtime close 后日志被清理。
- `read_file -> edit_file -> bash -> read_file` 等混合批次严格按模型顺序观察副作用。
- CLI 配置覆盖 `BYTE_MENTOR_BASH_PATH` 的未设置、合法绝对路径、空值和相对路径，以及 `BYTE_MENTOR_BASH_ENV_ALLOWLIST` 的空项、trim、去重、非法名称、缺失父进程值和固定 denylist 优先。
- CLI 对模型暴露 edit/bash 定义，并使用显式 workspaceRoot、受控环境和同一个 Runtime 生命周期；profile、rc、项目 `.env` 均不会隐式进入子进程。

Review 重点：

- 非零 exitCode 是否没有被误归类为 `tool.failed`。
- Bash Tool 是否保持薄适配层，进程和输出细节没有回流到 Registry 或 Runner。
- edit/bash 是否只依赖已有默认串行调度，没有隐藏的第二套并发控制。
- Runtime close 是否按“abort、等待进程与日志收敛、清理日志、关闭 session store”的顺序完成。

## 4. 整体验收

全部 Batch 完成后进行一次本地 fake-provider 闭环和一次受控人工 smoke：

1. 使用 `read_file` 定位一个临时工作区文件。
2. 使用 `edit_file` 执行两个不相交替换并检查 diff/patch。
3. 使用 `bash` 执行验证命令并确认非零退出码仍是成功 ToolResult。
4. 产生超过返回预算的输出，确认尾部返回和完整日志。
5. 启动一个可安全终止的长命令，使用 Ctrl+C 取消并确认进程树、checkpoint 和临时日志收敛。
6. 重新进入同一 session，确认取消前已持久化的消息可以继续使用。

完成标准：

- `edit_file` 与 `bash` 符合设计文档的参数、结果、安全和错误语义。
- 两个写工具在当前单 session 中按模型顺序串行执行，不引入额外锁。
- edit 任一失败不修改目标文件，成功写入具有单文件原子性。
- Bash 大输出不导致无界内存或超限 ToolResult，完整日志有明确生命周期。
- 非零命令退出码可由模型作为正常执行结果处理。
- 取消不会遗留模型请求、普通 Bash 子进程、未收敛 Tool Call 或损坏的 session 轨迹。
- 每个新增行为都有已实际观察的预期 RED；每个测试和每个新增或修改的生产函数、方法、函数值都有符合 TDD skill 的职责注释。
- 全量 test、typecheck、lint 和 format check 均通过。
