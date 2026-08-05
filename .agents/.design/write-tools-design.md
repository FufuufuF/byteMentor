# 写工具设计

## 1. 文档状态

本文档记录 Byte Mentor 内置写工具的设计结论。当前已确认的范围包括 `edit_file`、turn 级取消链路和 `bash`。

`edit_file` 的核心文本替换语义参考 pi 的 `edit` 工具，但会适配 Byte Mentor 已有的工作区隔离、结构化 `ToolResult` 和 Tool 调度模型。本文档只描述设计，不包含实现计划。

## 2. 当前范围与约束

### 2.1 当前 Runtime 边界

- 当前 CLI 一次只运行一个 session，并通过 `busy` 状态阻止同一 session 同时执行多个 turn。
- `AgentRunner` 只有在同一批 Tool Call 全部显式声明 `concurrency: "safe"` 时才进行有界并发；只要其中包含未声明 safe 的工具，整批调用就按模型给出的顺序串行执行。
- `edit_file` 和 `bash` 都不声明 `concurrency: "safe"`，因此包含它们的批次按模型顺序串行执行。
- 当前不为多个 session、多进程或外部程序同时修改工作区提供一致性保证。
- 当前不引入 workspace 锁、文件锁或进程间锁。

### 2.2 `edit_file` 的职责

`edit_file` 只负责对一个已经存在的 UTF-8 文本文件执行一个或多个精确、局部的文本替换。

它不负责：

- 创建新文件；创建文件应由后续独立写入工具或 `bash` 承担。
- 删除、移动或重命名文件。
- 编辑目录、二进制文件或非 UTF-8 文件。
- 应用 unified diff、搜索正则表达式或执行基于行号的补丁。
- 在一次调用中编辑多个文件。
- 合并外部进程在本次调用期间产生的并发修改。

保持职责单一可以让模型获得明确的失败反馈，并让一次 Tool Call 具有清晰的单文件原子边界。

## 3. Tool 契约

### 3.1 名称与参数

工具名称使用 Byte Mentor 现有 snake_case 约定：`edit_file`。

参数：

```ts
{
  path: string
  edits: Array<{
    oldText: string
    newText: string
  }>
}
```

参数约束：

- `path` 必须是相对于 `workspaceRoot` 的路径，长度为 1 到 4,096 个 Unicode 字符。
- `edits` 必须包含 1 到 64 个元素。
- `oldText` 和 `newText` 都必须是字符串；单个字段最多包含 65,536 个 Unicode 字符。
- `oldText` 不得为空，`newText` 允许为空。
- 同一次调用全部 `oldText` 与 `newText` 的字符数合计不得超过 262,144。该聚合约束无法直接用 JSON Schema 表达，由 Tool 在读取文件前校验。
- 参数 schema 设置 `additionalProperties: false`。
- 第一版不兼容 pi 的旧式顶层 `oldText + newText` 参数，也不接受 JSON 字符串形式的 `edits`。无历史调用需要兼容，保持协议单一。

上述数量和字符限制是协议硬上限，Runtime 配置只能降低、不能提高。参数超过限制时返回 `invalid_arguments`，不得开始文件读取或 diff 计算。

模型可见说明必须明确：

- 每个 `oldText` 应尽量短，但必须在原文件中唯一。
- 同一文件的多个不相交修改应合并到一次 `edit_file` 调用中。
- 所有 `oldText` 都针对调用开始时的原始文件匹配，而不是针对前一项替换后的中间结果匹配。
- 相互重叠或嵌套的修改必须由模型合并成一个 edit。

### 3.2 成功结果

成功时返回结构化 payload：

```ts
{
  path: string
  replacements: number
  diff: string
  patch: string
  firstChangedLine?: number
}
```

字段语义：

- `path`：规范化后的工作区相对路径。
- `replacements`：成功应用的替换块数量。
- `diff`：带行号和有限上下文的展示型 diff，供 RuntimeEvent 预览或未来 TUI 展示。
- `patch`：标准 unified patch，供模型准确理解最终修改。
- `firstChangedLine`：新文件中第一个变化位置的 1-based 行号。

完整结果继续使用现有 `ToolResult` envelope，并受 Registry 的 `maxSerializedToolResultCharacters` 限制。工具在构造结果时必须为 envelope 预留空间；如果 diff 和 patch 无法在预算内完整返回，则返回 `resource_limit`，不截断到无效或容易误解的半段 patch。首版不为 edit 结果增加分页。

## 4. 匹配与替换语义

### 4.1 基于同一原始快照匹配

执行时先完整读取文件，得到一次调用内唯一的原始文本快照。每个 `edits[i].oldText` 都在这个快照中定位。

只有所有 edit 均通过校验后才计算新内容和进入写入阶段。因此：

- 前一个 edit 的 `newText` 不会成为后一个 edit 的匹配输入。
- 任意一个 edit 失败时，其他 edit 也不会部分写入。
- 替换按匹配位置倒序应用，避免前方替换改变后方位置偏移。

### 4.2 唯一性与重叠检查

每个 `oldText` 在匹配空间中必须恰好出现一次：

- 出现零次：失败，并指出 `edits[index]` 未找到。
- 出现多次：失败，并指出出现次数，提示模型增加上下文。
- 两个匹配范围重叠或嵌套：整次调用失败，提示模型合并对应 edit。
- 所有替换计算后内容与原内容相同：失败，避免产生虚假的成功记录。

