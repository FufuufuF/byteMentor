# 交互式 TUI 实现计划

## 当前状态

- 状态：已完成。
- 对应设计：`.agents/.design/interactive-tui-design.md`。
- 项目架构：`.agents/.design/architecture-design.md`。
- 视觉参考：`/Users/user/Desktop/personal-projects/pi` 当前本地源码。
- 目标执行方式：用户已明确授权在后续会话中一次性完成全部批次；不需要每个 RED/GREEN 小步等待人工 review。
- Git 约束：除非后续用户明确要求提交，否则只完成代码和验证，不执行 `git commit`。

## 1. 目标

将当前一次性 stdout CLI 改造成默认交互式 TUI：

```text
byte-mentor chat [optional initial message]
  -> 启动 pi 风格 TUI
  -> 用户连续提交消息
  -> 同一 AgentLoop runtime + 同一 sessionId 依次执行多轮
  -> 实时渲染 assistant delta、工具状态和错误
  -> 用户退出后恢复终端并关闭 SQLite
```

实现结束后，`packages/tui` 不再是空壳，`apps/cli` 成为 runtime 与 TUI 的唯一组装层。

## 2. 执行原则

- 开始实施前完整读取 design、本计划、architecture design 和相关源码。
- 使用 `test-driven-development` skill，严格先写失败测试再写生产代码。
- 按下列 Batch 顺序推进，不跳批，不临时扩大产品范围。
- 用户已要求“一把梭”；执行过程中连续完成所有已覆盖决策，只有遇到本计划没有覆盖且会改变公共契约的决策才暂停提问。
- 每个 Batch 对应一个建议 commit 边界，但没有明确提交授权时不 commit。
- 跨包只使用 public API；测试不得 import 其他 package 的 internal path。
- 保留现有 checkpoint、message 顺序、SQLite 和 workspace tool 行为。
- 不把 AgentLoop、SessionStore 或 provider 注入 `@byte-mentor/tui`。
- 不复制 pi 的 `interactive-mode.ts`；只依赖 pi-tui 并适配纯视觉组件。
- 新依赖精确 pin，不使用 caret。
- 不使用真实 API 完成自动化测试。

## 3. 固定接口与行为

### 3.1 CLI config

将：

```ts
interface CliConfig {
  command: "chat";
  userMessage: string;
  // existing fields
}
```

改为：

```ts
interface CliConfig {
  command: "chat";
  initialMessage?: string;
  openaiApiKey: string;
  model: string;
  openaiBaseURL?: string;
  dbPath: string;
  workspaceRoot: string;
}
```

解析规则：

- command 必须严格等于 `chat`，否则抛 `CliConfigError`。
- `chat` 后所有 positionals 用单个空格连接并 trim；空结果为 `undefined`。
- `byte-mentor chat` 合法。
- `byte-mentor chat explain Promise` 得到 `initialMessage = "explain Promise"`。
- API key/model/db/workspace 规则保持不变。

### 3.2 Agent observer

保留 `onStreamEvent` 名称，明确它现在实时接收 provider 的全部事件，包括 `content_delta` 和 `done`：

```ts
export interface HeadlessTurnOptions {
  onStreamEvent?: (event: ProviderStreamEvent) => void;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
}
```

同样扩展 `AgentRunnerInput`。RuntimeEvent 必须在产生时 append 到内部数组并立即 observer；最终 `result.events` 顺序与 observer 顺序一致。

### 3.3 TUI public API

按 design 固定 `ByteMentorTuiOptions`、`ToolCallView` 与 `ByteMentorTui` 方法。允许增加只读测试辅助状态，但不得让 public API 引入 AgentLoop/SessionStore 类型。

### 3.4 Controller 状态

`apps/cli/src/interactive-chat-controller.ts` 作为私有应用层 controller，固定状态：

```ts
interface InteractiveChatState {
  sessionId?: SessionId;
  busy: boolean;
  exitAfterTurn: boolean;
  stopped: boolean;
}
```

任何时刻最多一个 active turn。首次 submit 不传 sessionId；每次有 result 后立即保存 result.sessionId；后续 submit 必须传它。

## 4. Batch 1：依赖、测试入口与许可基础

建议 commit：`feat(tui): add pi tui foundation`

### 范围

- `package.json`
- `pnpm-lock.yaml`
- `packages/tui/package.json`
- `vitest.config.ts`
- `tsconfig.test.json`
- `packages/tui/THIRD_PARTY_NOTICES.md`
- `test/tui/**` 的最小 public-import contract test

