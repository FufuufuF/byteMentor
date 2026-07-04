---
name: plan-driven-implementation
description: "当用户要求按 .agents/.plan/ 中的实现计划推进编码时触发。指导模型严格按 plan 的 commit 粒度,以小步 TDD 推进;在 plan 未覆盖的代码逻辑决策上强制提问,不允许默认;每小步暂停等待 review。"
---

# Plan-Driven Implementation

按顶级模型产出的 design + plan 文档,以小步 TDD 推进编码。本 skill 负责 commit 边界、提问节奏、review 节奏;TDD skill 负责单步内的 Red-Green-Refactor。

## 适用条件

触发本 skill 的前提:

- 用户消息包含"按 plan 实施 / 执行实现计划 / 按 plan 推进 / 实施 .agents/.plan 下的计划"等意图。
- 用户引用了 `.agents/.plan/*.md` 文件路径。
- 用户明确调用本 skill,且存在对应的 `.agents/.design/*.md` 与 `.agents/.plan/*.md`。

前置条件:

- 目标模块的 `.agents/.design/<module>-design.md` 必须存在。
- 目标模块的 `.agents/.plan/<module>-implementation-plan.md` 必须存在。
- 项目级 `.agents/.design/architecture-design.md` 若存在应一并读取。

缺失任何一份文档时,停止推进,要求用户先补齐 design 或 plan,不进入 Phase 1。

## 核心原则

1. **小步推进**:每一小步代码增量落在 50-200 行(测试+实现合计)。超出则拆分。
2. **双暂停**:每一小步在 RED 阶段写完测试后暂停、在 GREEN 阶段写完实现后暂停,等用户 review 确认后才推进。不允许连续推进多个小步。
3. **未覆盖决策强制提问**:plan 没明示的代码逻辑决策,无论多小,必须停下来用 `question` 工具提问。禁止使用"我假设..."、"按惯例..."这类默认推进。
4. **测试先行**:任何生产代码之前必须有失败测试。严格遵守 TDD skill 的 Iron Law。
5. **不引入 design 排除项**:每写一个文件前自检,是否触犯 design 的"不包含"列表。
6. **commit 粒度守恒**:一个 plan commit = 一个 git commit(若用户要求提交)。不许合并提交,也不许拆分提交(除非用户明确要求)。
7. **不允许"先把骨架搭起来"**:禁止先写空文件、空函数占位再填。每个文件的出现必须伴随一个失败测试。
8. **跨包依赖走 public API**:commit N 的测试需要 commit N-1 已交付的类型时,通过 `@byte-mentor/core`、`@byte-mentor/session`、`@byte-mentor/agent` 等 alias 导入。不允许直接 import 内部文件路径。

## 提问阈值

**必须提问(代码逻辑层)** — 影响跨文件、跨 commit、跨测试的决策:

- 数据结构形状(字段集、字段类型、是否 union、是否可选)
- 函数签名(参数、返回类型、异步性、抛异常 vs Result 类型)
- 控制流决策(何时写库、循环终止条件、错误传播路径)
- 状态机 / 边界条件(空值处理、默认值、计数语义、超限处理)
- 模块归属(哪个概念放哪个包、是否跨包暴露)
- 错误模型与错误类型层次

**不必提问(实现细节层)** — 只影响当前文件内部可读性:

- 变量名、私有函数名、参数名
- 文件内部代码组织顺序
- 局部 helper 函数抽取
- 简单条件判断写法
- 错误消息文本内容(只要错误类型已确认)
- 测试用例的具体数据(只要测试意图已确认)
- import 顺序、格式化(交给 prettier / eslint)

判定准则:影响跨文件、跨 commit、跨测试的决策必须确认;只影响当前文件内部可读性的细节不必确认。

## 工作流

### Phase 0: 加载上下文

并行读取:

- 目标模块的 `.agents/.design/<module>-design.md`
- 对应的 `.agents/.plan/<module>-implementation-plan.md`
- `.agents/.design/architecture-design.md`(若存在)
- 根 `package.json`、`vitest.config.ts`、`tsconfig.base.json`
- 目标包及其邻近包的 `package.json`、`tsconfig.json`、`src/` 现有代码(即便只有 `index.ts` 也要看约定)
- 现有 `test/` 目录结构(若存在)

输出一份不超过 30 行的上下文摘要,包含:

- 模块边界(本模块涉及的 workspace package)
- 本模块的 commit 列表(从 plan 抄)
- 当前包的代码现状(已有什么文件)
- 测试目录现状

确认理解后进入 Phase 1。

### Phase 1: 实施前澄清清单(强制)

这是本 skill 的核心。基于 design + plan 推导出候选方案,但必须以提问形式提交用户确认,不允许默认采用。

清单按四类组织:

#### A 类:类型契约

逐项给出候选 + 提问:

- Message 结构:discriminated union(按 role 分变体)还是扁平 interface?content 是 `string` 还是 `string | ContentPart[]`?toolCalls 字段形状?tool message 用什么字段回链 toolCallId?
- ID 类型策略:branded type(`SessionId` / `MessageId` / `ToolCallId` / `TurnId`)还是 `string`?
- RuntimeEvent 联合:每种事件具体携带哪些字段?是否有公共基字段(`type` + `turnId` + `ts`)?ts 是 `number` 还是 `Date` 还是不带?
- StopReason 枚举:变体集合(如 `completed` / `failed` / `max_iterations` / `tool_call`)?字面量联合还是 enum?
- 错误模型:抛异常 vs `Result<T, E>`?错误类层次?Provider 失败、工具失败、未知工具分别用什么形式?

#### B 类:接口签名

列出 plan 中出现的每个接口/类:

- `SessionStore`、`InMemorySessionStore`
- `ModelProvider`
- `AgentTool`、`ToolRegistry`
- `AgentRunner`
- `AgentLoop`、`ContextBuilder`
- `HeadlessTurnInput`、`HeadlessTurnResult`、`RuntimeEvent` 序列的返回方式

每个给出:

- 方法签名草案
- 返回类型
- 异步性(`Promise<T>` 还是同步)
- 用 `?` 标注不确定的点

#### C 类:行为语义

plan 没明说但实现必须确定的:

- 消息持久化时机(用户消息何时写入 session?turn 开始就写还是结束时一起写?assistant 中间消息、tool result、final assistant 是否都写入?)
- maxIterations 默认值与计数语义(计数的是"模型调用次数"还是"工具调用次数"?超限后 session 中已产生的消息怎么处理?)
- 空 / 边界情况的产品决策(Provider 返回既无 content 也无 toolCalls 时怎么处理?空工具列表允许吗?空 session 允许吗?)
- ContextBuilder 的具体职责边界(简单透传历史 + 新用户消息,还是注入 system prompt?输入是 `Session + userMessage` 还是 `Message[] + userMessage`?)

#### D 类:工程约定

从现有代码推导,告知用户不必逐项确认:

- 文件命名(`message.ts` vs `messages.ts`)、type vs interface 选择
- 测试文件组织(`test/core/message.test.ts` 镜像结构)
- 导出策略(只导出 public API 还是也导出测试需要的内部类型)
- 如果项目还没有足够代码可参考,降级为 C 类提问

**强制约束**:

- 清单必须用 `question` 工具逐项提交,不允许一次性 dump 然后继续。
- 用户未回答的项目,视为阻塞,不允许进入 Phase 2。
- 候选必须基于 design 的边界,不允许引入 design 明确排除的概念(如 agent-base 不许出现 Teaching Brief)。

### Phase 2: Commit 内 TDD 小步计划

在每个 commit 开始前,输出:

```
Commit N: <commit 名>
- Plan 目标:<从 plan 抄>
- 测试目标:<从 plan 抄>
- 拆解为 K 个 TDD 小步:
  1. <测试名> -> 覆盖<行为>
  2. <测试名> -> 覆盖<行为>
  ...
- 预计每小步新增/修改行数(目标 50-200)
- 本 commit 完成定义:全部小步绿 + typecheck + lint 通过
```