相邻但不重叠的范围允许出现在同一次调用中。

### 4.3 换行与 BOM

匹配前执行以下处理：

1. 识别并暂时移除 UTF-8 BOM，避免模型必须在 `oldText` 中提供不可见字符。
2. 识别原文件主要换行风格。
3. 将文件内容以及每组 `oldText`、`newText` 的 CRLF、LF 和 CR 统一到 LF 匹配空间。

写回时恢复原文件的 BOM 状态和主要换行风格。未修改区域不得因为一次 edit 被整体改写为另一种换行风格。

首版支持 CRLF、LF 和 CR 三种换行风格。混合换行文件以从文件开头最先检测到的有效换行作为恢复目标；没有换行时使用 LF。混合换行的逐行字节级保留不作为首版保证。

### 4.4 有限模糊匹配

精确匹配失败时，允许使用与 pi 一致的有限归一化匹配，以吸收模型输出中常见但无语义差异的字符变化：

- Unicode NFKC 归一化。
- 去除每行尾部空白。
- 智能单双引号归一化为 ASCII 引号。
- 常见 Unicode dash、hyphen 和 minus 归一化为 `-`。
- 常见特殊空格归一化为普通空格。

匹配顺序始终是精确匹配优先，只有精确匹配失败后才进入模糊匹配。唯一性检查必须在最终选定的匹配空间中重新执行：全部 edit 都能精确匹配时只按原始匹配空间判断唯一性；任一 edit 需要模糊匹配时，全部 edit 都改在同一个模糊匹配空间判断唯一性。

出现次数统计必须包含相互重叠的候选。例如 `aa` 在 `aaa` 中出现两次，不能用 `split()` 等只统计不重叠结果的实现。精确空间中唯一、但存在其他模糊等价文本的目标，在没有其他 edit 触发模糊模式时仍应按精确匹配成功。进入模糊模式后，如果某个 `oldText` 归一化为空或对应多个位置，则返回 `edit_target_not_unique`。

只要同一次调用中任意 edit 需要模糊匹配，所有 edit 都在同一个模糊归一化快照中重新定位，避免不同坐标空间产生错误偏移。最终写回只重建实际受影响的行块，未触及的行从原始文本复制，避免把全文件的智能引号、尾随空格等内容意外归一化。

模糊匹配不包含：

- 忽略大小写。
- 忽略缩进或行首空白。
- 近似拼写、编辑距离或语义匹配。
- 自动选择多个候选中的一个。

### 4.5 pi 逻辑适配边界

Byte Mentor 只移植 pi 中经过验证的纯文本匹配、受影响行块恢复和 diff/patch 生成思路，不直接复制完整 Tool 实现。适配时必须修正以下差异：

- 支持纯 CR 文件和“最先出现的有效换行”检测。
- 唯一性按最终选定的精确或模糊空间计算，并统计重叠候选。
- 不接受 legacy 顶层参数或字符串形式的 `edits`。
- 不引入 per-file mutation queue、绝对路径解析、直接文件系统写入或 TUI preview 逻辑。
- 不在原子 rename 成功后因为迟到的取消信号把已完成修改重新报告为失败。

## 5. 工作区写入边界

### 5.1 组件职责

新增 `WorkspaceEditor`，由 `ToolExecutionContext` 注入 `edit_file`。不把写入方法直接加入 `WorkspaceReader`，避免只读组件同时承担修改职责。

目标依赖关系：

```text
WorkspacePathResolver(workspaceRoot, accessPolicy)
  ├── WorkspaceReader
  └── WorkspaceEditor

ToolExecutionContext
  ├── workspaceReader
  └── workspaceEditor
```

现有 `WorkspaceReader` 中的词法路径解析、realpath 边界校验和 `WorkspaceError` 需要抽取为可复用的工作区路径能力。Reader 与 Editor 必须共享同一套规则，不能各自实现一份近似校验。

### 5.2 路径与文件限制

`WorkspaceEditor` 必须复用现有工作区策略：

- 拒绝绝对路径和 `..` 越界路径。
- 拒绝 `.git/**`、`.byte-mentor/**`、`.env` 和策略追加的 denied paths。
- 允许编辑指向工作区内部允许文件的符号链接。
- 拒绝指向工作区外部、denied target、目录、特殊文件或断裂目标的符号链接。
- 对模型和 ToolResult 只暴露工作区相对路径，不返回本机绝对路径。

如果输入路径是允许的符号链接，编辑其工作区内的真实目标，并保留符号链接本身。临时文件和 rename 必须围绕经过校验的真实目标执行，不能用 rename 覆盖符号链接目录项。

文件内容继续采用只读工具已经确定的严格文本边界：检测到 NUL 字节或非法 UTF-8 时返回 `unsupported_content`，不猜测其他编码。

可编辑文件的协议硬上限为 2 MiB 原始字节。`WorkspaceEditor` 在目标 `stat` 后以及实际读取完成后各检查一次，防止文件在检查与读取之间增长。超限返回 `resource_limit`，Runtime 覆盖只能降低该上限。

## 6. 原子写入

pi 当前在完成全部校验后直接写目标文件。Byte Mentor 在此基础上采用同目录临时文件加 rename，避免进程崩溃或写入失败留下部分文件内容。

