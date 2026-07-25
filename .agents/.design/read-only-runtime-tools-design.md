# 只读运行时 Tool 设计

## 1. 文档状态

本文档记录 Byte Mentor 第一批通用只读运行时 Tool 的设计结论。

设计以《AI Agent》项目的 `book/chapter4.md` 为学习材料，目标不是照搬完整工具平台，而是通过一个可运行、可测试的纵向切片，实践工具粒度、能力边界、参数保真、结构化返回、显式截断、工作区隔离和统一错误处理等原则。

本文档中的分项设计均已在讨论中确认，当前等待整体设计审阅。整体确认后，本文档将作为后续实现计划的架构依据。

## 2. 目标

### 2.1 学习目标

- 理解专用 Tool 与通用 Shell 执行器之间的边界。
- 实践面向 Agent 的工具接口设计，而不是简单封装底层 API。
- 理解只读工具在路径安全、输出控制、错误反馈和可测试性方面的运行时要求。
- 为后续写入、编辑和 Shell Tool 的安全、取消与审计设计建立可复用基础。

### 2.2 产品目标

让 Byte Mentor 的本地 Agent Runtime 能够在一个明确配置的工作区内，安全、渐进地浏览目录、查找文件、搜索文本和读取文本文件，为后续教学能力和项目理解能力提供基础感知工具。

## 3. 第一阶段范围

第一阶段提供四个职责独立的只读 Tool：

| Tool | 职责 | 明确边界 |
| --- | --- | --- |
| `list_directory` | 浏览指定目录下的直接子项 | 不递归搜索文件或读取内容 |
| `find_files` | 按文件名或相对路径查找文件 | 不搜索文件内容 |
| `search_text` | 在文本文件内容中查找匹配行 | 不用于按文件名查找 |
| `read_file` | 从指定位置读取文本文件片段 | 不修改文件，不承担多模态解析 |

保留四个独立 Tool，而不是通过 `mode` 或 `action` 合并为一个粗粒度 Tool。当前数量很小，清晰的使用条件和能力边界比减少 schema 数量更重要。

## 4. 工作区与路径模型

### 4.1 单工作区根目录

第一阶段只支持一个显式的 `workspaceRoot`：

- CLI 默认将 `process.cwd()` 作为 `workspaceRoot` 传入运行时。
- Tool 实现不得自行读取 `process.cwd()`，避免依赖隐式全局状态。
- 第一阶段不支持多个 workspace roots。

### 4.2 路径契约

- Tool 参数只接受相对于 `workspaceRoot` 的路径。
- Tool 返回给模型的路径也统一为相对路径，不暴露本机绝对路径。
- 所有路径在访问前必须经过规范化和真实路径校验，不能只做字符串前缀判断。
- 允许访问符号链接，但符号链接的最终目标必须仍位于 `workspaceRoot` 内。
- 递归查找和搜索不得进入最终目标位于 `workspaceRoot` 外部的符号链接目录。

## 5. 运行时上下文与组装

### 5.1 ToolRegistry 持有统一运行环境

`ToolRegistry` 持有统一的 Tool 运行环境，并在执行 Tool 时传入 `ToolExecutionContext`。具体 Tool 保持无状态，不各自捕获一份 `workspaceRoot`。

概念数据流：

```text
CLI 配置 workspaceRoot
  -> WorkspaceReader(workspaceRoot, accessPolicy)
  -> ToolRegistry(ToolExecutionContext)
  -> AgentTool.execute(args, context)
```

这为后续在统一上下文中增加取消信号、权限策略和审计信息保留了演进位置，但第一阶段不提前实现这些尚未需要的能力。

### 5.2 CLI 负责应用组装

CLI 的 `createRuntime()` 负责：

1. 根据当前运行目录确定显式 `workspaceRoot`。
2. 创建 `WorkspaceAccessPolicy` 和 `WorkspaceReader`。
3. 创建持有 Tool 运行环境的 `ToolRegistry`。
4. 注册四个只读 Tool。
5. 将配置好的 `ToolRegistry` 注入 `AgentLoop`。

