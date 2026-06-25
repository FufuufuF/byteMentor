# Byte Mentor 记忆模块设计结论

## 1. 文档原则

本文档只记录当前已经达成共识的记忆模块设计结论。

尚未确定的内容不写入正式结论，后续讨论清楚后再补充。

## 2. 记忆模块的核心目标

Byte Mentor 的记忆模块不是普通聊天记录存储，也不是简单的笔记检索。

它的核心目标是：

> 把用户学习过程中的表现沉淀成 AI 可读取、可更新、可用于后续教学决策的长期知识状态。

当前需要区分两个概念：

- 全局知识图谱：为教学规划和记忆召回服务的知识节点与关系索引，不追求覆盖整个计算机知识体系。
- 用户知识状态：某个用户对某个知识点的掌握情况，是长期记忆真正承载的内容。

因此，系统关注的不是“计算机世界中所有知识点之间的完整关系”，而是围绕用户学习状态回答：

- 用户学过什么
- 用户没学过什么
- 用户在哪些知识点上存在误解
- 用户哪些知识点掌握不稳定
- 用户的某个薄弱点会影响哪些后续学习
- 用户已有知识能否帮助理解新知识
- AI 下次教学时应该参考哪些历史状态

## 3. 当前确定的分层结构

当前记忆模块分为四个正式层：

1. 知识目录索引层（CatalogIndex）
2. 知识图谱层（KnowledgeGraph）
3. 用户知识状态层（UserKnowledgeState）
4. 用户可读笔记层（UserReadableNote）

其中：

- 知识目录索引层负责通过路径稳定定位知识点 ID。
- 知识图谱层负责描述知识点之间的全局关系，并作为召回相关知识状态的关系索引。
- 用户知识状态层负责记录某个用户对某个知识点的长期掌握状态。
- 用户可读笔记层主要服务用户复习。
- 用户知识状态层和用户可读笔记层可以互相引用，但不应该混成同一个结构。

Observation Log 是会话过程中的证据记录，服务会话结束后的统一更新，不属于以上四个正式层之一。

## 4. 知识目录索引层（CatalogIndex）

知识目录索引层按照类似教科书目录的方式组织知识点路径。

示例：

```text
JavaScript
  异步
    Promise
    async/await
    Event Loop
  对象
    原型链
    this
    继承
```

这一层的职责是提供稳定、低成本的定位入口。

它回答的是：

> 用户给出的学习目标，对应知识图谱中的哪个 knowledgeNodeId？

知识图谱中的 `belongs_to` 关系本身可以隐含目录结构，但如果每次都从图中遍历目录，会产生额外成本，也会让 LLM 更难稳定拿到单个知识点的 ID。

因此，当前确定显式维护一层 CatalogIndex，作为性能优化和稳定定位入口。

CatalogIndex 只做索引，不表达复杂语义关系，也不直接表达用户掌握情况。

它主要索引：

- 路径到 `knowledgeNodeId` 的映射
- 当前节点的展示路径
- 当前节点的直接父级目录项
- 当前节点是 `topic` 还是 `learning_unit`

初版结构示例：

```ts
type CatalogEntry = {
  id: string

  knowledgeNodeId: string

  path: string[]
  pathKey: string

  name: string
  kind: "topic" | "learning_unit"

  parentCatalogEntryId?: string

  status: "draft" | "active" | "deprecated"
}
```

查询用户状态时，路径是：

```text
pathKey
  -> CatalogEntry
  -> knowledgeNodeId
  -> UserKnowledgeState(userId, knowledgeNodeId)
```

后续可以用 JSON 文档、MongoDB、SQLite、Postgres JSONB 或其他形式维护。当前不绑定具体数据库。

## 5. 知识图谱层（KnowledgeGraph）

知识图谱层描述知识点本身以及知识点之间的全局教学关系。

它不是用户个人状态，也不是完整百科知识图谱。

它的主要作用是：

- 定义知识点节点
- 表达知识点之间的关系
- 在生成 Teaching Brief 时决定应该读取哪些用户知识状态
- 在会话中单节点加载时提供该节点的局部上下文

当前确定采用“点和边分开维护”的方式：

```text
KnowledgeNode
KnowledgeEdge
```