写入流程：

1. 完成路径、类型、策略、编码和全部 edit 校验。
2. 在目标文件所在目录以不可预测随机名称和 exclusive create 创建 mode `0600` 的临时文件，避免名称碰撞、符号链接替换和跨文件系统 rename。
3. 写入完整新内容，并在关闭前把临时文件 chmod 为原文件的权限 mode；首版不承诺保留 owner、ACL 或扩展属性。
4. 关闭临时文件后，将其 rename 到已经验证的真实目标路径。
5. 任一步骤失败时只清理本次 exclusive create 成功后持有的临时文件，并返回结构化错误。

一次调用只有两个对外可见状态：原文件或完整新文件，不暴露部分写入内容。

取消检查只允许出现在提交点之前：开始 I/O 前、等待中的文件操作收敛后，以及 rename 前。取消发生在 rename 前时清理临时文件并返回 `tool_cancelled`；rename 成功即视为修改已经提交，之后不得再次检查 signal 并把成功改写为取消。这样可以避免“文件已经修改但 ToolResult 声称失败”的不一致状态。

原子 rename 不等于多进程并发控制。外部进程仍可能在读取和 rename 之间修改目标文件，首版不检测、合并或锁定这种竞争；这是当前单 session 目标之外的明确限制。

## 7. 错误模型

路径、访问、类型、编码和资源错误继续使用现有稳定错误码：

- `path_not_found`
- `access_denied`
- `wrong_path_type`
- `unsupported_content`
- `resource_limit`

参数 schema 失败继续由 Registry 返回 `invalid_arguments`。

edit 参数聚合字符数超过协议上限时同样返回 `invalid_arguments`；目标文件超过 2 MiB、diff/patch 无法放入完整 ToolResult 时返回 `resource_limit`。

edit 领域错误需要可供模型稳定纠正，新增以下 `ToolErrorCode`：

- `edit_target_not_found`：某个 `oldText` 没有匹配。
- `edit_target_not_unique`：某个 `oldText` 匹配多处。
- `edit_targets_overlap`：多个替换范围重叠。
- `edit_no_change`：替换后的结果与原内容相同。

错误的 `details` 至少包含 `path`，与单项 edit 相关时包含 `editIndex`，重复匹配时包含 `occurrences`。错误消息面向模型说明可采取的修正动作。

未预期的底层文件系统异常仍由 Registry 归一化为 `execution_failed`，但不能把上述可预期错误折叠成该通用错误。

## 8. 并发策略

`edit_file` 不设置 `concurrency: "safe"`。因此，只要一个 AssistantMessage 的 Tool Call 批次中包含 `edit_file`，`AgentRunner` 就会按原始顺序逐个执行整批调用。

在当前单 session、单 turn 且批次串行的前提下：

- 不会有两个 Runtime 内部的 edit 同时读写同一文件。
- `read_file -> edit_file -> read_file` 可以按模型顺序观察稳定状态。
- `edit_file` 与未来 `bash` 的文件系统副作用不会在同一批中交错。
- 不需要复制 pi 的 per-file mutation queue，也不需要 workspace/file 两级锁。

如果未来允许同一进程内多个 session 共享工作区并行运行，应重新审视这一结论。届时 Runner 的单批串行不足以协调跨 session 写入，可能需要工作区级调度器或按 canonical path 建立的文件 mutation queue。该能力不在当前设计范围内。

## 9. 模块边界

建议目标结构：

```text
packages/agent/src/tools/
├── contracts.ts
├── tool-registry.ts
├── workspace/
│   ├── workspace-path-resolver.ts
│   ├── workspace-reader.ts
│   ├── workspace-editor.ts
│   └── workspace-policy.ts
└── builtins/
    ├── edit-file.ts
    └── edit-diff.ts
```

职责划分：

- `workspace-path-resolver.ts`：共享词法路径、realpath、工作区边界和 denied policy 校验。
- `workspace-editor.ts`：读取可编辑文本快照、原子写入和稳定工作区错误转换。
- `edit-diff.ts`：纯函数形式的换行处理、有限模糊匹配、批量替换和 diff/patch 生成。
- `edit-file.ts`：模型可见 schema、说明、参数到 WorkspaceEditor 的薄映射以及成功 payload 组装。
- `contracts.ts`：扩展 `ToolExecutionContext` 和稳定 edit 错误码。

文本匹配和 diff 计算应保持为无文件系统副作用的纯函数，便于直接复用 pi 的成熟逻辑并进行边界测试。

## 10. 测试策略与验收标准

### 10.1 匹配与转换单元测试

- 单项精确替换和多个不相交替换。
- 所有 edit 基于同一原始快照匹配。
- 缺失、重复、空 `oldText`、重叠和 no-op 均整次失败。
- 重复统计包含重叠候选，任一 edit 进入模糊模式时全部 edit 在同一模糊空间重新定位。
- 精确匹配优先于有限模糊匹配。
- NFKC、智能引号、dash、特殊空格和尾部空白归一化。
- 模糊匹配只改写受影响行块，未修改行保持原内容。
- LF、CRLF、CR、UTF-8 BOM 和无 BOM 文件。
- 展示型 diff、unified patch 和 `firstChangedLine`。

### 10.2 WorkspaceEditor 测试