`AgentLoop` 不根据 `workspaceRoot` 创建具体 Tool，避免编排层依赖文件系统实现。为兼容现有测试，`AgentLoop` 的 `tools` 输入可以缺省；缺省时使用空 Registry。真实 CLI 运行路径必须显式注入配置好的 Registry。

### 5.3 只读 Tool 的有界并发

第一阶段在两个层次上处理并发：

1. Tool 内部的文件系统访问使用 Node.js 异步 API，例如 `node:fs/promises`，不使用会阻塞事件循环的同步文件 API。Promise 是非阻塞 I/O 的基础，不代表单次读取本身会更快。
2. 当模型在同一个 AssistantMessage 中返回多个独立的只读 Tool Call 时，Runtime 使用受限并发调度它们，使多个 I/O 等待可以重叠。

Tool Call 调度使用计数信号量或等价的并发限制器，而不是互斥锁。第一阶段的 `maxConcurrentToolCalls` 默认为 4，由 Runtime 配置，模型不能通过 Tool 参数修改该上限。不使用无上限的 `Promise.all` 启动任意数量的调用。

并发资格是 Runtime 内部的显式执行属性，不暴露给模型：

- `list_directory`、`find_files`、`search_text` 和 `read_file` 明确允许并发。
- 未明确声明可并发的 Tool 默认串行，不仅根据 Tool 名称或描述推断其安全性。
- 未来的写入、编辑和 Shell Tool 的调度规则留待对应的安全设计确认。

同一批调用全部完成后，ToolMessage 必须按 AssistantMessage 中原始 Tool Call 的顺序加入模型轨迹，不由实际完成顺序决定，从而保持消息、checkpoint 和恢复行为稳定。单个调用失败不取消同批的其他只读调用；Registry 分别将每个结果归一化为结构化 ToolResult。

第一阶段不在单个 `find_files` 或 `search_text` 内部引入多文件并发 worker pool；目录遍历、稳定排序和资源计数仍在单个 Tool 内按确定性流程执行。如果后续性能测量表明必要，再在不改变 Tool 契约的前提下增加 Tool 内部的有界 I/O 并发。

## 6. 模块边界

第一阶段继续把 Tool 体系放在 `@byte-mentor/agent` 内，不创建新的 workspace package。

目标结构：

```text
packages/agent/src/tools/
├── contracts.ts
├── tool-registry.ts
├── workspace/
│   ├── workspace-reader.ts
│   └── workspace-policy.ts
└── builtins/
    ├── list-directory.ts
    ├── find-files.ts
    ├── search-text.ts
    └── read-file.ts
```

职责划分：

- `contracts.ts`：Tool 定义、执行上下文、结构化结果和错误契约。
- `tool-registry.ts`：注册、schema 校验、上下文注入、执行与异常归一化。
- `workspace-reader.ts`：路径解析、真实路径边界检查、目录遍历和只读文件能力。
- `workspace-policy.ts`：统一的拒绝访问规则、搜索排除规则和资源上限。
- `builtins/*`：面向模型的 Tool 名称、描述、参数 schema，以及参数到 `WorkspaceReader` 能力的薄映射。

当前位于 `providers/provider.ts` 的 `AgentTool`、`ToolResult` 等 Tool 执行契约迁移到 `tools/contracts.ts`。Provider 只保留模型供应商适配契约，以及调用模型所需的只读 `ToolDefinition`，不拥有 Tool 的运行时执行语义。

### 6.1 模型可见说明

第一阶段保持现有 `ToolDefinition` 的核心形态，不新增 Provider 专用的 `returns` 或 `examples` 字段。每个内置 Tool 在自身文件中提供结构化的多段 `description`：

```text
Use when: 适用场景。
Do not use when: 能力边界和反例。
Returns: 主要返回结构、分页或截断语义。
Example: 一个真实的参数 JSON 示例。
```

参数 JSON Schema 的每个字段同时写明含义、默认值、范围和示例，并统一设置 `additionalProperties: false`。

每个 Tool 第一阶段只提供一个典型调用示例。说明与实现放在同一文件中，避免工具行为和模型说明分散维护。Provider 直接传递 `description + parametersJsonSchema`，不承担 Tool 文档拼接职责。

### 6.2 ToolRegistry 启动期完整性