邻接表、children 列表、完整 path 等结构都可以作为派生索引或缓存，但不作为唯一事实来源。

### 5.1 KnowledgeNode

KnowledgeNode 只描述“这个知识点是什么”，不存用户掌握状态，也不直接存父子关系。

当前确定的节点类型有两种：

```ts
type KnowledgeNodeKind = "topic" | "learning_unit"
```

`topic` 是任意深度的目录或章节节点。

示例：

```text
JavaScript
JavaScript / 异步
JavaScript / 异步 / async/await
计算机网络
计算机网络 / 传输层
计算机网络 / 传输层 / TCP协议
```

`learning_unit` 是可教学、可测评、可记录用户掌握状态的最小学习单元。

示例：

```text
await 的暂停与恢复
await 后续代码进入微任务
TCP 三次握手过程
this 的调用位置绑定规则
```

判断一个节点是否应该是 `learning_unit` 的标准是：

> 它能否被单独教学、单独追问、单独答错、单独记录误解，并单独影响后续教学。

如果一个节点下面还能自然拆出多个可独立教学和测评的单元，它更适合作为 `topic`。

因此：

- `函数` 通常是 `topic`
- `this 绑定规则` 通常是 `learning_unit`
- `TCP协议` 通常是 `topic`
- `TCP 三次握手过程` 通常是 `learning_unit`

KnowledgeNode 初版字段：

```ts
type KnowledgeNode = {
  id: string

  kind: "topic" | "learning_unit"

  name: string
  definition: string

  learningGoals?: string[]

  noteRef?: {
    type: "markdown" | "database"
    target: string
  }

  difficulty?: "intro" | "basic" | "intermediate" | "advanced"

  createdAt: string
  updatedAt: string
}
```

字段说明：

- `id`：知识节点稳定 ID，供边、用户状态和笔记引用。
- `kind`：节点类型，区分 `topic` 和 `learning_unit`。
- `name`：当前节点名，只表示最近一级名称，不表示完整路径。
- `definition`：节点边界的一句话定义。
- `learningGoals`：学习目标，主要用于 `learning_unit`。
- `noteRef`：指向该知识点的通用用户可读笔记，可以是 Markdown 路径，也可以是数据库 ID。
- `difficulty`：大致教学难度。
- `createdAt` / `updatedAt`：创建和更新时间。

当前确定不在 KnowledgeNode 中维护 `aliases`。

当前也不使用自由发挥式的 `scope.includes/excludes` 作为核心字段。节点边界主要由 `definition` 和 `learningGoals` 共同约束。

当前确定不在 KnowledgeNode 初版中维护以下字段：

- `assessmentPrompts`：测评题或追问更像教学素材，可以由 agent 根据 `definition` 和 `learningGoals` 临时生成，不作为知识节点核心字段。
- `commonMisconceptions`：全局常见误解容易和 UserKnowledgeState 中的用户个人误解混淆，初版不放入 KnowledgeNode。
- `nonGoals`：节点边界初版先由 `definition` 和 `learningGoals` 控制，不额外维护排除范围字段。
- `status`：KnowledgeNode 初版不维护节点状态字段，先降低结构复杂度。

### 5.2 KnowledgeEdge

KnowledgeEdge 描述知识点之间的关系。

当前确定 KnowledgeEdge 的主要目的不是表达完整知识语义，而是在教学某个知识点时，帮助系统显式提示 LLM 还应该关注哪些可以顺带提一下或需要预先检查的知识点。

初版结构：

```ts
type KnowledgeEdgeType =
  | "belongs_to"
  | "prerequisite_of"
  | "mention_with"

type KnowledgeEdge = {
  id: string

  type: KnowledgeEdgeType

  sourceNodeId: string
  targetNodeId: string

  reason?: string

  createdAt: string
  updatedAt: string
}
```

字段说明：

- `id`：边的稳定 ID，供更新、引用和调试使用。
- `type`：边的关系类型，决定这条边在生成 Teaching Brief 时如何影响相关知识点召回。
- `sourceNodeId`：边的起点知识节点 ID。
- `targetNodeId`：边的终点知识节点 ID。
- `reason`：可选字段，用一句话说明为什么需要这条边，尤其是 `mention_with` 边需要写清楚具体教学理由。
- `createdAt` / `updatedAt`：创建和更新时间。