- 绝对路径、词法越界、denied path 和不存在路径。
- 工作区内、工作区外、denied target 和断裂符号链接。
- 目录、特殊文件、二进制、非法 UTF-8 和不可写文件。
- 原子替换成功后内容完整且保留文件 mode。
- 写入或 rename 失败时目标文件保持原内容并清理临时文件。
- 编辑允许的符号链接目标时保留链接本身。
- 2 MiB 上下界、Runtime 较低覆盖、`stat` 后文件增长和读取后的第二次限制检查。

### 10.3 Tool 与 Runner 集成测试

- 参数 schema、未知字段和空 edits 数组。
- path、edit 数量、单字段和聚合字符数的上下界；聚合超限在读取文件前返回 `invalid_arguments`。
- 成功 payload 与每个稳定错误码。
- 结果始终是合法、未被中途截断的结构化 JSON。
- diff/patch 超过序列化预算时返回 `resource_limit`。
- `edit_file` 未声明 safe，包含它的 Tool Call 批次严格按模型顺序串行。
- 同批某个 edit 失败后，Runner 仍按现有串行批次语义继续执行后续 Tool Call，并分别产生 ToolMessage。
- checkpoint、RuntimeEvent 和原始 ToolMessage 顺序不退化。

### 10.4 完成标准

- Agent 能在工作区内对已有 UTF-8 文本文件执行单项或批量局部替换。
- 任一校验失败时文件内容完全不变。
- Agent 无法通过普通路径或符号链接编辑工作区外和 denied 文件。
- 成功结果足以让模型确认修改内容并继续下一步操作。
- 当前单 session 中的写入副作用按 Tool Call 原始顺序发生。

## 11. turn 级取消契约

### 11.1 终态与持久化

取消是区别于失败的独立 turn 终态：

- `StopReason` 增加 `cancelled`。
- `HeadlessTurnResult` 增加 `status: "cancelled"` 的分支，不携带通用 `error`。
- `RuntimeEvent` 增加 `turn.cancelled`，并为取消的 Tool Call 增加 `tool.cancelled`。
- `ToolErrorCode` 增加通用 `tool_cancelled`；`command_cancelled` 只表示已经启动的 Bash 被取消。
- `RuntimeCheckpoint` 增加 `cancelled` phase，`pendingToolCalls` 必须为空。

新增事件字段固定为：

```ts
type ToolCancelledEvent = {
  type: "tool.cancelled"
  toolCallId: ToolCallId
  toolName: string
  started: boolean
  durationMs: number
  errorCode: "tool_cancelled" | "command_cancelled"
  message: string
}

type TurnCancelledEvent = {
  type: "turn.cancelled"
  sessionId: SessionId
  messageId: MessageId
  stopReason: "cancelled"
}
```

未启动 Tool Call 的 `durationMs` 固定为 0；已启动调用记录实际耗时。`turn.cancelled.messageId` 指向取消终态使用的合成 AssistantMessage。

Runner 在取消终态写入一个合成 AssistantMessage，固定内容为 `[Assistant reply cancelled.]`，并把它包含在 `cancelled` checkpoint 和最终 `newMessages` 中。这样 session 不会停在 UserMessage 或 ToolMessage，进程在 SAVE 前异常退出时也能通过 checkpoint 恢复完整轨迹。

取消不是用户可见的通用错误。CLI 在退出流程中不额外调用 `showError`。如果 checkpoint、session 保存或必要清理失败，则数据完整性失败优先于取消，turn 返回 `failed`。

### 11.2 Signal 传递边界

每个 turn 使用独立 `AbortController`。signal 是单次执行控制信息，不能放入由 Registry 在 Runtime 启动时静态持有的 `ToolExecutionContext`。

目标接口分层：

```text
InteractiveChatController
  -> AgentLoop.runTurn(..., { signal })
  -> AgentRunner.run({ ..., signal })
      -> ModelProvider.invokeStream(request, { signal })
      -> ToolRegistry.execute(name, args, { signal })
          -> AgentTool.execute(args, context, { signal })
```

- `ProviderRequest` 继续只包含 messages 和 tools；signal 通过独立的 Provider invocation options 传递。
- OpenAI Provider 使用 SDK 的第二个 request options 参数调用 `chat.completions.create(request, { signal })`。
- `ToolExecutionContext` 只保存 `WorkspaceReader`、`WorkspaceEditor` 等静态依赖；`ToolExecutionOptions` 保存 signal。
- checkpoint、session 持久化、临时文件清理和 Runtime close 不接收 turn signal，取消不能中断这些收尾操作。
- Controller 在 turn 完成后释放 controller 引用和相关监听器，避免 signal 跨 turn 泄漏。

### 11.3 Runner 取消算法

