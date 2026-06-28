# LLM Wiki：从原始语料到 Wiki，以及检索策略

本文只保留两条主线：

1. 这个项目如何把原始语料转成 wiki，尤其是不同知识单元之间如何建立联系。
2. 这个项目在聊天/讲解时如何检索召回 wiki。

## 1. 原始语料如何转为 Wiki

LLM Wiki 的核心不是传统 NLP 规则抽取，而是一个 LLM 驱动的两阶段摄入流程：

```text
导入原始文件
  -> 复制到 raw/sources/
  -> 加入 ingest queue
  -> autoIngest 读取 source/schema/purpose/index/overview
  -> Stage 1：LLM 做结构化分析
  -> Stage 2：LLM 输出 FILE blocks
  -> 程序解析、清洗、校验、合并并写入 wiki
```

核心实现主要在：

```text
src/lib/source-lifecycle.ts
src/lib/ingest-queue.ts
src/lib/ingest.ts
src/lib/page-merge.ts
```

### 1.1 项目里的三层内容

一个项目里大致有三类内容：

```text
raw/sources/        原始导入文件
wiki/sources/       每份原始文件的 source summary 页面
wiki/concepts/      跨 source 沉淀出来的概念页面
```

还有其他 wiki 页面类型：

```text
wiki/entities/      人、组织、工具、产品等实体
wiki/synthesis/     跨来源综合
wiki/queries/       开放问题
wiki/comparisons/   对比分析
wiki/index.md       wiki 目录
wiki/overview.md    全局概览
wiki/log.md         摄入记录
```

`raw/sources/` 是原始语料层。`wiki/*` 是 LLM 从语料中整理出的知识层。

### 1.2 Source 页面和 Concept 页面的区别

Source 页面是“某份原始文件的摘要页”。

如果原始文件是：

```text
raw/sources/learning/memory-methods.md
```

程序会先计算它的 source identity：

```text
learning/memory-methods.md
```

再生成一个稳定的 source summary 路径：

```text
wiki/sources/<stable-source-slug>.md
```

这个路径由程序固定。即使 LLM 输出了别的 `wiki/sources/foo.md`，写盘阶段也会强制改回这个 canonical source summary path。

Concept 页面不同。Concept 不是一份原始文件固定对应一个页面，而是 LLM 根据内容判断：

```text
哪些 idea / method / technique / abstraction 值得独立成页？
哪些只是 source summary 的一部分？
哪些概念已经存在，应该更新旧页而不是新建？
```

所以：

```text
Source 页面：一份 source 基本对应一个摘要页，路径稳定，有兜底。
Concept 页面：跨 source 的知识单元，由 LLM 判断是否创建/更新。
```

### 1.3 Stage 1：结构化分析，不写文件

Stage 1 使用 `buildAnalysisPrompt(...)`。

它让 LLM 读取原始 Markdown，并结合：

```text
schema.md       页面类型和目录规则
purpose.md      项目目标和范围
wiki/index.md   当前已有页面目录
folderContext   文件夹分类线索，例如 AI > Transformer
```

输出一份结构化分析：

```text
Key Entities
Key Concepts
Main Arguments & Findings
Connections to Existing Wiki
Contradictions & Tensions
Recommendations
```

这一阶段不会生成 `wiki/concepts/*.md` 或 `wiki/sources/*.md`。它的作用是先判断：

```text
这份 source 里有哪些重要知识单元？
哪些可能已经存在于 wiki？
哪些页面应该创建或更新？
有哪些冲突、重复或缺失需要用户注意？
```

### 1.4 Stage 2：生成待写入的 wiki 页面

Stage 2 使用 `buildGenerationPrompt(...)`。

它会收到：

```text
Stage 1 analysis
原始 source 内容
schema.md
purpose.md
wiki/index.md
wiki/overview.md
source summary 的固定路径
```

然后要求 LLM 输出 FILE blocks：

```text
---FILE: wiki/sources/xxx.md---
完整页面内容
---END FILE---

---FILE: wiki/concepts/yyy.md---
完整页面内容
---END FILE---
```

它被要求生成：

```text
1. source summary page
2. entity pages
3. concept pages
4. updated wiki/index.md
5. log entry for wiki/log.md
6. updated wiki/overview.md
```

所有内容页都应该带 YAML frontmatter，尤其是：

```yaml
---
type: concept
title: 主动回忆
sources: ["learning/memory-methods.md"]
related: [间隔重复]
tags: [learning, memory]
---
```

这里的 `sources` 和 `related` 是后续建立联系的关键。

### 1.5 写盘阶段：解析、清洗、校验、合并

LLM 输出 FILE blocks 后，程序才真正写文件。

写盘管道大致是：

```text
LLM 输出
  -> parseFileBlocks
  -> sanitizeIngestedFileContent
  -> 修正 source summary 路径
  -> canonicalizeSourcesField
  -> validateWikiPageRouting
  -> 语言检查
  -> 写入或 mergePageContent
```