ToolRegistry 在注册阶段快速失败：

- Tool 名称必须匹配 `^[a-z][a-z0-9_]{0,63}$`。
- `description` 去除首尾空白后不能为空。
- 注册时立即编译并校验 `parametersJsonSchema`，不把 Tool 自身的 schema 配置错误延迟到模型调用阶段。
- 重复 Tool 名称直接抛出 `DuplicateToolError`，不允许静默覆盖，避免第三方 Tool 遮蔽内置 Tool。
- 运行阶段的 `invalid_arguments` 只表达模型实参不符合一个已经有效的 schema。
- `list()` 继续按 Tool 名称稳定排序。

注册阶段错误属于 Runtime 组装或开发配置错误，不转换成返回给模型的 ToolResult。

## 7. WorkspaceAccessPolicy

四个 Tool 共用一套可配置的 `WorkspaceAccessPolicy`，不在每个 Tool 内重复实现安全规则。

策略至少区分：

- `deniedPaths`：即使位于工作区内也禁止直接读取或搜索的敏感路径。
- `searchExcludes`：递归查找和内容搜索时默认跳过的高噪声路径。
- 运行时资源上限：限制搜索结果数量、读取行数和返回字符数，且模型不能通过参数突破硬上限。

第一阶段只使用确定性策略，不引入 LLM 安全审查，也不实现读取前的人工审批。

第一阶段默认策略：

```text
deniedPaths
- .git/**
- .byte-mentor/**
- .env
- .env.*，但允许 .env.example

searchExcludes
- 所有 deniedPaths
- node_modules/**
- dist/**
- build/**
- coverage/**
```

语义约定：

- `deniedPaths` 限制直接读取、进入目录、文件查找和内容搜索。
- 当 `list_directory` 浏览一个允许访问的父目录时，被禁止的直接子项仍以 `access: "denied"` 的最小条目显示，使模型知道安全边界的存在；该条目不返回大小、符号链接目标等附加元数据，也不能被继续访问。
- `find_files` 和 `search_text` 完全跳过 `deniedPaths`，不在匹配结果或跳过详情中暴露这些路径。
- `searchExcludes` 只影响递归的 `find_files` 和 `search_text`；模型明确指定路径时仍可通过 `list_directory` 或 `read_file` 访问非敏感的构建产物。
- 第一阶段不默认禁止所有 `*.key` 或 `*.pem`，避免误伤项目内用于测试的 fixture；调用方可以通过配置追加拒绝规则。

第一阶段默认资源上限：

| 策略 | 默认值 | 作用 |
| --- | ---: | --- |
| `defaultResultLimit` | 50 | `list_directory`、`find_files`、`search_text` 的默认返回数量 |
| `maxResultLimit` | 200 | 模型单次最多请求的结果数量 |
| `defaultReadLines` | 200 | `read_file` 默认读取行数 |
| `maxReadLines` | 500 | 模型单次最多请求的行数 |
| `maxOutputCharacters` | 12,000 | 单次返回的文件正文字符硬上限 |
| `maxSerializedToolResultCharacters` | 24,000 | 单次序列化 ToolResult 的字符硬上限 |
| `maxReadScanBytes` | 10 MiB | 单次为定位读取位置最多扫描的字节数 |
| `maxSearchFileBytes` | 2 MiB | `search_text` 跳过更大的单个文件 |
| `maxSearchTotalBytes` | 50 MiB | 单次内容搜索最多扫描的总字节数 |
| `maxTraversalEntries` | 50,000 | 单次递归最多访问的目录项 |
| `maxSkippedFileDetails` | 20 | 单次最多返回的跳过文件详情数量 |

资源限制语义：

- 模型请求的参数超过允许上限时返回 `invalid_arguments`。
- `search_text` 遇到超过 `maxSearchFileBytes` 的单个文件时跳过该文件，并记录在 `skippedFiles`。
- 总扫描字节数或目录遍历项数达到硬上限时返回 `resource_limit`，提示模型缩小 `path` 后重试，不返回容易被误认为完整结果的部分成功。
- `read_file` 按单次实际扫描量限制，而不是按文件总大小直接拒绝；因此仍可读取巨大文件的前部。
- 所有数值都是可配置的首期安全默认值，不属于不可演进的 Tool 协议常量。