- 发起每次模型请求或 Tool Call 前检查 signal；已经取消时不得启动新工作。
- Provider 在最终 `done` 前因 signal 中止时，Runner 进入取消终态且不进入 Tool 阶段。
- Provider 已返回包含 Tool Calls 的 AssistantMessage 时，Runner 先保存 `awaiting_tools` checkpoint，再处理取消。
- 已启动的 Tool Call 收到 signal 后必须等待自身 I/O、进程和清理真正收敛；其真实成功或失败结果保留，不因 signal 已经 aborted 而被统一覆盖。
- 尚未启动的 Tool Call 按模型原始顺序生成合法 JSON ToolMessage，错误码为 `tool_cancelled`；对应 RuntimeEvent 使用 `tool.cancelled` 且 `started: false`。
- 已启动 Tool 只有在真实结果为 `tool_cancelled` 或 `command_cancelled` 时产生 `tool.cancelled` 且 `started: true`；如果它越过提交点后成功，或因其他原因失败，仍分别产生 `tool.completed` 或 `tool.failed`。
- 并发 safe 批次在取消后停止领取新任务，等待已领取任务结束，再按原始 Tool Call 顺序组装全部 ToolMessage。
- 全部 Tool Call 都有结果后保存 `cancelled` checkpoint，不再请求模型。

最终模型 `done` 已返回 completed，或文件原子 rename 已成功时，对应操作已经越过提交点；之后到达的 abort 不得追溯改变其结果。Runtime close 复用同一取消入口：先请求取消，再等待当前 turn 和已启动 Tool 收敛，最后关闭其余资源。

### 11.4 测试策略与验收标准

- 在模型请求前、模型流中和最终 `done` 后分别触发取消，验证只有前两者进入取消终态，且 signal 通过独立 invocation options 传递。
- 串行和并发 safe 批次都停止启动新调用；已启动调用按真实结果收敛，未启动调用获得 `tool_cancelled` ToolMessage。
- `tool.cancelled` 的 `started`、`durationMs` 和 `errorCode` 与调用是否启动及真实取消原因一致，其他结果仍使用 completed/failed 事件。
- `cancelled` checkpoint、最终 `newMessages` 和持久化 session 都包含同一个合成 AssistantMessage，恢复后没有 pending Tool Call 或半条轨迹。
- edit 在 rename 前取消时目标不变且临时文件已清理；rename 后到达的 abort 不改写已提交成功。
- CLI 忙碌退出会取消并等待 turn，结束流式卡片且不显示通用错误；checkpoint、session 保存或必要清理失败仍优先返回 failed。

## 12. `bash` 的职责与安全边界

`bash` 负责在工作区默认目录下执行一条由模型生成的 Shell 命令，持续消费其标准输出和标准错误，并在进程结束后返回结构化执行结果。

首版采用与 pi 接近的本地可信执行模型：

- 子进程拥有启动 Byte Mentor 的当前操作系统用户权限。
- `workspaceRoot` 只是命令的默认工作目录，不是文件系统沙箱。
- 命令可以通过绝对路径或 `cd` 访问工作区外文件，也可以使用网络和宿主机上可执行程序。
- `WorkspaceAccessPolicy` 只约束专用工作区 Tool，不能约束任意 Shell 命令。

如果未来要求 Bash 只能访问工作区，需要单独引入容器、OS sandbox 或等价的进程隔离机制；不能通过路径字符串检查或环境变量过滤实现该保证。

首版明确不包含：

- PTY 和交互式 stdin。
- 需要用户输入密码或确认的交互式程序。
- 长期存在的 Shell session。
- 跨 Tool Call 保留 `cd`、`export`、alias 或 Shell 变量。
- 后台服务和脱离 Tool 生命周期的进程。
- 命令执行前的用户审批；该能力留待后续独立设计。

文件系统副作用会正常保留，但 Shell 内部状态在本次 Tool Call 结束后消失。需要连续执行的操作应由模型写在同一条命令中，例如 `cd packages/agent && pnpm test`。

## 13. Tool 契约

### 13.1 名称与参数

工具名称为 `bash`。

参数：

```ts
{
  command: string
  timeout?: number
}
```

参数约束：

- `command` 是包含至少一个非空白字符的 Shell 命令字符串，协议硬上限为 32,768 个 Unicode 字符。校验时可以使用 trim 判断是否为空，但实际执行必须保留原字符串。
- `timeout` 的单位为秒，必须是有限正数，最大值为 2,147,483.647 秒，对应 Node.js timer 的 2,147,483,647 毫秒上限。
- `timeout` 缺省时不设置默认超时，与 pi 的行为保持一致；用户取消仍可终止命令。
- 参数 schema 设置 `additionalProperties: false`。
- 不提供 `cwd` 参数，工作目录由 Runtime 固定为 `workspaceRoot`。
- 不提供 `env` 参数，模型不能决定继承宿主机的哪些环境变量。

上述参数限制是协议硬上限，Runtime 配置只能降低、不能提高。违反限制时返回 `invalid_arguments`，不得启动子进程。

### 13.2 成功结果

只要 Shell 成功启动并自然退出，就返回成功 payload：

```ts
{
  command: string
  exitCode: number
  output: string
  truncated: boolean
  truncation?: {
    truncatedBy: "lines" | "output_limit"
    totalLines: number
    returnedLines: number
  }
  fullOutputPath?: string
}
```

语义约定：

- `output` 是 stdout 和 stderr 按父进程实际收到数据的顺序合并后的文本。
- `exitCode` 原样返回，包括非零退出码。
- 非零退出码是被执行命令的正常结果，不转换成 `ToolResult.ok: false`。
- 没有输出时返回空字符串，不使用自然语言占位符。
- `truncated` 明确表示 `output` 是否只包含完整输出的尾部。
- 只有发生截断时才返回 `truncation` 和 `fullOutputPath`。