几个重要机制：

```text
Source summary 路径会被强制改成程序计算出的 canonical path。
sources 字段会被程序修正，确保包含当前 source identity。
schema 路由不匹配的页面可能会被丢弃。
已有内容页不会简单覆盖，而是走合并逻辑。
```

如果一个 Concept 已经存在：

```text
wiki/concepts/间隔重复.md
```

而新 source 也生成了同一路径，程序会合并旧页和新页：

```text
旧 Concept 页面 + 新 source 生成的页面 -> 合并后的 Concept 页面
```

合并逻辑包括：

```text
sources / tags / related 做确定性并集
正文不同则让 LLM 合并正文
type / title / created 等关键字段锁住
updated 更新到当前日期
```

这就是 Concept 跨 source 积累的主要机制。

### 1.6 知识单元之间如何建立联系

LLM Wiki 里不同知识单元之间的联系主要来自五种机制。

**1. 同一路径合并**

如果新 source 输出了已有页面路径：

```text
wiki/concepts/主动回忆.md
```

那么这个 Concept 会被更新，而不是新建重复页。

这是跨 source 沉淀的最强机制。

**2. frontmatter.sources**

每个内容页会记录它来自哪些 source：

```yaml
sources:
  - learning/memory-methods.md
  - books/make-it-stick.md
```

多个页面共享 source 时，系统会认为它们有关系。图搜索里 `sourceOverlap` 权重很高。

**3. 正文里的 [[wikilink]]**

页面正文可以写：

```markdown
主动回忆常和[[间隔重复]]结合使用。
```

这些 wikilinks 会形成图谱里的显式边。

**4. frontmatter.related**

页面可以声明相关页面：

```yaml
related: [间隔重复, Anki]
```

它是结构化的“相关项”提示，也会帮助维护页面关系。

**5. index / overview / log 聚合**

每次摄入会更新：

```text
wiki/index.md
wiki/overview.md
wiki/log.md
```

`index.md` 帮助后续摄入判断“是否已有相关页面”，也帮助聊天 agent 判断本地 wiki 是否可能含有答案。

### 1.7 机制边界

这个流程不是完美去重系统。

它依赖：

```text
LLM 是否识别出已有概念
wiki/index.md 是否完整
schema.md 是否清晰
页面命名是否稳定
Stage 2 是否复用了已有路径
```

如果 LLM 没有命中已有路径，可能生成近义重复页，例如：

```text
wiki/concepts/间隔重复.md
wiki/concepts/间隔复习.md
```

项目会通过 review、lint、dedup 或人工整理来修复这类问题。

## 2. 检索策略

聊天/讲解时，Agent 不是直接把整个 wiki 塞给 LLM，而是先做检索召回。

整体流程：

```text
用户问题
  -> query understanding
  -> 路由到 wiki_search / graph_search / external_search / direct answer
  -> 检索少量相关页面
  -> materialize 页面内容
  -> 按上下文预算截断
  -> 构造 retrieved context
  -> LLM 基于 context 回答
```

核心实现主要在：

```text
src/lib/chat-agent.ts
src/lib/search.ts
src-tauri/src/commands/search.rs
src/lib/graph-relevance.ts
```

### 2.1 query understanding 和工具路由

Agent 会先判断用户意图：

```text
chitchat      闲聊
follow_up     基于上文追问
rewrite       改写/翻译/总结
kb_search     查询本地知识库
graph         查询关系/图谱
external      查询外部信息
mixed         本地 + 外部，或多工具组合
```

常见工具/动作：

```text
wiki_search        搜本地 wiki 页面
graph_search       基于图谱扩展相关页面
project_files      列项目文件
project_file_read  读取指定文件
external_search    Web / AnyTXT 等外部搜索
multi_search       组合多个检索动作
```

要区分：

```text
kb_search 是意图标签：用户在问本地知识库。
wiki_search 是实际工具：搜索 <project>/wiki/**/*.md。
```

### 2.2 wiki_search 的入参

chat-agent 层的 wiki_search 输入：

```ts
{
  projectPath: string
  queries: string[]
  llmConfig: LlmConfig
  searchWikiImpl: typeof searchWiki
}
```

其中：

```text
projectPath：当前项目路径
queries：Agent 根据用户问题生成的检索 query 列表
```

它最多使用前 3 个 query，并最多收集 8 个去重结果。

前端 `searchWiki(projectPath, query)` 调用后端：

```ts
invoke("search_project", {
  projectPath,
  query,
  topK: 20,
  includeContent: false,
  queryEmbedding: null,
  embeddingConfig,
})
```

所以 `wiki_search` 的核心入参是：

```text
项目路径 + 查询字符串
```

不是路径正则，也不是所有 Markdown 内容。

### 2.3 后端关键词检索如何打分

后端会扫描：

```text
<project>/wiki/**/*.md
```

最多扫描：

```text
10,000 个 Markdown 文件
```

它会对 query 构造两种形态：

```text
query_phrase：完整查询短语
tokens：分词后的 token 列表
```