## 8. 搜索实现与匹配语义

### 8.1 Node.js 原生实现

四个只读 Tool 使用 Node.js 文件系统 API 实现，不启动 Shell，也不依赖 `rg` 或其他外部命令。

专用 Tool 是模型可见的能力接口；Node.js API、`rg` 或其他搜索引擎只是内部实现细节。未来可以在保持 Tool 契约不变的前提下替换搜索后端。

第一阶段使用 Node.js API 的原因：

- 不依赖用户额外安装命令行工具。
- 保持跨平台行为一致。
- 所有路径和访问策略都经过统一边界。
- 分页、截断和错误输出可由 Runtime 精确控制。

### 8.2 字面量匹配

第一阶段只支持字面量查询：

- `find_files`：判断文件名或相对路径是否包含 `query`。
- `search_text`：判断文本内容是否包含 `query`。
- 两者支持 `caseSensitive` 参数。

第一阶段不支持 glob 或正则表达式，避免同时引入模式语法、正则性能风险和跨平台兼容语义。

### 8.3 文本编码与二进制文件

第一阶段采用严格的 UTF-8 文本边界：

- `read_file` 接受 UTF-8 和带 UTF-8 BOM 的文本。
- 检测到 NUL 字节或非法 UTF-8 时，`read_file` 返回 `unsupported_content`。
- 第一阶段不自动猜测其他编码，也不把二进制文件转成 Base64 返回。
- `search_text` 跳过二进制或非 UTF-8 文件，并在成功 payload 中返回 `skippedFileCount`，以及一个受数量限制的 `skippedFiles` 列表和跳过原因，避免静默遗漏。
- `list_directory` 和 `find_files` 只需要文件元数据，因此仍可列出二进制文件。

第一阶段不支持 UTF-16 LE/BE 或其他传统文本编码；若后续确有真实文件需求，再扩展明确的编码选项，不引入自动编码猜测。

### 8.4 递归与目录符号链接

`find_files` 和 `search_text` 可以递归进入最终目标位于工作区内部、且未被策略禁止的目录符号链接。

递归时维护 canonical realpath 的 visited set：

- 每个真实目录在单次调用中最多访问一次，防止符号链接循环和重复扫描。
- 如果同一真实目录可从普通路径和符号链接路径到达，只采用稳定遍历顺序中第一次到达的相对路径。
- 指向工作区外部、被策略禁止目标或断裂目标的目录符号链接不进入。

## 9. 结构化结果与模型传输

Tool 内部返回结构化、可 JSON 序列化的 payload，而不是由每个 Tool 自行拼接自然语言字符串。

Registry 负责统一执行和结果归一化；在进入现有 `ToolMessage` 边界时，结构化结果被统一序列化为 JSON 字符串。`Message`、Session 持久化和 OpenAI Provider 仍然使用现有字符串形式，不在本阶段扩展为对象消息。

序列化使用紧凑 JSON，不做 pretty print。所有内置 Tool 在构造成功 payload 时同时遵守模型请求的条目上限和 `maxSerializedToolResultCharacters`：

- 如果先达到序列化输出预算，列表或搜索提前结束当前页，返回更少条目，并通过 `pagination.truncatedBy: "output_limit"` 和 `nextOffset` 明确告知模型如何继续。
- `read_file` 的 `maxOutputCharacters` 为结果 envelope 预留序列化空间。
- Registry 在最终序列化后再次校验；如果 Tool 仍产生超过硬上限的结果，则返回 `resource_limit`。
- Runtime 不在 JSON 字符串中间硬截断，任何返回给模型的内容都必须是完整合法的 JSON。

统一结果 envelope：

```ts
type ToolResult =
  | { ok: true; data: JsonValue }
  | { ok: false; error: ToolError }
```

具体 Tool 的成功 payload 字段仍需在后续讨论中逐项确认。

## 10. 分页、读取窗口与显式截断

### 10.1 列表和搜索

以下 Tool 使用无状态的 `offset + limit`：