当前确定不在 KnowledgeEdge 初版中维护以下字段：

- `weight`：初版不做权重排序，避免过早引入复杂召回策略。
- `status`：初版不维护边状态字段，先降低结构复杂度。
- `source`：初版不记录边由系统、人工还是 LLM 创建；是否需要审核和溯源后续再设计。

当前确定的边类型只有三种：

- `belongs_to`：目录从属关系。表示 `sourceNodeId` 属于 `targetNodeId`。方向统一为 `child -> parent`。它用于组织知识结构，不直接表示教学依赖。
- `prerequisite_of`：前置知识关系。表示学习 `targetNodeId` 前，最好先掌握 `sourceNodeId`。生成 Teaching Brief 时，如果目标是 `targetNodeId`，系统应该优先读取 `sourceNodeId` 的用户知识状态。
- `mention_with`：顺带提示关系。表示教学 `sourceNodeId` 时，值得顺带提一下 `targetNodeId`。它不是泛泛的相关关系，也不表示前置依赖，而是一个有方向的教学提示边。

`mention_with` 的定义是：

> 当教学 `sourceNodeId` 时，系统应该提示 LLM 可以顺带提一下 `targetNodeId`，因为这个提示能让当前知识点更容易理解、更不容易误解，或更容易建立边界。

`mention_with` 的建边标准必须严格：

- 这条边必须改变教学行为。如果加不加这条边，Teaching Brief 都不会变化，则不建边。
- 不能只是“同属一个大类”。目录归属已经由 `belongs_to` 表达。
- 不能只是“有共同点”。必须能说清楚教学 `sourceNodeId` 时提到 `targetNodeId` 是为了完成一个具体教学动作。
- `reason` 必须能写成一句具体教学理由。如果写不出具体理由，则不建边。
- 初版建议限制每个节点的 `mention_with` 出边数量，例如最多 3 条，避免图谱因为主观“相关性”而膨胀。

当前确定以下原则：

- 边是独立结构，不嵌入 KnowledgeNode。
- `belongs_to` 用于表达目录从属关系。
- `belongs_to` 的方向统一为 `child -> parent`。
- `prerequisite_of` 用于表达前置知识关系。
- `mention_with` 用于表达教学时可以顺带提示的知识点。
- 不使用 `related_to` 这类过宽泛的关系类型，避免图谱被低价值连接污染。

示例：

```text
异步 -> belongs_to -> JavaScript
async/await -> belongs_to -> 异步
await 的暂停与恢复 -> belongs_to -> async/await
TCP协议 -> belongs_to -> 传输层
TCP 三次握手过程 -> belongs_to -> TCP协议

Promise.then 回调进入微任务 -> prerequisite_of -> await 后续代码进入微任务

并发 -> mention_with -> 并行
await 后续代码进入微任务 -> mention_with -> Promise.then 回调进入微任务
```

KnowledgeGraph 可以隐含目录结构，但 CatalogIndex 仍然显式存在，原因是它提供更直接、更稳定的路径定位能力。

## 6. 用户知识状态层（UserKnowledgeState）

用户知识状态层是 AI 读的核心长期记忆。

它不是全局知识图谱，而是围绕某个用户逐渐生长出来的个人知识掌握状态集合。

一个知识点进入用户知识状态层，通常来自：

- 用户主动学习了这个知识点
- 用户在学习其他内容时暴露出这个知识点的缺失
- 用户在问答、复述或模拟面试中暴露了相关误解
- agent 判断该知识点是后续学习的关键前置

因此，用户知识状态层不应该只包含“已经学过”的知识点，也可以包含：

- 未学但已暴露为前置缺失的知识点
- 被提到但尚未系统学习的知识点
- 影响当前学习效果的薄弱知识点

用户知识状态不是抽象知识本身，而是：

> 某个用户对某个 knowledgeNodeId 的掌握状态。

示例：

```text
状态：用户 A 对 async/await 的掌握状态
- 对应 KnowledgeNode：JavaScript / 异步 / async/await
- 当前状态：学过但不稳定
- 误解：容易把 await 后续代码理解成同步继续执行
- 证据：2026-06-11 模拟面试中跳过 async/await 输出题
- 下次教学提示：先回顾 Promise.then 微任务，再讲 async/await 的恢复机制
```

