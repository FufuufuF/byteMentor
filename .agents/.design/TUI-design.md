# 交互式 TUI 设计

## 1. 背景

Byte Mentor 当前只有一次性 CLI smoke 链路：

```text
byte-mentor chat "message"
  -> 创建 runtime
  -> AgentLoop.runTurn()
  -> stdout 输出
  -> 关闭 runtime
```

`packages/tui` 已存在，但只有空导出。目标是在不引入 pi `AgentSession` 的前提下，复用
`@earendil-works/pi-tui` 的终端渲染能力，并参考 pi coding-agent 的视觉组件，实现可连续多轮对话的默认交互界面。

本设计只覆盖通用聊天 TUI，不引入教学状态、Knowledge UI 或 pi 的完整 coding-agent 功能。

## 2. 已确认决策

- 默认入口仍为 `byte-mentor chat`。
- `byte-mentor chat` 不带消息时直接进入交互式 TUI。
- `byte-mentor chat "initial message"` 会进入同一 TUI，自动提交 initial message，完成后继续等待输入。
- 一次进程生命周期内只创建一个新 session；首轮从 `runTurn()` 取得 `sessionId`，后续每轮显式复用。
- `apps/cli` 负责 runtime 与 TUI 的组装和生命周期。
- `packages/tui` 只负责终端组件、布局、主题和本地 UI 状态，不依赖 `@byte-mentor/agent`、`@byte-mentor/session` 或 SQLite。
- 底层直接依赖发布包 `@earendil-works/pi-tui@0.82.1`，不使用 `file:../pi`，避免机器路径耦合。
- 视觉参考 pi 当前本地源码 `/Users/user/Desktop/personal-projects/pi`，但不复制其 `interactive-mode.ts`。
- 允许适配或移植 pi 的纯视觉代码；凡复制实质代码，保留 MIT attribution，并增加第三方声明。
- 第一版采用“单轮串行”交互：生成期间不提交第二条消息，也不实现 steer/follow-up queue。
- 第一版不取消进行中的 provider/tool 工作。生成期间按 Ctrl+C 标记 `exitAfterTurn`，当前轮结束、SQLite 正常关闭后退出。
- 不实现 session picker、历史 session resume、模型选择、主题选择、登录弹窗、上下文压缩、tree/fork、图片或外部编辑器。

## 3. 目标体验

启动后的布局从上到下为：

```text
Byte Mentor header / 简短启动信息

用户消息卡片（背景色）

助手 Markdown 内容（流式更新）

工具调用卡片（pending / success / error）

working indicator

带动态边框的多行 Editor

footer: workspace | model | session | keyboard hints
```

行为要求：

1. 用户提交非空文本后，消息立即出现在 transcript。
2. Editor 清空并进入 busy 状态，重复提交被拒绝。
3. 模型 content delta 到达时，助手 Markdown 在同一组件内增量更新。
4. 模型产生 tool calls 时，按 tool call 顺序创建工具卡片；RuntimeEvent 更新其状态。
5. 最终回答完成后，Editor 恢复可输入状态并继续复用同一个 session。
6. 单轮失败以界面内错误消息展示，TUI 不退出，用户可以继续下一轮。
7. 空闲时 Ctrl+C 或空 Editor 上 Ctrl+D 正常退出；退出必须恢复 raw mode、光标和终端状态，并关闭 SessionStore。
8. 忙碌时 Ctrl+C 不强杀进程，而是显示“本轮结束后退出”。

## 4. 包边界

### 4.1 `@byte-mentor/tui`

负责：

- 创建和控制底层 `TUI` / `ProcessTerminal`。
- dark/light palette 与 Markdown/Editor theme。
- header、用户消息、助手消息、工具执行、状态、Editor、Footer 组件。
- transcript 内组件的创建、更新和重绘。
- 解析键盘输入并通过回调通知应用层 submit/exit。
- busy、sessionId、model、workspace 等展示状态。

不负责：

- 创建 AgentLoop。
- 调用 provider 或 tool。
- 选择或持久化 session。
- 解释 Agent runtime 的重试、checkpoint 或状态机。
- 读取环境变量。

建议 public API：

```ts
export interface ByteMentorTuiOptions {
  model: string;
  workspaceRoot: string;
  terminal?: Terminal;
  onSubmit(text: string): void;
  onExit(): void;
}

export interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
}

export class ByteMentorTui {
  constructor(options: ByteMentorTuiOptions);
  start(): void;
  stop(): void;
  submitInitialMessage(text: string): void;
  appendUserMessage(text: string): void;
  beginAssistantMessage(): void;
  appendAssistantDelta(text: string): void;
  completeAssistantMessage(content?: string): void;
  addToolCall(toolCall: ToolCallView): void;
  startToolCall(id: string): void;
  completeToolCall(id: string, output: string): void;
  failToolCall(id: string, message: string): void;
  showError(message: string): void;
  setBusy(busy: boolean): void;
  setSessionId(sessionId: string): void;
  setExitAfterTurn(pending: boolean): void;
}
```