- `list_directory`：目录项偏移和数量。
- `find_files`：匹配文件偏移和数量。
- `search_text`：匹配行偏移和数量。

返回值必须包含：

```ts
{
  hasMore: boolean
  nextOffset?: number
}
```

第一阶段不引入 opaque cursor。

### 10.2 文本读取

`read_file` 以行为主要导航单位，同时使用字符数作为不可突破的输出安全上限。

概念参数：

```ts
{
  path: string
  startLine?: number
  startColumn?: number
  lineLimit?: number
}
```

约定：

- `startLine` 和 `startColumn` 均为 1-based。
- `lineLimit` 是模型可请求的逻辑窗口大小，并受 Policy 上限约束。
- `maxOutputCharacters` 是 Runtime Policy 的硬上限，模型不能提高该值。
- 读取达到 `lineLimit` 或字符硬上限中的任一个即停止。
- 截断必须显式返回原因，不允许静默截断。
- 超长单行达到字符上限时，返回同一行内可继续读取的列位置。

概念返回信息：

```ts
{
  path: string
  content: string
  range: {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
  }
  truncated: boolean
  truncatedBy?: "line_limit" | "character_limit"
  nextPosition?: {
    line: number
    column: number
  }
}
```

## 11. Tool 契约

### 11.1 `list_directory`

用途：浏览指定目录的直接子项，不递归。

参数：

```ts
{
  path?: string   // 默认 "."
  offset?: number // 默认 0
  limit?: number  // 默认 50，上限 200
}
```

成功 payload：

```ts
{
  path: string
  entries: Array<{
    name: string
    path: string
    type: "file" | "directory" | "symbolic_link" | "other"
    access: "allowed" | "denied"
    sizeBytes?: number
    targetType?: "file" | "directory" | "other" | "missing"
  }>
  pagination: {
    offset: number
    limit: number
    returned: number
    total: number
    hasMore: boolean
    nextOffset?: number
    truncatedBy?: "output_limit"
  }
}
```

行为约定：

- 普通文件返回 `sizeBytes`，目录不计算递归大小。
- 工作区内的符号链接返回目标的 `targetType`。
- 指向工作区外或被策略禁止目标的符号链接只显示为 `access: "denied"`，不返回目标信息。
- 断裂符号链接返回 `targetType: "missing"`；后续读取该路径时返回 `path_not_found`。
- 条目按名称使用平台无关的 Unicode 字符串顺序稳定排序，不做目录优先分组。
- 返回路径统一使用 `/` 作为分隔符。
- `offset` 超过总条目数时返回空 `entries`，不视为错误。
- 参数 schema 拒绝未知字段，即设置 `additionalProperties: false`。

### 11.2 `find_files`

用途：在指定目录内递归查找文件名或相对路径包含查询字面量的文件，不搜索文件内容。

参数：

```ts
{
  query: string           // 1～256 个字符
  path?: string           // 默认 "."
  caseSensitive?: boolean // 默认 false
  offset?: number         // 默认 0
  limit?: number          // 默认 50，上限 200
}
```

成功 payload：

```ts
{
  path: string
  query: string
  caseSensitive: boolean
  matches: Array<{
    name: string
    path: string
    type: "file" | "symbolic_link"
    sizeBytes: number
    targetType?: "file"
  }>
  pagination: {
    offset: number
    limit: number
    returned: number
    hasMore: boolean
    nextOffset?: number
    truncatedBy?: "output_limit"
  }
}
```

行为约定：

- 只返回普通文件和指向工作区内部文件的符号链接，不返回目录。
- `query` 同时匹配文件名和工作区相对路径，语义为字面量 substring。
- 结果按工作区相对路径稳定排序。
- `path` 必须是允许访问的目录，否则返回对应的结构化错误。
- `searchExcludes` 和 `deniedPaths` 在递归遍历前生效。
- 分页不返回 `total`，避免为了计数强制扫描完整工作区。
- `hasMore: true` 时返回 `nextOffset`。
- 达到遍历硬上限时返回 `resource_limit`，不把部分结果伪装为完整成功。
- 参数 schema 拒绝未知字段。

### 11.3 `search_text`

用途：在一个文本文件或目录内递归搜索查询字面量。一个匹配结果代表一条匹配行，而不是一次字符串出现。