这一区分表达了两个不同层次：Tool 是否成功执行了命令，以及命令自身是否以零退出码结束。模型可以依据 `exitCode` 和 `output` 判断下一步，而 Registry 不会把常见的命令失败错误归类为 Runtime 异常。

`command` 本身不允许为了结果预算而截断。启动子进程前，Tool 必须用 command 和最小成功 payload 预检完整 `ToolResult` 的序列化大小；如果固定字段已经无法放入 Registry 预算，则返回 `resource_limit` 且不得 spawn。这样 32,768 字符的协议上限仍可独立于较低的 Runtime 结果预算存在，而不会执行一个随后无法形成合法结果的命令。

如果 Bash 不是通过自然 exit code 退出，而是在没有 timeout、turn cancellation 或 Runtime close 的情况下被外部 signal 终止，则没有可原样返回的数字 `exitCode`。该情况返回 `execution_failed`，并在 details 中保留 signal 名称和终止前输出；不虚构 `128 + signal` 退出码。

## 14. Shell 进程模型

### 14.1 一次性 Shell

每次 `bash` Tool Call 使用 Node.js `spawn()` 启动一个新的、一次性的 Shell 进程。首版不使用 `exec()`，也不维护长期 Shell。

概念调用：

```ts
spawn(shellPath, ["--noprofile", "--norc", "-c", command], {
  cwd: workspaceRoot,
  detached: true,
  env: shellEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
})
```

使用 `spawn()` 的原因：

- stdout 和 stderr 可以在子进程运行期间持续消费，不需要把完整输出缓存在内存后再返回。
- Runtime 可以在读取过程中统计行数、执行尾部截断并写入完整输出日志。
- 超时或取消时可以定位并终止本次 Tool Call 创建的进程树。
- 命令仍通过 Shell 解释，支持管道、重定向、变量展开和 `&&` 等语法。

### 14.2 Shell 选择

首版明确执行 Bash，不继承用户当前的交互式 Shell 类型：

- 默认先检查 `/bin/bash`，不存在时根据受控环境中的 `PATH` 查找 `bash`；找不到时返回 `shell_unavailable`，不降级到 `sh`。
- CLI 可以通过 `BYTE_MENTOR_BASH_PATH` 配置绝对 Bash 路径。变量未设置时使用默认选择；变量只要已设置就必须是非空绝对路径，否则在 Runtime 启动前返回 `CliConfigError`。存在性、普通文件类型和可执行权限在每次 Tool 执行前检查，失败返回 `shell_unavailable`；模型参数不能覆盖。
- 使用 non-login、non-interactive 模式，并禁用 profile 和 rc 文件加载。
- 首版以 Unix 进程模型为目标；Windows Shell 和进程树终止语义不在当前范围内。

禁用 Shell 启动脚本可以避免 alias、prompt hook 和用户 profile 对工具行为产生隐式影响。命令可执行文件的查找依赖 Runtime 显式传入的 `PATH`。

## 15. 环境变量

Runtime 手动构造传给 Bash 的环境变量，不直接把完整 `process.env` 传给子进程。

环境构造按以下固定优先级执行，后一步覆盖前一步：

1. 从父进程复制允许的基础变量。
2. 按用户白名单复制额外变量，但固定 denylist 始终优先。
3. 写入 Runtime 固定值。

默认基础变量为：

- `PATH`
- `HOME`
- `USER`
- `LOGNAME`
- `TMPDIR`
- `LANG`
- 所有 `LC_*` locale 变量

Runtime 固定设置：

- `SHELL=<实际 shellPath>`
- `TERM=dumb`
- `NO_COLOR=1`

不设置 `CI`，避免改变测试工具本身的行为。`PWD` 不从父进程复制，由 Bash 根据固定 `cwd` 建立。

以下变量属于固定 denylist，即使出现在用户白名单中也不得传递：

- `OPENAI_API_KEY`
- 所有 `BYTE_MENTOR_*`
- `PWD`、`OLDPWD`
- `BASH_ENV`、`ENV`、`CDPATH`、`PROMPT_COMMAND`

CLI 使用 `BYTE_MENTOR_BASH_ENV_ALLOWLIST` 接收逗号分隔的额外变量名。解析时 trim、删除空项、按首次出现顺序去重，并要求每项匹配 `[A-Za-z_][A-Za-z0-9_]*`；非法配置在 Runtime 启动前返回 `CliConfigError`。白名单只从启动时的父进程环境取值，不能由模型扩大。首版不自动读取或注入项目 `.env` 文件。

环境变量过滤用于减少凭证意外暴露和提高执行确定性，不构成安全沙箱；拥有当前用户文件系统权限的 Bash 仍可能从配置文件或其他路径读取信息。

## 16. 输出捕获与截断

### 16.1 流式捕获

子进程的 stdout 和 stderr 都配置为 pipe，并在进程运行期间持续读取：