中文会额外拆 bigram 和单字。例如：

```text
主动回忆
```

会产生类似：

```text
主动、动回、回忆、主、动、回、忆、主动回忆
```

每个文件会提取 title，优先级：

```text
frontmatter title
第一个 # H1
文件名
```

然后计算：

```text
filename_exact       文件名 stem 是否等于 query_phrase
title_has_phrase     title + 文件名 是否包含完整 query_phrase
content_phrase_occ   正文中完整 query_phrase 出现次数，最多计 10 次
title_token_score    title + 文件名 命中了多少 tokens
content_token_score  正文命中了多少 tokens
```

如果全部不命中，文件不会进入结果集。

关键词分数公式：

```text
score =
  filename_exact ? 200 : 0
  + title_has_phrase ? 50 : 0
  + content_phrase_occ * 20
  + title_token_score * 5
  + content_token_score * 1
```

这意味着：

```text
文件名精确匹配权重最高。
标题完整短语命中很重要。
正文完整短语命中比零散 token 命中更重要。
标题 token 命中比正文 token 命中权重更高。
```

### 2.4 可选 embedding hybrid 检索

如果项目启用了 embedding，后端会额外做向量检索。

向量库使用 LanceDB，结果是 chunk 级别：

```text
page_id
chunk_index
chunk_text
heading_path
score
```

后端会把 chunk 聚合成 page 级结果：

```text
blended = top_chunk_score + min(other_chunks_sum * 0.3, 1.0 - top_chunk_score)
```

直觉：

```text
最强 chunk 最重要。
多个相关 chunk 有小幅加成。
分数不会无限膨胀。
```

关键词排名和向量排名用 RRF 融合：

```text
RRF = 1 / (60 + keyword_rank) + 1 / (60 + vector_rank)
```

最终 mode 可能是：

```text
keyword
vector
hybrid
```

如果没有 embedding，检索就是纯关键词模式。

### 2.5 graph_search 如何召回

`graph_search` 不是直接在图上搜用户 query。它是：

```text
先 wiki_search 找种子页面
再从种子页面沿图谱扩展相关页面
```

图谱节点来自 `wiki/**/*.md`：

```text
id        文件名去掉 .md
title     frontmatter title 或 H1
type      frontmatter type
sources   frontmatter sources
outLinks  正文里的 [[wikilink]]
inLinks   其他页面指向它的链接
```

图谱相关性由四个信号组成：

```text
directLink      直接 wikilink，权重 3.0
sourceOverlap   共享 sources，权重 4.0
commonNeighbor  共同邻居，权重 1.5
typeAffinity    页面类型亲和度，权重 1.0
```

模拟例子：

```text
用户问：主动回忆和间隔重复有什么关系？
```

流程：

```text
wiki_search("主动回忆 间隔重复 关系")
  -> 命中 主动回忆.md、间隔重复.md

graph_search 以这些页面为种子
  -> 查看 wikilinks、sources overlap、共同邻居
  -> 可能扩展出 Anki.md、长期记忆.md、learning-memory-methods.md
```

如果：

```markdown
主动回忆.md 里写了 [[间隔重复]]
间隔重复.md 里写了 [[长期记忆]]
两者 sources 都包含 learning/memory-methods.md
```

那么 `间隔重复` 和 `长期记忆` 即使不是 query 的最强关键词命中，也可能因为图关系被召回。

graph_search 的价值是补充：

```text
没有直接命中 query，但在知识结构上相关的页面。
```

### 2.6 召回结果如何进入最终回答

检索结果最初通常只有：

```text
path
title
snippet
score
```

chat-agent 收集结果后，才读取少量命中页面的正文。然后按上下文预算截断，包装成 context blocks：

```text
<context id="1" source="wiki" kind="wiki" title="主动回忆" path="...">
页面内容
</context>

<context id="2" source="graph" kind="graph" title="间隔重复" path="...">
页面内容
</context>
```

最终回答 prompt 会要求模型：

```text
基于 retrieved context 和 conversation history 回答
如果上下文不足，要说缺什么，不要编
使用本地页面时加 [1] [2] 引用
相关时使用 [[wikilink]]
```

### 2.7 检索策略的实际含义

导入质量会直接影响检索质量。

有利于召回的 wiki 特征：

```text
Concept title 清晰稳定
文件名和概念名一致
正文包含关键术语
sources 字段准确
related 字段合理
正文 wikilinks 稳定
index.md 维护得好
```

主要局限：

```text
关键词部分不是 BM25，没有文档长度归一化。
没有复杂同义词扩展。
没有 LLM rerank。
embedding 没开时，字面不重叠的语义相关页面可能召回不到。
graph_search 依赖 wikilinks、sources 和 frontmatter 质量。
```

总结：

```text
摄入阶段负责把原始语料编译成结构化 wiki。
检索阶段先用关键词/向量找入口页，再用图谱补相关页，最后把少量页面交给 LLM 讲解。
```