`Terminal` 可以从 pi-tui 以 type 形式透出；CLI 正常路径不需要直接依赖 pi-tui，测试可以注入结构兼容的虚拟终端。

所有 public mutation 方法都必须幂等地请求重绘；`start()` / `stop()` 也必须幂等，防止异常路径重复清理。

### 4.2 `@byte-mentor/cli`

负责：

- 解析 `chat` 命令、可选 initial message 和环境配置。
- 创建 AgentLoop、SessionStore、Provider、ToolRegistry。
- 创建 `ByteMentorTui`。
- 将 TUI submit 转成串行 `runTurn()`。
- 将 ProviderStreamEvent、RuntimeEvent 和最终 `HeadlessTurnResult` 映射成 TUI 方法。
- 保存首轮返回的 sessionId，并用于后续轮次。
- 控制正常退出、busy 时延迟退出和 runtime close。

CLI 层使用一个私有 `InteractiveChatController` 管理以下状态：

```ts
interface InteractiveChatState {
  sessionId?: SessionId;
  busy: boolean;
  exitAfterTurn: boolean;
  stopped: boolean;
}
```

同一时刻最多存在一个 `runTurn()` promise。TUI 回调只触发 controller 方法，不在组件内部持有 AgentLoop。

## 5. 连续会话数据流

```text
TUI Editor submit(text)
  -> CLI controller 检查 idle
  -> view.appendUserMessage(text)
  -> view.setBusy(true)
  -> loop.runTurn({ userMessage: text, sessionId? }, callbacks)
      -> onStreamEvent(event) 实时更新 assistant/tool-call 视觉组件
      -> onRuntimeEvent(event) 实时更新 tool/status 视觉组件
  -> state.sessionId = result.sessionId
  -> 根据 result.newMessages 对工具输出和最终消息做一次 reconciliation
  -> view.setBusy(false)
  -> 恢复 Editor focus
  -> 若 exitAfterTurn，则停止 TUI 并关闭 runtime
```

首轮不传 `sessionId`，由 AgentLoop 创建 session。后续轮次必须传入上一轮的 `result.sessionId`。不得通过重新创建 AgentLoop 或扫描 SQLite 猜测当前 session。

## 6. 实时事件契约

当前 AgentRunner 会先缓存 content delta，直到 provider 返回 done 后才调用 `onStreamEvent`。这不满足 TUI 实时渲染，需要调整为：

- provider 产生每个 `content_delta` 时立即调用 `onStreamEvent`。
- provider 产生 `done` 时也立即调用 `onStreamEvent`。
- 每个 ReAct iteration 都遵循相同语义，TUI 通过 `done.stopReason` 划分 assistant/tool-call 边界。
- callback 调用顺序与 provider yield 顺序一致。
- callback 只负责观察，不改变最终 message、checkpoint 或 events 的持久化顺序。

`HeadlessTurnOptions` 还需要增加：

```ts
onRuntimeEvent?: (event: RuntimeEvent) => void;
```

AgentLoop 与 AgentRunner 每次把 RuntimeEvent 放入结果数组时，也同步调用该 observer。observer 看见的顺序必须与最终 `result.events` 相同。并发工具的 RuntimeEvent 按真实发生顺序记录，而 ToolMessage、checkpoint 和 transcript 工具卡片仍按原始 tool call 顺序稳定排列。TUI 需要的关键事件为：

- `turn.started`
- `model.requested`
- `model.responded`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `turn.completed`
- `turn.failed`

observer 和 stream callback 都是同步 `void` 回调；Agent 层不吞掉 callback 异常。CLI adapter 必须保证传入的回调内部捕获界面更新异常并走 fatal UI cleanup，避免无意把渲染错误伪装成 provider 错误。

## 7. Provider event 到视觉状态的映射

Controller 使用以下确定规则：

- 收到首个 `content_delta` 且当前没有 streaming assistant 时，调用 `beginAssistantMessage()`。
- 每个 `content_delta` 调用 `appendAssistantDelta(text)`。
- 收到 `done`：
  - 若 `message.content` 存在但此前没有 delta，用完整 content 创建/完成 assistant message，兼容 fake provider。
  - 若此前已有 delta，用 done message 的 content 作为最终真值完成组件，避免丢 delta；不得重复追加。
  - 对 `message.toolCalls` 按原顺序调用 `addToolCall()`。
  - 结束当前 streaming assistant 边界；下一 iteration 的 delta 创建新 assistant component。
- `tool.started` 根据 `toolCallId` 将卡片置为 active。
- `tool.completed` 用 `resultPreview` 先完成卡片。
- `tool.failed` 用 error code/message 将卡片置为 error。
- turn 返回后扫描 `result.newMessages` 中的 ToolMessage，以完整 `content` 覆盖 preview。
- turn failed/max_iterations 时在 transcript 中显示错误卡片，并恢复 idle。