参数：

```ts
{
  query: string           // 1～256 个字符
  path?: string           // 默认 "."，可指向单个文件或目录
  caseSensitive?: boolean // 默认 false
  offset?: number         // 默认 0
  limit?: number          // 默认 50，上限 200
}
```

成功 payload：

```ts
{
  path: string
  query: string
  caseSensitive: boolean
  matches: Array<{
    path: string
    line: number
    firstMatchColumn: number
    occurrenceCount: number
    preview: string
    previewRange: {
      startColumn: number
      endColumn: number
    }
    previewTruncated: boolean
  }>
  pagination: {
    offset: number
    limit: number
    returned: number
    hasMore: boolean
    nextOffset?: number
    truncatedBy?: "output_limit"
  }
  skippedFileCount: number
  skippedFiles: Array<{
    path: string
    reason: "binary" | "invalid_utf8" | "file_too_large" | "unreadable"
  }>
}
```

行为约定：

- 匹配结果按工作区相对路径、行号稳定排序。
- `line`、`firstMatchColumn` 和 `previewRange` 均为 1-based。
- 同一行出现多次只返回一项，通过 `occurrenceCount` 表达出现次数。
- `preview` 最多 300 个字符，并优先覆盖第一次匹配附近。
- 搜索单个文件时，如果文件不受支持或不可读，直接返回对应错误；递归搜索目录时才跳过个别文件。
- `skippedFileCount` 表达实际跳过总数，`skippedFiles` 详情最多返回 `maxSkippedFileDetails` 条。
- 参数 schema 拒绝未知字段。
- 调用仍受总扫描字节数和目录遍历项数硬上限控制。

### 11.4 `read_file`

用途：从指定行列位置开始读取 UTF-8 文本片段，同时保留原始文本和行尾。

参数：

```ts
{
  path: string
  startLine?: number   // 默认 1，1-based
  startColumn?: number // 默认 1，1-based Unicode code point 位置
  lineLimit?: number   // 默认 200，上限 500
}
```

成功 payload：

```ts
{
  path: string
  encoding: "utf-8"
  bom: boolean
  content: string
  range: null | {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
  }
  eof: boolean
  truncated: boolean
  truncatedBy?: "line_limit" | "character_limit"
  nextPosition?: {
    line: number
    column: number
  }
}
```

行为约定：

- `content` 保留原始文本和原始行尾，不添加行号，也不统一 CRLF、LF 或 CR。
- UTF-8 BOM 不放入 `content`，但通过 `bom: true` 明确告知。
- 行边界识别 LF、CRLF 和单独的 CR。
- 列号按 Unicode code point 计算，不使用 JavaScript UTF-16 code unit。
- `lineLimit` 从包含起始位置的第一行开始计数。
- 只有确实存在剩余内容时才设置 `truncated: true`。
- `nextPosition` 精确指向下一次继续读取的位置。
- `startLine` 超过 EOF 时返回空 `content`、`range: null`、`eof: true`。
- `startColumn` 超过目标行末尾可接受的位置时返回 `invalid_arguments`。
- 不返回 `totalLines`，避免为了读取前部而扫描完整文件。
- 参数 schema 拒绝未知字段。

## 12. 错误模型

采用分层、结构化的错误模型：

```ts
type ToolError = {
  code:
    | "unknown_tool"
    | "invalid_arguments"
    | "path_not_found"
    | "access_denied"
    | "wrong_path_type"
    | "unsupported_content"
    | "resource_limit"
    | "execution_failed"
  message: string
  details?: JsonObject
}
```

错误来源：

- Registry：`unknown_tool`、`invalid_arguments`。
- WorkspaceReader：路径不存在、拒绝访问、路径类型不符、不支持的内容和资源限制。
- `execution_failed`：只用于未被预期和归类的系统异常，不把所有失败都折叠为同一种错误。

失败时，模型接收完整的结构化 JSON envelope，以便根据错误代码修正调用，而不是解析自然语言猜测原因。

## 13. RuntimeEvent 可观测性边界

完整 ToolResult 只保存在对应的 `ToolMessage` 中，RuntimeEvent 不复制完整结果。