### RED

新增 `test/tui/public-api.test.ts`：

- 从 `@byte-mentor/tui` 导入预定 public API。
- 锁住 `ByteMentorTuiOptions` 不包含 AgentLoop/SessionStore。
- 测试初始失败于 public API 尚不存在。

### GREEN

- `packages/tui.dependencies` 新增精确版本：
  - `@earendil-works/pi-tui: "0.82.1"`
  - `chalk: "5.6.2"`
- 根 devDependencies 新增 `@xterm/headless: "5.5.0"`。
- 根 Node engine 改为 `>=22.19.0`。
- 使用 `pnpm install --ignore-scripts` 更新 lockfile。
- vitest alias 新增 `@byte-mentor/tui -> packages/tui/src/index.ts`。
- tsconfig.test paths/references 新增 TUI package。
- 添加 pi MIT attribution；说明底层依赖与适配视觉代码来源。
- 只实现能通过 contract 编译的最小真实 public 类型/类入口；不得放空方法占位。第一批 public class 只包含由下一测试驱动出的 start/stop 最小生命周期，若 50-200 行约束要求可把 public API contract 延后到 Batch 4，Batch 1 则只测试 dependency import。

### 验证

```bash
pnpm test test/tui/public-api.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

### Review 重点

- 依赖是否精确 pin。
- `@byte-mentor/tui` 是否仍不依赖 agent/session。
- 测试是否可以通过 package alias 导入。
- 是否保留 pi MIT 许可信息。

## 5. Batch 2：Provider stream 真正实时转发

建议 commit：`fix(agent): forward provider stream events in real time`

### 范围

- `packages/agent/src/runner/agent-runner.ts`
- `test/agent/agent-runner.test.ts`
- `test/agent/agent-loop.stream.test.ts`
- 必要时更新 `test/cli/run-chat.test.ts`

### RED 小步

1. 可控 async generator 在 yield 第一个 delta 后暂停；断言 `onStreamEvent` 已收到 delta，而 `run()` 尚未 resolve。
2. 断言 callback 顺序为 `content_delta... -> done`，done 也被转发。
3. tool-call iteration 后接 final iteration，断言两个 iteration 的 done 都转发且边界稳定。
4. provider 失败前已有 partial delta 时，partial delta 已被 observer 看见，runner 仍返回 failed。

### GREEN

- 删除 `invokeProvider()` 中延迟回放 `contentDeltas` 的逻辑。
- 在消费 provider async iterable 的同一循环中，按 yield 顺序立即调用 callback。
- content delta 与 done 都调用 callback。
- `invokeProvider()` 只保留最终 done/错误折叠职责。
- 不改变 checkpoint、newMessages、stopReason 或 tool 执行顺序。

### 验证

```bash
pnpm test test/agent/agent-runner.test.ts test/agent/agent-loop.stream.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

### Review 重点

- 是否在 provider yield 当下触发，而非 done 后批量回放。
- 是否把 done 暴露给调用方。
- 是否没有重复输出 final content。
- tool-call ReAct 多 iteration 是否有明确边界。

## 6. Batch 3：RuntimeEvent 实时 observer

建议 commit：`feat(agent): observe runtime events as they occur`

### 范围

- `packages/agent/src/loop/agent-loop.ts`
- `packages/agent/src/runner/agent-runner.ts`
- `test/agent/agent-loop.test.ts`
- `test/agent/agent-runner.test.ts`
- `test/agent/headless-turn.integration.test.ts`
- `test/agent/agent-loop.stream.test.ts`

### RED 小步

1. 类型测试锁住 `HeadlessTurnOptions.onRuntimeEvent` 与 `AgentRunnerInput.onRuntimeEvent`。
2. 无工具 turn：observer 收到的 event type 顺序等于 result.events。
3. 有工具 turn：在工具 promise 尚未 resolve 时已经收到 `tool.started`；完成后收到对应 terminal event。
4. 并发工具乱序完成时，observer 与 `result.events` 都按真实发生顺序记录；ToolMessage/checkpoint 仍按原始 call 顺序。
5. failed turn：收到 `turn.failed`，顺序仍与 result.events 相同。
6. 不传 observer 时所有原测试行为不变。

### GREEN

