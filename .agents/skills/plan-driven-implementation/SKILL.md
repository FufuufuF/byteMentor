---
name: plan-driven-implementation
description: "当用户要求按 .agents/.plan/ 中的实现计划推进编码时触发。严格按 plan 的 Batch 顺序实施；每个 Batch 开始前阐述目标、范围、完成标准和全部计划测试用例，等待用户明确确认后再按 TDD 连续开发至 GREEN；对 design/plan 未覆盖的关键逻辑决策强制提问，并在 Batch 边界 review 和提交。"
---

# Plan-Driven Batch Implementation

按已确认的 design 和 plan 推进实现。以 Batch 作为开发、验证、review 和建议 commit
边界，不再拆成 50–200 行小步，也不在单个测试的 RED/GREEN 阶段暂停。

本 skill 负责计划顺序、Batch 门禁、设计缺口和交付节奏；
test-driven-development skill 负责 Batch 内的测试先行、RED、GREEN、重构和验证。

## 前置条件

开始前确认：

- 用户给出了 .agents/.plan/*.md，或明确指出要执行的计划。
- plan 引用的 design 文档存在。
- 当前 Git 分支与计划目标一致；不一致时先报告，不擅自切换。
- 上游分支、接口冻结点和前置 Batch 已满足。
- 工作区现有修改已识别并可安全保留。

缺少必要 design、plan、上游契约或正确分支时停止，不进入编码。

## 核心规则

1. **Plan 决定范围和顺序**：按 plan 中的 Batch 顺序推进，不跳批、不合批、不把后续
   行为提前实现。旧计划若只写 Commit，则一个 Commit section 视为一个 Batch。
2. **每个 Batch 单独批准**：开始前必须向用户说明目标、范围、完成标准和每个计划测试
   用例，并等待明确确认。对未来 Batch 的笼统授权不能替代本次 briefing 后的确认。
3. **Batch 内连续 TDD**：确认后一次完成整个 Batch 的测试集 RED、生产实现 GREEN、
   重构和验证；不按单测试、单文件或 RED/GREEN 阶段暂停。
4. **关键设计缺口必须提问**：design/plan 未覆盖且会改变公共契约、持久化、顺序、错误
   或跨模块边界的决策不得默认。一次只问一个聚焦问题。
5. **已确认设计不重复讨论**：设计已经明确的字段、接口和行为直接执行，不重新发起偏好
   选择。
6. **保持 GREEN**：每个 Batch 结束时相关测试和计划要求的检查全部通过。不得以部分
   GREEN 或“后续 Batch 再修”交付。
7. **Batch 与提交一致**：一个 Batch 对应一个建议 git commit。只有用户明确授权后才能
   提交；不把多个 Batch 合成一个提交，也不把一个 Batch 拆成微提交。
8. **遵守模块边界**：跨包只使用 public API，不直接 import 其他 package 的内部路径。
9. **不实现排除项**：design/plan 明确暂缓或不包含的能力不得顺手加入。

## 工作流

### Phase 0：加载上下文

在任何测试或生产代码编辑前，完整读取：

- 目标 implementation plan；
- plan 引用的 design、总索引和上游计划；
- test-driven-development/SKILL.md；
- 项目架构文档（若存在）；
- 根配置、目标 package 配置、相关源码和现有测试；
- 当前分支、最近提交和工作区状态。

输出简短上下文摘要：

- 当前分支和目标模块；
- Batch 列表及当前要执行的 Batch；
- 已冻结的上游接口和模块边界；
- 当前源码/测试基线；
- 发现的阻塞或设计缺口。

Phase 0 只允许只读检查。

### Phase 1：设计覆盖审计

对当前 Batch 逐项比较 design、plan 和现有代码。

必须提问的缺口包括：

- 公共数据结构、字段、类型或可选性；
- public API 的参数、返回值、异步性或错误形式；
- 数据库 schema、事务、持久化时机或恢复语义；
- 并发、排序、状态机、计数和边界条件；
- 模块归属、跨包依赖和公开范围；
- 错误分类、重试、取消和降级行为；
- 会改变用户可观察结果的未定义行为。

可以自行决定：

- 私有变量、helper 和文件内组织；
- 已有模块边界内的具体文件名；
- 不影响契约的测试数据；
- 等价的局部控制流写法；
- import 顺序、格式化和 lint 修复；
- design 未固定的内部错误文案。

若存在必须提问的缺口，先解决全部阻塞，再进入 Batch briefing。不得用“按惯例”或隐含
假设绕过。

### Phase 2：Batch Briefing 与确认门禁

每个 Batch 开始前向用户输出：

~~~text
Batch N：<名称>

目标
- <完成后新增的用户可见行为或架构边界>

范围
- 可能涉及的模块/文件
- 重要边界
- 明确不做的内容

完成标准
- <可观察验收行为>
- <计划执行的验证命令>

测试用例
1. <测试名称或稳定标识>
   - 场景/前置条件：
   - 输入/操作：
   - 预期结果：
   - 验证的契约或风险：
2. ...
~~~

测试用例清单必须包含当前 Batch 计划新增或实质修改的每个测试 case，不得只列测试文件
或宽泛测试主题。

输出后明确请求用户确认并停止。用户明确确认前，不得：

- 写或修改测试、fixture 和生产代码；
- 创建生成产物或实现骨架；
- 暂存、提交或推送实现修改。

用户要求调整时，更新 briefing 并再次等待确认。

### Phase 3：执行完整 Batch

获得确认后，严格使用 test-driven-development skill：

1. 按已批准的测试清单写完整 Batch RED 测试集。
2. 运行测试并确认新/变更行为因预期原因失败。
3. 连续实现整个 Batch，直到全部目标测试 GREEN。
4. 在 GREEN 状态下重构，不扩大 Batch 范围。
5. 运行受影响回归和 plan 要求的检查。

执行期间不为单个测试、单个文件或中间 GREEN 暂停 review。

出现以下情况必须暂停：

- 需要新增批准清单之外的测试场景；
- 实现需要改变 briefing 中的目标、范围或完成标准；
- 暴露新的关键设计缺口；
- 上游契约与计划不兼容；
- 无法安全保留工作区中的用户修改。

暂停时说明差异和影响。新增测试先补充 test delta，获得用户明确确认后再继续。

### Phase 4：Batch 收尾与 Review

Batch GREEN 后：

1. 运行 Batch targeted tests、受影响回归测试和 plan 指定的 typecheck、lint、format、
   build 或全量测试。
2. 检查 diff 是否越界、是否新增 test-only production API、是否误改公共导出。
3. 输出完成报告：
   - 完成的能力；
   - 主要文件/模块；
   - RED 证据；
   - GREEN 与回归命令；
   - 与 plan 的偏差、风险和后续工作；
   - 当前 Git 状态。
4. 等待用户 review。
5. 用户已明确授权提交时，以该 Batch 的建议 commit 信息创建一个 commit；否则保持未
   提交。

开始下一个 Batch 时必须重新进入 Phase 1 和 Phase 2。即使用户授权连续开发，也不能
跳过下一 Batch 的 briefing 和明确确认。

### Phase 5：模块完成验收

全部 Batch 完成后：

1. 运行 plan 的分支完成检查。
2. 对照完成标准逐条核验。
3. 确认旧 API、临时兼容层和 deferred cleanup 已按计划处理。
4. 输出最终报告并等待用户决定合并、推送或进入下游分支。

## Git 与安全边界

- 开始前检查 branch 和 dirty worktree；用户修改默认保留。
- 不擅自创建、切换、rebase、merge 或 push 分支。
- 不使用 destructive reset/checkout 清理用户修改。
- commit、push、PR、merge 均需要用户请求或明确授权。
- Batch 未 GREEN、用户未 review 或提交内容混入无关修改时不得提交。

## 与其他 Skill 的协作

- **test-driven-development**：必须使用。PDI 定义 Batch 顺序与确认门禁；TDD 定义
  Batch 内 test-first 执行。发生冲突时，以更严格的“先 briefing、等确认、再写完整
  Batch RED”门禁为准。
- **brainstorming**：实现暴露设计问题时停止编码，回到设计讨论；确认并更新 design/
  plan 后再恢复 PDI。

## 输出要求

- 所有非代码回复使用中文。
- 说明应便于用户跟上进度，但避免复制整份 design/plan。
- 提问一次只处理一个会阻塞实现的关键决策。
- 每个等待点明确说明正在等待用户确认什么。

## 失败模式

出现以下任一情况时立即停止并说明偏离：

- 未完成 Batch briefing 或未获明确确认就编辑测试/实现；
- briefing 未逐个列出计划测试 case；
- 用小步行数限制拆分 Batch；
- 在单个 RED/GREEN 或单测试后要求 review；
- 未验证完整 Batch RED 就开始生产实现；
- 新增未批准测试或扩大 Batch 范围；
- 用默认假设绕过关键设计缺口；
- 引入 design 排除项或跨包内部 import；
- Batch 未 GREEN 就提交或进入下一 Batch；
- 未经授权提交、切换分支、推送或创建 PR。