用户确认后才能进入 Phase 3。如果用户调整小步拆分,以用户调整为最终方案。

### Phase 3: 小步 TDD 循环

对每个小步,严格按 TDD skill 的 Red-Green-Refactor:

1. **RED**: 写一个失败测试。运行 `pnpm test <path>` 验证失败。
2. **暂停 A**: 把测试代码 + 失败输出提交用户 review。明确说"我在等你 review RED 阶段,确认后我写实现"。
3. **GREEN**: 用户确认后,写最小实现。运行 `pnpm test <path>` 验证通过。
4. **暂停 B**: 把实现代码 + 通过输出提交用户 review。明确说"我在等你 review GREEN 阶段,确认后我推进下一小步"。
5. **REFACTOR**(可选): 用户确认后,清理代码,再次验证。若重构则再次暂停 review。

**强制约束**:

- 每一小步在 RED 和 GREEN 阶段都必须暂停。不允许连续推进多个小步。
- 一小步的代码增量必须落在 50-200 行区间(测试+实现合计)。超出则要求拆分。
- 一小步内不许同时实现多个行为(测试名带 "and" 即视为拆分信号)。
- 实现过程中发现需要修改已确认的契约 → 立即停,回到 Phase 1 重新提问。

### Phase 4: Commit 收尾

当本 commit 的所有小步都绿后:

1. 跑全套: `pnpm test` + `pnpm typecheck` + `pnpm lint`。
2. 输出本 commit 的"完成报告":
   - 新增文件清单
   - 新增测试数
   - 行数统计
   - 是否触及 plan 范围外的文件
3. 等用户确认 → 提交(若用户要求)或继续下一 commit。
4. 进入下一 commit 前,回到 Phase 2。

### Phase 5: 模块完工验收

全部 commit 完成后:

1. 跑 `pnpm test` + `pnpm typecheck`。
2. 对照 plan 的"分支完成定义"或"完成定义"章节,逐条勾选。
3. 输出最终报告,告知用户可以进入下一模块。

## 与其他 skill 的协作

- **brainstorming**:本 skill 不替代 brainstorming。如果实施过程中发现 design 本身需要修改,停下滑出本 skill,建议用户切回 brainstorming。
- **test-driven-development**:本 skill 的 Phase 3 是 TDD skill 的封装。本 skill 负责"何时进入 TDD、commit 边界、review 节奏",TDD skill 负责"单步内 RED-GREEN-REFACTOR 怎么写"。

## 输出与交互约定

- **语言要求:模型的所有回复必须使用中文。** 包括提问、状态说明、review 暂停点的文字、完成报告等一切非代码输出。代码中的标识符、注释(若有)不受此限。
- Phase 1 的提问使用 `question` 工具,每类一组、逐项确认。
- Phase 2 / Phase 3 的暂停点用普通文本输出 + 等待用户回复。
- 每次暂停必须明确说明等待意图(如"我在等你 review 这一小步,确认后我继续")。
- 禁止输出长段解释性文字,代码 + 简短状态 + 等待。
- 不在代码中添加注释,除非用户明确要求。

## 失败模式(自我检查)

以下情况视为违反本 skill,必须停下:

- 跳过 Phase 1 的提问清单,直接进入编码。
- 一个小步的代码超过 200 行未暂停。
- RED 阶段未运行测试验证失败就进入 GREEN。
- GREEN 阶段未运行测试验证通过就进入下一小步。
- 用"我假设"、"按惯例"绕过未覆盖决策。
- 引入了 design 明确排除的概念(如 agent-base 出现 CLI、TUI、Knowledge、真实 Provider、持久化)。
- 先写空文件占位再填,而不是测试驱动文件出现。
- commit 完成后未跑全套 `pnpm test` + `pnpm typecheck` + `pnpm lint` 就宣告完成。

任何失败模式触发时,停下,回滚到上一个暂停点,向用户说明偏离情况,等待指示。