- AgentLoop 增加单一 `emitEvent(ctx, event)` helper：先 append，再同步 observer。
- AgentRunner 增加等价 helper，所有 model/tool event 在真实发生点通过该路径产生；`tool.started` 必须在等待 tool promise 前发出。
- AgentLoop 将 observer 传入 runner。
- runner 事件回到 AgentLoop 后不得再次 observer，避免重复；确定唯一所有权：runner 自己实时 observer 自己产生的事件，AgentLoop 只 observer 自己产生的 turn/context 事件。
- 最终数组拼接顺序必须与实时 observer 顺序一致。并发工具的事件数组从“按 call 顺序回收”改为“按真实发生顺序 append”，但 ToolMessage、working messages 与 checkpoint 的稳定 call 顺序不得改变。若现有 `ctx.events.push(...runnerResult.events)` 会导致重复，则在 stateRun 完成后只合并数组、不再次回调。

### 验证

```bash
pnpm test test/agent/agent-runner.test.ts test/agent/agent-loop.test.ts test/agent/headless-turn.integration.test.ts test/agent/agent-loop.stream.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

### Review 重点

- event 没有重复。
- observer 顺序与 result.events 一致。
- RuntimeEvent 仍不携带 ANSI、颜色或 TUI 状态。
- checkpoint 失败与工具并发语义无回归。

## 7. Batch 4：主题与基础视觉组件

建议 commit：`feat(tui): add pi-inspired chat components`

### 范围

- `packages/tui/src/theme.ts`
- `packages/tui/src/components/header.ts`
- `packages/tui/src/components/user-message.ts`
- `packages/tui/src/components/assistant-message.ts`
- `packages/tui/src/components/status.ts`
- `packages/tui/src/components/footer.ts`
- `packages/tui/src/index.ts`
- `test/tui/theme.test.ts`
- `test/tui/chat-components.test.ts`

### 固定视觉契约

- Header 使用 Byte Mentor 名称，不出现 pi branding。
- User message 使用 `Box` + Markdown + `userMessageBg`。
- Assistant message 使用无背景 Markdown，左右 padding 为 1。
- Assistant component 支持 `appendDelta()` 与 `complete(content)`；complete 的完整 content 是最终真值，不重复 delta。
- Status 支持 `idle | working | error | exit_pending`。
- Footer 宽屏显示 workspace/model/session/hints；窄屏按优先级移除 hints、session、workspace，只保留 model/status。
- 所有 `render(width)` 行的 visible width 不超过 width。

### RED 小步

1. theme 生成 dark/light MarkdownTheme 与 EditorTheme，token 完整。
2. User message 在 40/80 列渲染中文与 Markdown，宽度不越界。
3. Assistant delta 连续追加仍只有一个内容组件；complete 不重复。
4. Header 不含 pi 文案；Footer 宽窄降级确定。
5. working/error/exit pending 状态文本与颜色函数可渲染。
6. emoji、CJK、长 workspace path 的 visible width 安全。

### GREEN

- 从 pi palette 提取最小 dark/light token，不移植 schema、watcher、自定义主题加载或 syntax-highlight 系统。
- 使用 `chalk`/ANSI functions 构造 pi-tui Theme interfaces。
- 组件只接收 plain view data，不 import agent/session。
- 需要从 pi 适配的实质代码在第三方声明中明确来源。

### 验证

```bash
pnpm test test/tui/theme.test.ts test/tui/chat-components.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

### Review 重点

- 视觉接近 pi，但没有带入 pi runtime 概念。
- Markdown、CJK、emoji 和窄终端安全。
- assistant streaming 不重建 transcript 历史。

## 8. Batch 5：工具卡片与结果 reconciliation

建议 commit：`feat(tui): render live tool execution cards`

### 范围

- `packages/tui/src/components/tool-execution.ts`
- `packages/tui/src/tool-view-store.ts` 或等价内部状态文件
- `packages/tui/src/index.ts`
- `test/tui/tool-execution.test.ts`

### 固定行为

- 卡片状态：`pending | running | success | error`。
- 标题至少包含状态 glyph、tool name 和单行 args 摘要。
- pending/running/success/error 分别使用对应 background/token。
- output 默认最多显示有界预览；完整 ToolMessage 到达时覆盖早期 RuntimeEvent preview。
- 超长输出按完整行截断并显示省略提示，不直接切 ANSI/Unicode。
- 更新未知 toolCallId 时创建降级卡片，不抛异常。
- 多个并发工具按 assistant toolCalls 原始顺序固定排列，完成顺序不改变布局。