- stdout 和 stderr 各自使用独立的流式 UTF-8 decoder，避免一个流中未完成的多字节字符与另一个流的 chunk 混合。
- 数据 chunk 不被假定为完整行。
- stdout 和 stderr 的 chunk 在父进程观察到时分配单调序号，解码和清理后按该序号进入同一个输出累加器。
- 每个流维护独立的 ANSI 清理状态，正确处理跨 chunk 的 CSI、OSC 等 escape sequence；不能简单地逐 chunk 调用无状态 strip 函数。
- 清理后保留换行和 tab，移除 carriage return、DEL、其余 C0/C1 控制字符及 ANSI sequence。CRLF 因移除 CR 归一化为 LF。
- ShellExecutor 的 chunk consumer 是可等待的异步边界。处理或日志写入未完成时暂停两个 pipe，最多保留每个流一个待处理 chunk，避免 Promise 队列导致无界内存。
- 首版只在内部流式消费，不向 CLI 增加实时 `tool.output` 事件；用户在 Tool 完成后看到最终结果。

stdout 和 stderr 是两条独立 pipe，因此合并顺序只表达父进程收到事件的顺序，不保证恢复两个文件描述符在操作系统内部的绝对写入时序。

### 16.2 返回尾部

Bash 输出优先保留尾部，因为构建、测试和命令失败的最终摘要通常位于输出末尾。

输出累加器同时执行：

- 2,000 行协议硬上限。
- Registry 的 24,000 字符最终序列化 ToolResult 上限。

工具根据包含 command、exitCode、truncation 和 fullOutputPath 的实际 payload 执行 `JSON.stringify()` 预算，使用二分或等价方式缩减 `output` 尾部，保证成功和失败结果都是完整合法 JSON。截取必须保持 Unicode scalar 边界，不能产生孤立 surrogate。

空输出计为 0 行；末尾换行不额外制造空行；没有末尾换行的最后一段计为一行。先应用 2,000 行尾部限制，再应用实际 JSON 预算；如果 JSON 预算进一步缩短输出，`truncatedBy` 为 `output_limit`，否则为 `lines`。超长单行允许保留其可放入结果的尾部。

### 16.3 完整输出临时文件

当输出首次超过返回限制时，Runtime 创建完整输出临时文件：

- 文件位于 Runtime 懒创建的 session 临时目录，不写入用户工作区；目录权限为 `0700`。
- 文件名使用不可预测的随机部分。
- 文件权限为 `0600`。
- 日志包含从命令开始到结束的完整、已解码和已清理文本，而不是只包含触发截断后的部分。
- 首次超过 2,000 行或最大可返回 JSON 预算时，把此前的有界缓冲完整补写到日志；后续 chunk 通过单一异步写链追加，并对 pipe 施加背压。
- ToolResult 通过 `fullOutputPath` 返回日志的绝对路径。
- Runtime 在 session 结束时 best-effort 清理临时文件；异常退出后的残留交给操作系统临时目录清理策略。

单条命令的清理后完整日志协议硬上限为 100 MiB，按写入日志的 UTF-8 字节数计算，Runtime 只能降低。恰好 100 MiB 允许完成；下一段清理后文本会使日志超过上限时，只写入能在 Unicode scalar 边界内放入上限的最长前缀，然后终止进程树、继续排空 pipe、等待输出与日志写入收敛，并返回 `resource_limit`。该资源错误下的日志是截至限制边界的前缀，不再声称包含终止前被排空的后续输出。日志创建、chmod、补写或追加失败执行相同的安全终止流程，并只暴露仍可安全读取的日志路径。

完整输出文件只在最终结果发生截断时保留。模型若需要检查更早的输出，可以在后续 Bash 命令中读取该路径。Runtime close 对临时目录清理保持幂等。

## 17. 超时、取消与进程清理

引入 Bash 前必须完成第 11 节的 turn 取消链路，使当前 turn 的 signal 能够传递到 ShellExecutor。ShellExecutor 另持有 Runtime close signal，并在 details 中用 `cancelledBy: "turn" | "runtime"` 区分来源。

每次 Bash 调用建立独立进程组。发生以下情况时终止整个进程组，而不只终止直接的 Bash 子进程：

- 用户取消当前 turn。
- 达到调用指定的 `timeout`。
- Runtime 正在关闭。

终止后必须等待直接子进程收敛并关闭输出捕获，再释放 Tool Call。首版不允许命令通过 `&`、`nohup` 等方式把后台进程作为受支持结果留在 Tool 生命周期之外；Shell 正常退出后也应 best-effort 清理同一进程组内仍存活的后代进程。

进程终止采用统一状态机：第一个观察到的自然退出、timeout、turn cancellation、Runtime close 或输出资源失败决定终止原因。需要主动终止时先向进程组发送 SIGTERM，最多等待 250 ms，再向仍存活的进程组发送 SIGKILL。自然退出已经发生后到达的 timeout 或 abort 不得改写结果。直接 Bash 退出后如果 pipe 仍被普通后台后代持有，执行同一进程组清理并等待 pipe 关闭；Promise 只有在子进程、pipe、decoder flush 和日志写链全部收敛后才完成。

没有 OS sandbox 时无法绝对阻止命令主动 double-fork 或创建新 session 逃离原进程组。首版依赖本地可信执行模型，并把这种主动 daemonize 行为定义为不受支持。

## 18. 错误模型

以下情况返回 `ToolResult.ok: false`：

- `shell_unavailable`：选定的 Bash 不存在、不是普通文件或不可执行。
- `command_timed_out`：达到指定 timeout，进程树已被终止。
- `command_cancelled`：用户或 Runtime 取消当前执行，进程树已被终止。
- `resource_limit`：spawn 前固定结果字段已无法放入 Registry 预算，或完整输出日志将超过上限、无法建立或无法继续写入，Runtime 无法安全形成完整结果。
- `execution_failed`：其他未预期的进程管理或文件系统异常。

