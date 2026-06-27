# LLM Wiki 摄入流程学习笔记：Sources 与 Concepts 是怎么生成的

> 学习约定：每次只讲一小段。当前文档会随着学习推进继续补充。

## 学习路线

1. 入口链路：Markdown 原始笔记怎么进入 `autoIngest`
2. Stage 1：LLM 怎样先分析原始笔记，提取候选实体和概念
3. Stage 2：LLM 怎样决定生成 `wiki/sources/*` 与 `wiki/concepts/*`
4. 写盘阶段：FILE blocks 怎样被解析、清洗、路由和合并
5. 特殊逻辑：source summary 兜底、重复 source 名、已有 concept 合并

## 第 1 部分：从导入 Markdown 到进入自动摄入

先把最大图景定住：LLM Wiki 不是在本地写了一套传统 NLP 规则来“算法式”抽取 Concepts 和 Sources。它的主要机制是：

```text
导入原始文件
  -> 拷贝到项目的 raw/sources/
  -> 入队 ingest queue
  -> autoIngest 读取 source/schema/purpose/index/overview
  -> LLM Stage 1 做结构化分析
  -> LLM Stage 2 输出 FILE blocks
  -> 程序解析 FILE blocks 并写成 wiki 页面
```

所以 `Concepts` 和 `Sources` 的“提取”核心发生在 LLM prompt 里，而不是一个确定性的 `extractConcepts()` 函数里。

### 1. UI 入口

在资料源页面点击导入文件时，组件会调用：

```ts
await importSourceFiles(project, paths, llmConfig, sourceWatchConfig)
```

代码位置：

- `/Users/user/Desktop/personal-projects/llm_wiki/src/components/sources/sources-view.tsx:141`

文件夹导入同理，会调用：

```ts
await importSourceFolder(project, selected, llmConfig, sourceWatchConfig)
```

代码位置：

- `/Users/user/Desktop/personal-projects/llm_wiki/src/components/sources/sources-view.tsx:160`

### 2. 原始文件先被复制到 `raw/sources/`

`importSourceFiles()` 会把用户选择的文件复制到当前项目的：

```text
<project>/raw/sources/
```

关键代码：

```ts
const destPath = await getUniqueDestPath(`${pp}/raw/sources`, originalName)
await copyFile(sourcePath, destPath)
importedPaths.push(destPath)
preprocessFile(destPath).catch(() => {})
```

代码位置：

- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/source-lifecycle.ts:154`

对 Markdown 文件来说，你可以先忽略 PDF、Office、图片预处理等分支，理解为：原始 `.md` 文件被复制进 `raw/sources/`，然后等待摄入。

### 3. 文件被放入 ingest queue

复制完成后，`importSourceFiles()` 调用：

```ts
await enqueueSourceIngest(project, importedPaths, llmConfig)
```

代码位置：

- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/source-lifecycle.ts:187`

`enqueueSourceIngest()` 做两件事：

```ts
const files = sourcePaths
  .filter(isIngestableSourcePath)
  .map((sourcePath) => ({
    sourcePath,
    folderContext: withRootContext(
      folderContextForSourcePath(sourcePath, options.sourceRoot),
      options.rootContext,
    ),
  }))

return enqueueBatch(project.id, files)
```

代码位置：

- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/source-lifecycle.ts:134`

这里有一个小细节：它会计算 `folderContext`。如果你的文件来自某个目录，比如：

```text
raw/sources/AI/Transformer/notes.md
```

那么 folder context 可能类似：

```text
AI > Transformer
```

这个信息后面会作为分类提示传给 LLM，帮助它判断页面该归到什么主题里。

### 4. 队列最终调用 `autoIngest`

ingest queue 一次处理一个 pending task。核心调用是：

```ts
const writtenFiles = await autoIngest(
  pp,
  fullSourcePath,
  llmConfig,
  currentAbortController.signal,
  next.folderContext,
)
```

代码位置：

- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/ingest-queue.ts:515`
- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/ingest-queue.ts:574`

这一步开始才进入真正的自动 wiki 生成流程。

### 5. `autoIngest` 开始时会确定 Source 身份和 Source 页面路径

`autoIngestImpl()` 一开始会算出几个关键变量：

```ts
const sourceIdentity = sourceIdentityForPath(pp, sp)
const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
const sourceSummaryPath = `wiki/sources/${sourceSummarySlug}.md`
```

代码位置：

- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/ingest.ts:485`
- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/ingest.ts:496`

这说明 `Sources` 页面不是随便生成的：程序先确定“这个原始文件的身份”，再固定一个目标 source summary 路径。

举例，如果原始文件是：

```text
<project>/raw/sources/learning/spaced-repetition.md
```

那么：

```ts
sourceIdentityForPath(projectPath, sourcePath)
```

会得到类似：

```text
learning/spaced-repetition.md
```

相关代码：

- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/source-identity.ts:8`

之后：

```ts
sourceSummarySlugFromIdentity("learning/spaced-repetition.md")
```

会生成一个稳定 slug，用来得到：

```text
wiki/sources/<stable-slug>.md
```

相关代码：

- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/source-identity.ts:39`

这一点很重要：

- `wiki/sources/*` 是“每个原始 source 文件的摘要页”
- 它的路径有程序级约束，后面即使 LLM 输出了别的 `wiki/sources/foo.md`，写入阶段也会强制改回这个 canonical source summary path
- `wiki/concepts/*` 则没有这种“一份原始文件对应一个固定 concept path”的规则，它由 LLM 根据内容和 schema 决定

### 本部分小结

到这里还没有真正“抽取 Concept”。当前阶段只完成了三件事：

1. 原始 Markdown 被复制到 `raw/sources/`
2. 文件被放入 ingest queue
3. `autoIngest` 为这份 source 计算出稳定的 `wiki/sources/<slug>.md`

下一部分才会进入 Stage 1 prompt：LLM 如何读原始 Markdown，并列出 `Key Concepts`、`Key Entities`、`Recommendations`。

## 第 2 部分：Stage 1 不是生成页面，而是先做“内容分析”

从这一部分开始，要把“提取 Concepts / Sources”理解成一个两阶段工作：

```text
Stage 1：读原始笔记，整理出结构化分析
Stage 2：根据分析结果，正式生成 wiki 页面
```

Stage 1 的重点不是写 `wiki/concepts/*.md`，也不是写 `wiki/sources/*.md`。它只是让 LLM 先回答：

- 这份笔记里有哪些重要实体？
- 这份笔记里有哪些重要概念？
- 它的核心论点、发现、结论是什么？
- 它和现有 wiki 里的哪些页面相关？
- 它建议创建或更新哪些页面？

换句话说，Stage 1 更像“读书报告 + 建档建议”，不是最终产物。

### Stage 1 输入了什么

在普通 Markdown 笔记场景下，可以先忽略 PDF、图片、超长文档分块等分支。核心输入大概是：

```text
1. 当前原始 Markdown 的全文
2. 项目的 purpose.md
3. 项目的 schema.md
4. 当前 wiki/index.md
5. 可能还有 folderContext，例如 AI > Transformer
```

这些上下文的作用不同：

- 原始 Markdown：本次要摄入的新内容
- purpose.md：告诉 LLM 这个知识库的目标是什么
- schema.md：告诉 LLM 页面类型和目录规则
- wiki/index.md：告诉 LLM 已经有哪些页面，避免重复建概念
- folderContext：告诉 LLM 用户原来的文件夹分类意图

对应入口在 `autoIngestImpl()` 中。它读取了 source、schema、purpose、index、overview，然后进入两阶段 LLM 流程：

- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/ingest.ts:542`
- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/ingest.ts:797`

### Stage 1 的 prompt 要求 LLM 输出什么

Stage 1 使用的是 `buildAnalysisPrompt()`。

它要求 LLM 按这些板块分析：

```text
Key Entities
Key Concepts
Main Arguments & Findings
Connections to Existing Wiki
Contradictions & Tensions
Recommendations
```

对应代码：

- `/Users/user/Desktop/personal-projects/llm_wiki/src/lib/ingest.ts:1747`

这里最重要的是 `Key Concepts` 和 `Recommendations`。

`Key Concepts` 要求 LLM 列出：

```text
理论、方法、技术、现象
每个概念的简短定义
它为什么在这份 source 里重要
它是否可能已经存在于当前 wiki
```

`Recommendations` 要求 LLM 给出：

```text
哪些 wiki 页面应该创建或更新
哪些内容应该强调或弱化
有没有值得提醒用户的开放问题
```

所以 Concepts 的候选名单是在这里出现的，但还没有落盘。

### 一个简化例子

假设你的原始 Markdown 是：

```markdown
# 学习方法笔记

主动回忆比反复阅读更有效。间隔重复可以帮助长期记忆。
我应该把 Anki 用在英语单词和技术概念复习上。
```

Stage 1 可能会分析成类似：

```text
Key Entities
- Anki：复习工具，和间隔重复实践相关

Key Concepts
- 主动回忆：通过主动提取信息强化记忆
- 间隔重复：按时间间隔复习以增强长期记忆
- 长期记忆：本笔记讨论的学习目标

Recommendations
- 创建或更新 wiki/concepts/主动回忆.md
- 创建或更新 wiki/concepts/间隔重复.md
- 创建 source summary 页面记录这份学习方法笔记
```

注意：这仍然只是“分析建议”。真正的文件路径和页面内容，要等 Stage 2 才生成。

### Stage 1 和 Sources 的关系

`Sources` 页面在 Stage 1 里通常只会被“建议”出来。比如分析结果会说：

```text
应该创建一个 source summary page，概括这份原始笔记。
```

但 source summary 的稳定路径其实在 Stage 1 前已经由程序算好了：

```text
wiki/sources/<sourceSummarySlug>.md
```

也就是说：

- 程序负责确定“这份原始文件应该对应哪个 source summary 路径”
- LLM 负责决定“这个 source summary 页面里应该写什么”

这是 Sources 和 Concepts 的一个核心区别。

### 本部分小结

Stage 1 的产物是一段结构化分析文本，不是 wiki 文件。

它的作用是给 Stage 2 提供判断依据：

- 哪些概念值得独立成页
- 哪些实体值得独立成页
- 原始 source 应该如何摘要
- 已有 wiki 中哪些页面应该被更新
- 有没有重复、矛盾、缺失页面等需要用户确认的问题

下一部分会讲 Stage 2：LLM 如何把 Stage 1 的分析变成真正的 `---FILE: wiki/sources/...---` 和 `---FILE: wiki/concepts/...---`。

### 定位补充：Stage 1 prompt 写在哪里

Stage 1 的 prompt 写在：

```text
/Users/user/Desktop/personal-projects/llm_wiki/src/lib/ingest.ts
```

具体函数是：

```ts
buildAnalysisPrompt(purpose, index, sourceContent)
```

它定义了 `Key Entities`、`Key Concepts`、`Main Arguments & Findings`、`Connections to Existing Wiki`、`Contradictions & Tensions`、`Recommendations` 这些分析板块。

调用位置在同一个文件的 `autoIngestImpl()` 里：

```ts
{ role: "system", content: buildAnalysisPrompt(purpose, index, sourceContext) },
{ role: "user", content: `Analyze this source document: ... ${sourceContext}` },
```

### 定位补充：这些上下文文件从哪里来

自动导入流程读取的是项目根目录和 wiki 目录里的这些文件：

```ts
tryReadSourceTextFile(sp)
tryReadFile(`${pp}/schema.md`)
tryReadFile(`${pp}/purpose.md`)
tryReadFile(`${pp}/wiki/index.md`)
tryReadFile(`${pp}/wiki/overview.md`)
```

含义：

- `sp`：当前正在摄入的原始文件路径，通常在 `<project>/raw/sources/...`
- `pp`：当前项目根目录
- `schema.md`：项目页面类型和目录规则
- `purpose.md`：项目目标和范围
- `wiki/index.md`：当前 wiki 页面目录
- `wiki/overview.md`：当前 wiki 总览

这些文件在项目创建时由后端先生成默认版本：

```text
/Users/user/Desktop/personal-projects/llm_wiki/src-tauri/src/commands/project.rs
```

其中：

- `schema.md`：创建默认 wiki schema
- `purpose.md`：创建默认项目目标模板
- `wiki/index.md`：创建默认页面目录
- `wiki/overview.md`：创建默认总览页

然后前端创建项目对话框会根据你选的模板覆盖根目录下的：

```text
<project>/schema.md
<project>/purpose.md
```

对应代码在：

```text
/Users/user/Desktop/personal-projects/llm_wiki/src/components/project/create-project-dialog.tsx
```

`folderContext` 不是文件，它是从 source 文件路径推导出来的分类提示。例如：

```text
raw/sources/AI/Transformer/notes.md
```

会得到类似：

```text
AI > Transformer
```

对应逻辑在：

```text
/Users/user/Desktop/personal-projects/llm_wiki/src/lib/source-lifecycle.ts
```

## 第 3 部分：Stage 2 把分析结果变成“待写入的 wiki 页面”

Stage 1 的产物是一段分析文本。Stage 2 的任务是：让 LLM 根据这段分析，输出一组“文件块”。

这里要特别注意：Stage 2 的 LLM 仍然不是直接写文件。它只是输出类似这样的文本：

```text
---FILE: wiki/sources/xxx.md---
页面内容
---END FILE---

---FILE: wiki/concepts/yyy.md---
页面内容
---END FILE---
```

后面的程序再解析这些 `FILE blocks`，真正写入磁盘。

### Stage 2 prompt 写在哪里

Stage 2 的 prompt 在：

```text
/Users/user/Desktop/personal-projects/llm_wiki/src/lib/ingest.ts
```

函数是：

```ts
buildGenerationPrompt(...)
```

它在 `autoIngestImpl()` 里被调用。调用时，LLM 会同时收到：

```text
1. Stage 1 Analysis
2. Source Context，也就是原始 Markdown 内容
3. schema.md
4. purpose.md
5. wiki/index.md
6. wiki/overview.md
7. 这份 source 的固定 summary path
```

所以 Stage 2 不是凭空生成页面，而是在“原始内容 + Stage 1 分析 + 当前 wiki 状态 + 项目 schema”的约束下生成。

### Stage 2 被要求生成什么

`buildGenerationPrompt()` 里明确写了 `What to generate`：

```text
1. A source summary page at 指定路径
2. Entity pages for key named things
3. Concept pages for key ideas, methods, techniques, and abstractions
4. updated wiki/index.md
5. log entry for wiki/log.md
6. updated wiki/overview.md
```

对我们当前问题最重要的是前 3 个：

```text
Source summary page
Entity pages
Concept pages
```

### Source 页面为什么更“稳定”

Source 页面路径在 Stage 2 之前已经由程序算好，例如：

```text
wiki/sources/<sourceSummarySlug>.md
```

Stage 2 prompt 会强制告诉 LLM：

```text
A source summary page at **wiki/sources/<sourceSummarySlug>.md**
MUST use this exact path
```

所以 source summary 是“一份原始文件对应一个摘要页面”的关系。

如果你的原始文件是：

```text
raw/sources/learning/spaced-repetition.md
```

那么 source 页面大概就是：

```text
wiki/sources/<由 learning/spaced-repetition 算出的稳定 slug>.md
```

这个页面的主题是“这份原始笔记本身”。

### Concept 页面为什么更“判断型”

Concept 页面没有一个预先固定的数量。LLM 要根据 Stage 1 分析判断：

```text
哪些 idea / method / technique / abstraction 值得独立成页？
哪些只是 source summary 里的一个段落，不值得独立成页？
哪些概念已经在 wiki/index.md 里出现过，应该更新旧页而不是新建？
```

这就是为什么你导入一份 Markdown 后，可能生成：

```text
wiki/sources/xxx.md
wiki/concepts/主动回忆.md
wiki/concepts/间隔重复.md
```

也可能只生成：

```text
wiki/sources/xxx.md
wiki/concepts/间隔重复.md
```

甚至如果内容很弱，可能主要只有 source summary。

### 一个简化例子

假设 Stage 1 分析认为：

```text
Key Concepts:
- 主动回忆
- 间隔重复

Recommendations:
- 创建 source summary
- 创建或更新主动回忆页面
- 创建或更新间隔重复页面
```

Stage 2 就可能输出：

```text
---FILE: wiki/sources/learning-spaced-repetition.md---
---
type: source
title: "Source: learning/spaced-repetition.md"
sources: ["learning/spaced-repetition.md"]
---

# Source: learning/spaced-repetition.md

这份笔记讨论主动回忆、间隔重复和 Anki 的学习应用。
---END FILE---

---FILE: wiki/concepts/主动回忆.md---
---
type: concept
title: 主动回忆
sources: ["learning/spaced-repetition.md"]
---

# 主动回忆

主动回忆是一种通过主动提取信息来强化记忆的学习方法。
---END FILE---
```

这时仍然只是 LLM 的文本输出。它还没有真正成为文件。

### Stage 2 的关键约束

Stage 2 prompt 还要求每个页面带 YAML frontmatter，例如：

```yaml
---
type: concept
title: 主动回忆
created: 2026-06-28
updated: 2026-06-28
tags: [learning]
related: [间隔重复]
sources: ["learning/spaced-repetition.md"]
---
```

这里的 `sources` 字段很重要。它把 concept 页面和原始 source 关联起来。

所以一个 Concept 页面虽然不是“原始文件摘要”，但它仍然会记录：

```text
这个概念页面的内容来自哪些原始 source
```

这也是后续删除 source、合并页面、搜索引用时能追踪来源的基础。

### 本部分小结

Stage 2 的核心是“生成候选 wiki 文件文本”：

- Source 页面：路径由程序提前固定，LLM 负责写摘要内容
- Concept 页面：由 LLM 根据 Stage 1 分析、schema 和现有 index 判断是否创建/更新
- 所有页面都会带 frontmatter，尤其是 `type` 和 `sources`
- LLM 只输出 FILE blocks，真正写盘发生在下一步

下一部分讲写盘阶段：这些 `---FILE: ...---` 文本块如何被解析、清洗、校验，然后变成真实的 `wiki/sources/*.md` 和 `wiki/concepts/*.md`。

## 第 4 部分：FILE blocks 如何变成真实 Markdown 文件

Stage 2 的 LLM 输出只是文本，例如：

```text
---FILE: wiki/concepts/间隔重复.md---
---
type: concept
title: 间隔重复
sources: ["learning/spaced-repetition.md"]
---

# 间隔重复

...
---END FILE---
```

接下来程序要做一件很重要的事：把这些文本块变成真实文件。

这个阶段可以理解成“落盘管道”：

```text
LLM 输出
  -> 解析 FILE blocks
  -> 清洗页面内容
  -> 修正 source summary 路径
  -> 修正 sources 字段
  -> 校验 schema 路由
  -> 校验语言
  -> 写入或合并文件
```

### 1. 解析 FILE blocks

程序会先从 LLM 的回复里解析出多个文件块。

核心函数是：

```ts
parseFileBlocks(text)
```

位置：

```text
/Users/user/Desktop/personal-projects/llm_wiki/src/lib/ingest.ts
```

如果 LLM 没有按格式输出：

```text
---FILE: path---
...
---END FILE---
```

那么这部分就解析不出来，后面也不会写出对应文件。

这就是为什么 Stage 2 prompt 一直强调：

```text
Your response MUST begin with ---FILE:
Do not output preamble
Do not output commentary
```

因为解析器不是在读自然语言，它只认 FILE block 格式。

### 2. Source summary 路径会被强制纠正

这一步非常关键。

即使 LLM 输出了：

```text
---FILE: wiki/sources/some-random-name.md---
...
---END FILE---
```

程序也会检查：如果这是 source summary 页面，就把它改成前面算好的 canonical path：

```text
wiki/sources/<sourceSummarySlug>.md
```

也就是说，Source 页面路径最终以程序算出来的为准，不完全相信 LLM。

这就是为什么 Source 页面比 Concept 页面稳定。

### 3. sources 字段会被程序修正

Stage 2 prompt 要求每个页面 frontmatter 里必须有：

```yaml
sources: ["当前原始文件"]
```

但 LLM 可能忘写、写错，或者只写了 basename。

所以写盘前，程序会调用类似：

```ts
canonicalizeSourcesField(content, sourceFileName)
```

它会确保普通内容页都带上当前 source identity。

这对 Concepts 很重要。因为一个 concept 页面可能被多个原始笔记反复更新，最后它的 `sources` 可能变成：

```yaml
sources:
  - learning/spaced-repetition.md
  - learning/active-recall.md
  - books/make-it-stick.md
```

也就是说，一个 Concept 页面可以积累多个来源。

### 4. 页面会被清洗和校验

LLM 输出经常会有小毛病，比如：

```text
把 frontmatter 包进 ```yaml 代码块
related 写成非法 YAML
路径和 type 不匹配
某个 concept 页面语言不符合项目输出语言
```

所以程序写盘前会做几类处理：

```text
sanitizeIngestedFileContent   清洗内容格式
stampGeneratedFrontmatterDates 补/修 created 和 updated
validateWikiPageRouting       检查 type 和目录是否符合 schema
contentMatchesTargetLanguage  检查部分页面语言
```

这一步说明：LLM 负责生成草稿，程序负责把草稿收束到项目规则里。

### 5. 已有页面不是简单覆盖，而是合并

这是 Concept 页面最重要的机制之一。

如果 Stage 2 输出：

```text
wiki/concepts/间隔重复.md
```

而这个文件已经存在，程序不会直接覆盖旧文件。它会走合并逻辑：

```text
旧 concept 页面
  + 新 source 带来的内容
  -> 合并后的 concept 页面
```

这意味着 Concept 页面是“跨 source 积累”的。

第一次导入：

```text
source A -> wiki/concepts/间隔重复.md
```

第二次导入：

```text
source B -> 仍然更新 wiki/concepts/间隔重复.md
```

最后这个 concept 页面就不再只是某一份笔记的摘要，而是整个知识库对“间隔重复”这个概念的综合页面。

### 6. Source 页面也可能被兜底创建

如果 LLM 忘了生成 source summary，程序会兜底写一个最小的 source 页面。

大概结构是：

```yaml
---
type: source
title: "Source: 原始文件"
sources: ["原始文件"]
tags: []
related: []
---

# Source: 原始文件

Stage 1 analysis 的前几千字符
```

这保证每个成功摄入的 source 至少有一个 `wiki/sources/*.md` 页面。

所以：

- Concepts 是 LLM 判断后生成/更新的
- Sources 几乎是摄入流程强保证存在的

### 本部分小结

Stage 2 的输出不是最终文件。最终文件经过程序管道处理后才落盘。

关键区别：

```text
Source 页面
- 路径由程序提前固定
- LLM 忘生成时，程序会兜底创建
- 更像“每份原始文件的档案卡”

Concept 页面
- 是否生成由 LLM 判断
- 路径通常来自 LLM 输出
- 如果已存在，会和旧内容合并
- 更像“跨多个来源逐渐长大的知识页”
```

下一部分会把整个流程串起来：用一份具体 Markdown 笔记模拟它最终会生成哪些 Sources 和 Concepts，以及为什么。