### RED 小步

1. tool call 初始卡片包含 name/args 且 pending。
2. running -> success/error 状态转换。
3. preview 被完整 result 覆盖。
4. 并发乱序完成不改变卡片顺序。
5. 未知 id 降级、非法/循环 args 安全 stringify。
6. 长输出、CJK 和 40 列宽度安全。

### GREEN

- 以 toolCallId 为 key 管理组件引用。
- safe stringify 失败时显示 `[unserializable arguments]`。
- 输出限制使用 code point/可见宽度 helper，不对序列化 ANSI 字符串硬切。

### 验证

```bash
pnpm test test/tui/tool-execution.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

## 9. Batch 6：Editor、完整 `ByteMentorTui` 与虚拟终端

建议 commit：`feat(tui): build interactive chat screen`

### 范围

- `packages/tui/src/components/chat-editor.ts`
- `packages/tui/src/byte-mentor-tui.ts`
- `packages/tui/src/index.ts`
- `test/tui/virtual-terminal.ts`
- `test/tui/byte-mentor-tui.test.ts`

### 固定布局

按顺序创建并长期保留：

1. Header。
2. Transcript container。
3. Status component。
4. Chat editor。
5. Footer。

每条 transcript 项按发生顺序 append。当前 streaming assistant 和 toolCallId map 是私有引用，不通过重扫渲染文本寻找组件。

### RED 小步

1. `start()` / `stop()` 幂等，start 设置 focus，stop 恢复 terminal。
2. Editor 提交 trim 后的非空文本并清空；空白不提交。
3. busy 时禁止第二次 submit；回到 idle 后重新允许。
4. append user、assistant delta、tool cards 的 scrollback 顺序正确。
5. `completeAssistantMessage()` 结束当前引用；下一轮创建新组件。
6. Ctrl+C/Ctrl+D 在 idle 触发 exit；busy Ctrl+C 只触发 exit-after-turn callback/状态。
7. 40x12、80x24、120x30 viewport 与 resize 不越界。
8. stop 后 cursor/bracketed paste 等终端状态恢复。

### GREEN

- 使用 pi-tui `TUI`、`Container`、`Editor`、`ProcessTerminal`、key helpers。
- 默认创建 ProcessTerminal；测试注入 VirtualTerminal。
- 不直接调用 `process.exit()`。
- 所有组件 mutation 后调用 requestRender。
- spinner/timer 在 complete、error、stop 路径全部 dispose。
- Editor busy 时视觉仍存在，但 onSubmit 不向外触发。

### 虚拟终端测试要求

- 参考 pi `packages/tui/test/virtual-terminal.ts`，只移植测试所需能力。
- 通过 `@xterm/headless` 验证 viewport/scrollback。
- 不复制整屏 ANSI snapshot；去 ANSI 后断言关键文本、顺序、行宽、cursor 状态。

### 验证

```bash
pnpm test test/tui/byte-mentor-tui.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

## 10. Batch 7：CLI 多轮 controller

建议 commit：`feat(cli): run continuous interactive chat`

### 范围

- `apps/cli/src/interactive-chat-controller.ts`
- `apps/cli/src/run-chat.ts`
- `apps/cli/src/config.ts`
- `apps/cli/src/index.ts`
- `test/cli/interactive-chat-controller.test.ts`
- `test/cli/config.test.ts`
- `test/cli/run-chat.test.ts`
- `test/cli/index.test.ts`

### Controller port

为测试定义最小 view port，形状与 `ByteMentorTui` public methods 一致。生产路径注入真实 TUI；测试注入 recorder fake。不得在测试里实例化真实 ProcessTerminal。

### RED 小步

1. config 接受无 initial message 的 `chat`，拒绝未知 command。
2. initial message 自动提交，但 controller 完成一轮后仍保持运行。
3. 第一轮 `runTurn({ userMessage })`；第二轮严格为 `runTurn({ userMessage, sessionId: firstResult.sessionId })`。
4. submit 后立即 append user + busy；结果后 idle。
5. busy 时第二次 submit 不调用 runTurn。
6. ProviderStreamEvent 映射：delta、done content、done toolCalls、下一 iteration assistant 边界。
7. RuntimeEvent 映射：tool started/completed/failed。
8. result.newMessages 中 ToolMessage 覆盖 preview；final message 不重复显示。
9. failed/max_iterations/throw 显示 error、恢复 idle，并允许下一轮。
10. idle exit 立即 stop/close；busy exit 设置 exitAfterTurn，结束后 stop/close。
11. 所有异常和重复 exit 路径 TUI stop/runtime close 各一次。