Tool 完成事件保留最多 500 个 Unicode 字符的序列化结果预览，供后续 TUI 或前端展示：

```ts
type ToolCompletedEvent = {
  type: "tool.completed"
  toolCallId: ToolCallId
  toolName: string
  durationMs: number
  outputCharacters: number
  resultPreview: string
  resultPreviewTruncated: boolean
}
```

Tool 失败事件保留结构化错误的观测字段：

```ts
type ToolFailedEvent = {
  type: "tool.failed"
  toolCallId: ToolCallId
  toolName: string
  durationMs: number
  errorCode: string
  message: string
}
```

结果预览只是展示信息，可以是完整 JSON 的前缀，不作为模型输入，也不要求自身是可解析的 JSON。完整结果仍以 ToolMessage 为唯一模型轨迹来源。若未来需要完整审计，应设计独立审计存储，不把完整文件正文复制进 RuntimeEvent。

## 14. 当前明确不包含

- `write_file`、`edit_file` 或其他写入 Tool。
- `shell_exec` 或任意通用命令执行能力。
- MCP Tool 的接入和生命周期。
- 多 workspace roots。
- glob、正则表达式搜索。
- opaque cursor 分页。
- LLM Sidecar 安全审查或人工审批。
- 为 Tool 体系新建 workspace package。
- 将结构化 Tool payload 扩散为对象形式的通用 Message 或 Provider 协议。
- RuntimeEvent 的实时观察回调；本阶段仍在 Turn 完成后通过 `result.events` 返回事件。

## 15. 测试策略与验收标准

### 15.1 WorkspaceReader 单元测试

- 相对路径解析、`..` 越界和绝对路径拒绝。
- 指向工作区内部、外部、断裂目标和形成循环的符号链接。
- `deniedPaths` 与 `searchExcludes` 策略。
- UTF-8、UTF-8 BOM、LF、CRLF、CR、非法 UTF-8 和二进制文件。
- 超长单行、行列位置续读和各项资源上限。

### 15.2 Tool 契约测试

- 四个 Tool 的参数默认值、非法字段和边界值。
- 稳定排序、分页和 `nextOffset`。
- 输出预算触发的 `truncatedBy: "output_limit"`。
- 每种成功 payload 和结构化错误。
- 每个 Tool 的模型可见说明均包含适用场景、能力边界、返回说明和一个调用示例。

### 15.3 Registry、Runner 与 Loop 集成测试

- Tool 注册期快速失败和重复名称拒绝。
- ToolExecutionContext 被正确注入具体 Tool。
- 同一 AssistantMessage 中的四个内置只读 Tool Call 按 `maxConcurrentToolCalls` 有界并发，且运行中的调用数从不超过上限。
- 未声明可并发的 Tool 保持串行，并发完成顺序不改变 ToolMessage 的原始调用顺序。
- 一个只读 Tool Call 失败时，同批的其他调用仍会完成并各自返回结构化结果。
- ToolResult 被序列化为合法 JSON ToolMessage。
- Tool RuntimeEvent 只携带最多 500 字符的结果预览、耗时和错误元数据，不复制完整结果。
- checkpoint、消息顺序和现有恢复行为不退化。
- AgentLoop 可以注入 Registry；缺省时仍使用空 Registry。

### 15.4 CLI 组装与 smoke

自动化测试使用临时目录和 fake provider，不访问真实模型 API，验证 CLI 将 `cwd` 作为显式工作区并注册四个只读 Tool。

手动 smoke 要求 Agent 完成以下闭环：

1. 列出 `packages/agent/src`。
2. 找到 `tool-registry.ts`。
3. 搜索 `ToolRegistry`。
4. 分段读取该文件。

### 15.5 完成标准

- Agent 能通过四个 Tool 完成上述本地文件感知闭环。
- Agent 无法读取工作区外路径、`.env`、`.git` 和 `.byte-mentor`。
- 四个 Tool 不启动 Shell，也不依赖 `rg`。
- 现有 checkpoint 和 session 行为保持兼容。
- `pnpm test`、`pnpm typecheck`、`pnpm lint` 和 `pnpm format:check` 全部通过。