超时、取消、外部 signal 和输出资源错误的 `details` 应保留在终止前已捕获的输出尾部、截断信息和完整日志路径。取消额外包含 `cancelledBy`，外部 signal 包含 signal 名称。错误结果同样必须遵守 Registry 的序列化上限。

以下情况不是 Tool 错误：

- 命令以任意非零退出码自然结束。
- 命令没有产生 stdout 或 stderr。
- 输出超过返回上限但已经成功保存完整日志。

## 19. 并发策略

`bash` 不声明 `concurrency: "safe"`。只要同一批 Tool Call 包含 `bash`，`AgentRunner` 就按模型给出的顺序串行执行整批调用。

在当前单 session 范围内，这保证：

- 两个 Bash 调用不会同时修改工作区。
- `edit_file` 与 Bash 的文件系统副作用不会交错。
- Bash 前后的只读 Tool 能按模型顺序观察文件系统状态。

当前不增加 Bash 专用锁、workspace 锁或 per-file mutation queue。外部进程和未来其他 session 的并发修改不在当前一致性保证范围内。

## 20. Bash 模块边界

建议新增：

```text
packages/agent/src/tools/
├── shell/
│   ├── shell-environment.ts
│   ├── shell-executor.ts
│   ├── shell-log-store.ts
│   └── shell-output.ts
└── builtins/
    └── bash.ts
```

职责划分：

- `shell-environment.ts`：解析并校验 Bash 路径，根据固定基础集合和 Runtime 白名单构造子进程环境。
- `shell-executor.ts`：一次性 Shell spawn、timeout、AbortSignal、进程组和退出状态。
- `shell-log-store.ts`：mode `0700` 的 session 临时目录、随机 `0600` 日志、100 MiB 限制和幂等清理。
- `shell-output.ts`：双流解码、流式 ANSI/控制字符清理、尾部累加和精确 JSON 预算。
- `builtins/bash.ts`：模型可见 schema、说明、参数映射和结构化 ToolResult。

进程执行、输出捕获和模型 Tool 契约分离，避免把 OS 进程管理细节直接堆积在 builtin 定义中。

## 21. Bash 测试策略与验收标准

### 21.1 ShellExecutor 测试

- stdout、stderr、交错 chunk 和跨 chunk UTF-8 字符。
- 零退出码、不同非零退出码和无输出命令。
- 固定 workspace cwd 和一次性 Shell 状态。
- timeout、AbortSignal 和 Runtime 关闭时的进程组终止。
- 子进程和普通后台后代不会在 Tool 完成后残留。
- 外部 signal 退出、SIGTERM 到 SIGKILL 升级，以及自然退出与取消竞争。
- Shell 不存在、不是普通文件、不可执行和其他 spawn 失败。

### 21.2 环境变量测试

- 基础变量被正确传入。
- `PWD` 根据 workspace cwd 建立。
- Provider 凭证、Byte Mentor 内部变量和 Shell 注入变量不被继承。
- 用户白名单可以放行指定变量，但固定 denylist 优先且模型参数不能扩大白名单。
- allowlist 的 trim、去重、名称校验和非法配置失败。
- profile、rc 和项目 `.env` 不会被自动加载。

### 21.3 输出测试

- 未截断输出完整返回。
- 超过行数或序列化预算时只返回尾部，并提供准确截断元数据。
- stdout/stderr 分别跨 chunk 解码，ANSI sequence 跨 chunk 清理，合并顺序稳定。
- 超长单行按 Unicode scalar 边界截取。
- 截断时完整日志包含命令开始后的全部输出，权限为 `0600`。
- 日志下一段输出会使其超过 100 MiB 或写入失败时终止进程并返回 `resource_limit`。
- session 结束时 best-effort 删除 Runtime 创建的日志。
- 所有成功和失败结果均不超过 Registry 上限，且是完整合法 JSON。

### 21.4 Tool 与 Runner 集成测试

- command、timeout、未知字段和边界值校验。
- command 固定结果字段超过 Registry 预算时在 spawn 前返回 `resource_limit`。
- `BYTE_MENTOR_BASH_PATH` 与 `BYTE_MENTOR_BASH_ENV_ALLOWLIST` 的合法和非法 CLI 配置。
- 非零退出码返回成功 payload，不产生 `tool.failed`。
- spawn、timeout 和取消返回对应稳定错误码。
- `bash` 未声明 safe，包含它的 Tool Call 批次严格按模型顺序串行。
- Bash、`edit_file` 和只读 Tool 混合调用时，ToolMessage 和 checkpoint 顺序稳定。
- 首版不会产生实时输出事件或等待交互式 stdin。

### 21.5 完成标准

- Agent 能在 workspace cwd 中执行一次性 Bash 命令并获得退出码和输出。
- 非零退出码能够作为正常命令结果被模型处理。
- 大输出不会无界占用内存，返回值不会突破 Registry 上限，完整输出可从受控临时文件获取。
- 超时、取消或 Runtime 关闭后，不遗留普通子进程树。
- Bash 与其他有副作用 Tool 在当前单 session 中按模型顺序执行。