### GREEN

- `runChat()` 改为启动交互式 controller；可以保留函数名以减少 main public API 变化。
- `RunChatIO` 只用于 startup/config fatal fallback；正常 transcript 不写 stdout/stderr。
- controller callback 内部捕获 view mutation error，进入统一 fatal cleanup。
- `createRuntime()` 继续作为 CLI 唯一 runtime assembly，并保留 provider/sessionStore 可注入测试口。
- `runChat()` promise 在用户退出前不 resolve。
- normal exit code 0；startup/fatal 1；单轮失败不结束 app。

### Provider event 映射测试矩阵

- 纯 final text，有 deltas。
- fake provider 只有 done content，无 deltas。
- assistant content + tool calls。
- tool calls 无 content。
- 多个并发 tool calls 乱序结束。
- tool-call iteration 后 final text iteration。
- partial text 后 provider failed。

### 验证

```bash
pnpm test test/cli/config.test.ts test/cli/index.test.ts test/cli/run-chat.test.ts test/cli/interactive-chat-controller.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

### Review 重点

- 多轮是否复用同一个 sessionId。
- CLI 是否仍是唯一应用组装层。
- TUI package 是否没有 AgentLoop 依赖。
- runtime/view 关闭是否 exactly once。

## 11. Batch 8：端到端虚拟 TUI 验收

建议 commit：`test(cli): cover interactive tui workflow`

### 范围

- `test/cli/interactive-chat.integration.test.ts`
- 必要的共享 fake provider / virtual terminal test helper
- 只做为测试暴露所需的最小依赖注入，不增加产品 API

### 场景

使用 InMemorySessionStore、可控 fake streaming provider、真实 AgentLoop、真实 ToolRegistry、真实 ByteMentorTui、VirtualTerminal：

1. 启动 TUI。
2. 模拟输入第一条中文问题并 Enter。
3. provider 分两段 yield assistant content。
4. 断言第一段到达时 viewport 已更新，而 turn 尚未完成。
5. 完成第一轮，记录 sessionId。
6. 输入第二条问题；fake provider 断言 request.messages 包含第一轮 history。
7. 第二轮发出 read tool call，真实 registry 或最小 fake tool 返回结果。
8. 断言工具卡经历 pending/running/success，最终 transcript 有第二轮回答。
9. 断言两轮只有一个 session，history 顺序正确。
10. idle Ctrl+C，断言 TUI stop、store close、runChat resolve 0。

补充失败场景：

- provider 第二轮失败，界面出现 error，第三轮仍可提交并复用 session。
- 终端 resize 后 transcript/editor/footer 不越界。

### 验证

```bash
pnpm test test/cli/interactive-chat.integration.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

## 12. Batch 9：文档、全量回归与真实 smoke

建议 commit：`docs(cli): document interactive tui usage`

### 范围

- `README.md`
- 如实际行为需要，`.env.example`
- 本计划的“当前状态”与实施记录
- 不修改无关设计文档

### README 更新

- 将“一次性 smoke”描述改为交互式 TUI。
- 命令示例：

```bash
pnpm exec node apps/cli/dist/index.js chat
pnpm exec node apps/cli/dist/index.js chat "解释一下 Promise"
```

- 说明 initial message 会自动提交但不会退出。
- 说明退出键、busy 时退出行为、数据库位置和 session 生命周期。
- 删除“当前不实现 TUI/多轮 shell”的过时描述。
- 明确暂不支持跨进程 resume/session picker。

### 全量自动验证

依次运行并修复所有问题：

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

不得只运行 TUI 定向测试后宣告完成。

### tmux 手工 smoke

构建后在 80x24 tmux 中运行，使用用户现有环境变量；不要打印或记录 secret：

```bash
tmux new-session -d -s byte-mentor-tui -x 80 -y 24
tmux send-keys -t byte-mentor-tui "pnpm exec node apps/cli/dist/index.js chat" Enter
tmux capture-pane -t byte-mentor-tui -p
```

验证：