初版可以按 `(userId, knowledgeNodeId)` 建立唯一状态记录。

这一层应该至少能表达：

- 用户是否接触过该知识点
- 当前掌握是否稳定
- 已知误解
- 相关证据
- 最近一次学习或测评时间
- 下次教学提示
- 用户个人笔记引用

具体字段后续单独设计。

## 7. 用户可读笔记层（UserReadableNote）

用户可读笔记单独维护。

它面向用户复习，不直接等同于 AI 读的知识状态。

用户可读笔记应该追求：

- 清晰
- 简洁
- 适合复习
- 适合面试或考试前快速回顾

示例：

```markdown
# async/await 面试笔记

## 一句话总结

async/await 是基于 Promise 的异步控制流语法糖。

## 核心回答

...

## 常见误区

- await 不会阻塞整个线程，只会暂停当前 async 函数。
- await 后续代码会进入微任务队列。
```

KnowledgeNode 中的 `noteRef` 指向该知识点的通用笔记入口。

用户个人笔记应该由用户可读笔记层或 UserKnowledgeState 中的个人 `noteRef` 引用，不应该和通用笔记混在一起。

## 8. 四层结构之间的关系

当前确定的关系是：

```text
CatalogIndex
  pathKey -> knowledgeNodeId
    ↓
KnowledgeGraph
  KnowledgeNode + KnowledgeEdge
    ↓
UserKnowledgeState
  userId + knowledgeNodeId
    ↔
UserReadableNote
```

具体含义：

- CatalogIndex 负责从路径稳定定位 `knowledgeNodeId`。
- KnowledgeGraph 负责用 `knowledgeNodeId` 描述全局知识节点和关系。
- UserKnowledgeState 负责记录某个用户在某个 `knowledgeNodeId` 上的长期状态。
- UserReadableNote 负责用户可读复习材料。
- KnowledgeGraph 本身也能通过 `belongs_to` 推导目录结构，但 CatalogIndex 是为了性能和稳定定位而显式物化的索引层。
- 用户知识状态层和用户可读笔记层可以互相引用，但不能混为一个结构。

这样分离的原因是：

- LLM 需要稳定、低成本地从学习目标定位到知识点 ID。
- 知识图谱需要表达关系，但不应该承载具体用户状态。
- 用户知识状态要适合检索、更新和教学决策。
- 用户可读笔记要适合人读。
- 如果混在一起，容易导致笔记对用户太碎、对 AI 又不够结构化。

### 8.1 Agent 使用分层记忆的基本方式

当前确定：agent 不应该直接自由遍历整个知识图谱。

更合理的方式是：

```text
用户提出学习目标
  ↓
CatalogIndex 定位目标 knowledgeNodeId
  ↓
KnowledgeGraph 查找目标节点相关的节点集合
  ↓
系统批量读取这些节点对应的 UserKnowledgeState
  ↓
系统生成 Teaching Brief
  ↓
agent 根据 Teaching Brief 教学
```

也就是说，知识图谱不直接作为一大段上下文塞给 agent，而是作为关系索引，帮助系统决定应该读取哪些用户知识状态。

最终进入 agent 上下文的是整理后的 Teaching Brief。

## 9. Teaching Brief

Teaching Brief 是会话开始前根据 CatalogIndex、KnowledgeGraph 和 UserKnowledgeState 生成的教学上下文。

它的作用类似 coding agent 中的 plan：先确定当前教学应该如何展开，再进入正式教学。

Teaching Brief 应该帮助 agent 判断：

- 当前要教什么
- 用户此前是否接触过相关知识
- 用户有哪些已知薄弱点
- 用户有哪些历史误解
- 是否存在需要先补的前置知识
- 是否存在可用于类比的已掌握知识
- 本轮教学应该重点讲什么、跳过什么、追问什么

示例：

```text
目标知识点：JavaScript / 异步 / async-await

相关用户状态：
- Promise：学过，但链式调用细节不稳定
- Event Loop：学过，能说宏任务/微任务，但输出题不稳定
- async/await：曾在模拟面试中跳过输出题
- Python asyncio：用户有一定背景，可考虑轻度类比

本次教学建议：
- 不要从“什么是异步”开始讲
- 先快速确认 Promise.then 和微任务
- 可以使用 Python coroutine 做类比
- 最后必须做一道执行顺序题
```