未知或缺失的 toolCallId 不得抛出导致 TUI 崩溃；创建一个降级工具卡片并显示可用信息。

## 8. 视觉实现范围

参考 pi，但只移植以下视觉概念：

- dark/light palette。
- 用户消息背景卡片。
- 无背景 assistant Markdown。
- pending/success/error 三态工具卡片。
- accent spinner 与 muted 状态文字。
- bordered multiline editor。
- 单行 footer 与窄终端降级。
- ANSI-safe wrapping、CJK/emoji 宽度与 resize 交给 pi-tui。

不移植：

- pi logo、名称或专属文案。
- pi AgentSession、InteractiveMode、Extension API。
- model/session/settings selector。
- thinking level、compaction、branch、fork、retry countdown。
- syntax-highlight engine；第一版使用 pi-tui MarkdownTheme 的基础 code block 样式。
- 自定义 theme 文件加载和 file watcher。

主题策略：

- 默认根据终端背景能力选择 dark/light；无法判断时使用 dark。
- 主题在进程启动时确定，第一版不支持运行时切换。
- palette 值可参考 pi `dark.json` / `light.json`，Byte Mentor 只保留实际使用的 token。

## 9. 输入与生命周期

- Editor 接收多行输入；普通 Enter 提交，换行快捷键沿用 pi-tui Editor 默认 keybindings。
- 纯空白输入不提交。
- busy 时 Editor 保留显示但禁用提交，footer 显示 working 状态。
- 空闲时 Ctrl+C 或空输入 Ctrl+D 调用 `onExit()`。
- busy 时 Ctrl+C 只设置 `exitAfterTurn`，不调用 `process.exit()`。
- `runInteractiveChat()` 只有在 TUI 已停止且 runtime 已关闭后才 resolve。
- runtime close、TUI stop 各自最多执行一次，即使 startup、turn 或 render 抛错。
- 正常用户退出返回 exit code 0；启动/terminal 初始化失败返回 1；单轮模型失败只显示在界面内，不结束进程。

## 10. 测试策略

### 10.1 Agent 契约测试

- ProviderStreamEvent 在 provider yield 时实时转发，不在 done 后批量回放。
- tool-call iteration 和 final iteration 都转发 done，顺序稳定。
- RuntimeEvent observer 顺序与 result.events 完全一致。
- 未提供 observer 时现有行为不变。

### 10.2 TUI 组件测试

- 组件 `render(width)` 在 40/80/120 列下不超过 width。
- 用户、assistant Markdown、工具三态、error、footer 文本正确。
- 中文、emoji、长路径和窄终端不破坏宽度。
- streaming assistant 更新同一组件，不重复创建。
- toolCallId 更新正确卡片。

### 10.3 虚拟终端测试

使用 `@xterm/headless@5.5.0` 和测试专用 `VirtualTerminal`：

- 启动界面、输入、提交、stream、tool、完成后的完整 viewport/scrollback。
- resize 后布局不越界。
- stop 后 bracketed paste、cursor/raw mode 被恢复。

不要对完整 ANSI 字符串做大面积脆弱 snapshot；优先断言去 ANSI 后的关键行、组件状态和宽度。

### 10.4 CLI controller 测试

- 无 initial message 时等待输入。
- initial message 自动提交且 TUI 保持运行。
- 两次提交的第二次携带第一次返回的 sessionId。
- busy 时重复提交被拒绝。
- stream/runtime events 映射到 view 方法。
- turn failure 后恢复 idle，可继续提交。
- busy Ctrl+C 在 turn 完成后退出。
- 所有退出/异常路径只 close 一次。

## 11. 依赖与兼容性

新增并精确 pin：

- `@earendil-works/pi-tui@0.82.1`，放在 `packages/tui.dependencies`。
- `chalk@5.6.2`，放在 `packages/tui.dependencies`。
- `@xterm/headless@5.5.0`，放在根 devDependencies，仅用于测试。

pi-tui 要求 Node `>=22.19.0`，因此根 `package.json.engines.node` 从 `>=22.12.0` 提升为 `>=22.19.0`。

测试配置必须新增 `@byte-mentor/tui` alias、path 和 project reference，使测试只通过 package public API 导入生产组件。

## 12. 完成标准

- `byte-mentor chat` 启动 pi 风格的 Byte Mentor TUI。
- 同一进程可以完成至少三轮连续对话，sessionId 始终相同。
- assistant 文本真实流式显示。
- 工具调用至少显示 pending/success/error 状态。
- 中文、Markdown、代码块、终端 resize 可用。
- turn 失败不退出；正常退出恢复终端并关闭 SQLite。
- 自动化测试、typecheck、lint、format、build 全部通过。
- 使用真实 OpenAI-compatible endpoint 完成一次手工 tmux smoke。