1. Header/editor/footer 初始布局正确。
2. 输入中文问题，assistant 内容逐步出现。
3. 连续输入第二个追问，回答能引用第一轮上下文。
4. 触发至少一个 workspace read-only tool，工具卡状态正确。
5. resize 到 40x15 后无 crash/横向越界，再恢复 100x30。
6. idle Ctrl+C 正常退出。
7. `.byte-mentor/byte-mentor.sqlite` 中只有本次启动创建的一个 session，含多轮 messages。
8. 进程退出后无残留 `-wal` / `-journal`，终端 raw mode/cursor 正常。

如果当前环境没有可用真实 API 配置，只跳过“真实 provider”一步，并明确报告；VirtualTerminal + fake provider 端到端测试仍必须完成。

完成 smoke 后杀掉测试 tmux session；只清理本次明确创建的 session，不删除用户其他 tmux session。

## 13. 最终完成定义

- [x] `packages/tui/src/index.ts` 不再是空导出。
- [x] `byte-mentor chat` 无消息可启动 TUI。
- [x] optional initial message 自动提交后仍保持交互。
- [x] 至少三轮连续对话复用同一 sessionId。
- [x] content delta 在 provider yield 时真实流式显示。
- [x] Provider done 与 RuntimeEvent 有实时 observer，且最终数组无重复/乱序。
- [x] 工具调用显示 pending/running/success/error，完整 ToolMessage 可覆盖 preview。
- [x] 用户/assistant Markdown/Editor/Footer 视觉接近 pi。
- [x] CJK、emoji、40 列窄终端与 resize 可用。
- [x] turn failure 不退出，下一轮仍可继续。
- [x] idle exit 与 busy exit-after-turn 都 exactly-once cleanup。
- [x] `@byte-mentor/tui` 不依赖 Agent/Session。
- [x] pi-tui/chalk/xterm 版本精确 pin，Node engine 已匹配。
- [x] pi MIT attribution 已保留。
- [x] README 与实际命令一致。
- [x] `pnpm test` 通过。
- [x] `pnpm typecheck` 通过。
- [x] `pnpm lint` 通过。
- [x] `pnpm format:check` 通过。
- [x] `pnpm build` 通过。
- [x] tmux smoke 完成或明确记录真实 API 不可用原因。

## 14. 明确不在本计划内

- 跨进程 session resume、session picker、重命名或删除。
- 多模型/provider selector、OAuth/login UI。
- 用户生成期间的 steer/follow-up queue。
- 中止正在进行的 provider/tool；第一版 busy Ctrl+C 采用 exit-after-turn。
- compaction、branch、fork、tree selector。
- Slash command/autocomplete 系统。
- 图片、剪贴板图片、外部编辑器。
- 自定义主题加载、主题切换或 theme watcher。
- pi extension system 或完整 InteractiveMode。
- Knowledge、Teaching Brief、Observation Log 的专属 UI。
- 对现有 Agent 状态机做与 observer 无关的重构。

## 15. 实施时禁止临时决策的检查表

以下内容已经固定，不应在新会话中再次提问：

- 包边界：CLI 组装，TUI 纯展示。
- 依赖方式：npm 发布版 pi-tui 0.82.1，不用本地 file path。
- 入口：`chat` 无消息可启动，有消息自动提交。
- session：进程内新建一个并复用，不做跨进程 resume。
- 并发输入：禁止，单轮串行。
- 退出：idle 立即退出，busy 当前轮后退出。
- 主题：启动时 dark/light 自动选择，无 selector。
- 工具：显示实时状态与有界输出，不做专属 renderer。
- callback：实时转发 provider 全事件和 RuntimeEvent。
- 测试：组件 + VirtualTerminal + CLI controller + integration。
- Git：无明确授权不 commit。

只有发现这些决策在现有依赖 API 中技术上不可实现，或需要改变 core message/session 持久化契约时，才停止并向用户提问。

## 16. 实施记录

- 2026-07-30：按 Batch 1-8 完成依赖、实时 observer、TUI 组件、工具卡、交互壳、CLI controller 与 headless 集成测试。
- 未执行 `git commit`，遵守本计划的 Git 约束。
- 2026-07-30：`pnpm test`（33 files / 286 tests）、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 全部通过。
- 2026-07-30：tmux 80×24 启动、40×15 / 100×30 resize 与 idle Ctrl+C 退出 smoke 通过；当前进程未配置 `OPENAI_API_KEY` / `BYTE_MENTOR_MODEL`，因此按计划跳过真实 provider smoke。