## 10. 会话中的记忆加载机制

当前确定的加载机制：

```text
会话开始前：重加载
会话进行中：默认不查全量记忆，只在必要时定点查询
会话结束后：统一更新 UserKnowledgeState 和用户可读笔记
```

### 10.1 会话开始前重加载

用户提出学习目标后，系统先通过 CatalogIndex 定位目标 `knowledgeNodeId`。

然后系统通过 KnowledgeGraph 查找相关节点集合，例如：

- 目标节点自身
- 目标节点的父级 topic
- 目标节点下的直接 learning_unit
- 目标节点的前置节点
- 目标节点的易混淆节点
- 目标节点的可类比节点

最后系统批量读取这些节点对应的 UserKnowledgeState。

读取结果会被压缩成 Teaching Brief。

agent 后续主要依据 Teaching Brief 进行教学。

### 10.2 会话中默认不频繁检索

正常教学过程中，agent 不应该每轮回答前都检索全量知识图谱或全量用户状态。

原因：

- Teaching Brief 已经覆盖当前会话主要上下文
- 每轮检索成本高
- 每轮检索会让教学行为不稳定
- 大量历史记忆可能污染当前教学重点

### 10.3 会话中允许定点查询

如果教学过程中出现明确触发条件，可以定点查询记忆。

触发条件示例：

- 用户主动跳到新知识点
- 用户暴露出明显前置知识缺失
- 用户提到自己学过某个相关知识
- 当前 Teaching Brief 不足以支撑继续教学

会话中的单节点加载路径是：

```text
目标路径或目标名称
  -> CatalogIndex
  -> knowledgeNodeId
  -> KnowledgeNode / 局部 KnowledgeEdge
  -> UserKnowledgeState(userId, knowledgeNodeId)
  -> Node Brief
```

## 11. 会话中的观察日志

会话过程中不应该频繁直接修改正式 KnowledgeGraph 或 UserKnowledgeState。

但 agent 需要在关键教学事件发生时记录 Observation Log。

Observation Log 是学习过程中的观察记录，用于防止重要学习证据丢失，并为会话结束后的统一更新提供材料。

适合记录 Observation Log 的事件包括：

- 用户完成一次复述
- 用户答错一个关键追问
- 用户主动表示不懂
- 用户提出暴露认知结构的问题
- 用户纠正了之前的误解
- 用户跳过某个知识点
- agent 发现用户存在前置知识缺失

Observation Log 不等于正式用户知识状态。

它只是会话中的过程性证据。

## 12. 会话结束后的统一更新

会话结束后，系统根据本轮教学过程和 Observation Log，统一更新：

- UserKnowledgeState
- 用户可读笔记

写回的内容不应该是完整聊天记录，而应该是学习状态变化。

示例：

```text
async/await:
- 本次学习完成
- 用户能解释 await 会暂停当前 async 函数
- 用户仍然卡在 await 后续代码进入微任务
- 下次建议从事件循环输出题开始复测

Promise:
- 作为前置知识被复测
- Promise.then 回调时机回答正确
```

## 13. 当前 MVP 暂不处理的中断场景

当前先不处理以下 hack 场景：

> 用户学习某个主题到一半后退出，然后在新会话中学习另一个相关主题，此时未完成学习产生的临时观察如何参与新会话检索。

因此，当前 MVP 的简化假设是：

- Observation Log 主要服务当前会话结束后的统一更新。
- 未完成会话的跨主题弱召回暂不作为当前设计目标。
- 当前先优先跑通完整学习会话后的状态更新闭环。

## 14. 下一步重点问题

下一步最重要的问题是：

> UserKnowledgeState 的具体结构应该如何设计，以及 KnowledgeEdge 的创建规则如何落地？

待讨论内容包括：

- 哪些边可以由系统规则生成
- 哪些边可以由 LLM 提议
- LLM 提议的边是否需要审核或置信度
- KnowledgeGraph 中的全局关系和 UserKnowledgeState 中的个人状态如何区分
- 如何避免 LLM 自由发挥导致图谱污染
- 如何让边真正影响 Teaching Brief
- UserKnowledgeState 需要哪些字段来支撑会话开始重加载和会话中单节点加载
