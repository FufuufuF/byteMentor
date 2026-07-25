# 只读运行时 Tool 实现计划

## 1. 计划状态

- 状态：开发中（Batch 6 GREEN / Review 问题已修复）
- 架构依据：`.agents/.design/read-only-runtime-tools-design.md`
- 实现范围：`@byte-mentor/agent` 内的四个只读 Tool、有界并发调度以及 CLI 组装闭环

本计划是面向人工 Review 的实现交接文档，不重复设计文档中已确认的 payload 字段、路径策略和资源上限。如果实现中发现设计未覆盖的行为决策，应先回到 Design Review，不在代码中临时扩展契约。

## 2. Batch 与 Commit 约定

- 一个 Batch 对应一个可独立 Review 的 commit。
- 每个 Batch 在同一个 commit 中包含测试代码和生产代码，不单独提交红测试。
- 实施时先让本批次的目标测试失败（RED），再完成最小实现使其通过（GREEN），最后在 GREEN 状态提交。
- Batch 以完整的行为边界拆分，不为了追求小行数而把同一能力的契约、测试和实现拆到多个 commit。
- 每个 Batch 完成后先停下等待 Review，不自动进入下一批。
- 不引入新的运行时依赖；文件系统能力使用 Node.js 异步 API，schema 校验继续使用现有 Ajv。
- 从 2026-07-25 的 Batch 1 剩余工作开始，以整个 Batch 为 TDD 反馈单位：先一次性写完本 Batch 全部目标测试并确认 RED，再统一完成生产代码、全量验证和 GREEN Review；不再为 Batch 内部小步设置 RED/GREEN 暂停点。
- Batch 1 已经产生的小步提交保留，不重写历史；后续 Batch 恢复“一个 Batch 对应一个 commit”。

### 2.1 实施契约与行为决策

本节补齐 Design 已确定方向、但原计划没有落到具体代码签名的决策。实施时直接以本节为准；若 Review 需要调整，先修改本节，再修改代码。

#### 类型与 Provider 边界

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

type ToolErrorCode =
  | "unknown_tool"
  | "invalid_arguments"
  | "path_not_found"
  | "access_denied"
  | "wrong_path_type"
  | "unsupported_content"
  | "resource_limit"
  | "execution_failed";

interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: JsonObject;
}

type ToolResult =
  | { ok: true; data: JsonValue }
  | { ok: false; error: ToolError };

interface ToolExecutionOutput {
  result: ToolResult;
  content: string;
}

interface AgentTool extends ToolDefinition {
  concurrency?: "safe";
  execute(args: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}
```

- `ToolRegistry.execute()` 返回 `{ result, content }`。`content` 是 `result` 的紧凑 JSON 序列化，Runner 直接写入 `ToolMessage.content`；RuntimeEvent 从 `result` 读取结构化观测字段。
- `concurrency?: "safe"` 是 Runtime 内部执行属性；未声明即按串行处理。`ToolRegistry.list()` 不暴露该字段。
- `ToolDefinition` 继续只包含 `name`、`description` 和可选 `parametersJsonSchema`；Provider、Message、Session 协议不引入 Tool 执行语义或对象 payload。
- `ModelProvider`、`ProviderRequest`、`ProviderResponse` 和流式事件签名保持现状。
- `SessionStore`、Message 判别联合、branded ID、`StopReason` 和 `ContextBuilder` 签名保持现状。

#### Registry 签名与归一化

```ts
interface ToolRegistryOptions {
  context?: ToolExecutionContext;
  maxSerializedToolResultCharacters?: number;
}

class ToolRegistry {
  constructor(options?: ToolRegistryOptions);
  register(tool: AgentTool): void;
  list(): ToolDefinition[];
  getConcurrency(name: string): "safe" | "serial";
  execute(name: string, args: unknown): Promise<ToolExecutionOutput>;
}
```

- 保留无参构造以支持 AgentLoop 的空 Registry。Batch 2 起 Registry 在配置了 context 时原样注入；Batch 8 完成 Loop/CLI 注入前，无 context Registry 仅用于空 Registry 或不读取 context 的兼容测试 Tool，不注册内置 Workspace Tool。
- Batch 1 先建立不依赖 Workspace 具体类型的执行边界，采用过渡签名 `execute(args)`，且 `ToolRegistryOptions` 暂不包含 `context`；Batch 2 创建真实 WorkspaceReader 后一次性加入最终的第二参数和显式上下文，不创建空 Workspace 文件或占位类型。
- Tool 名称必须匹配 `^[a-z][a-z0-9_]{0,63}$`；description trim 后不能为空。
- 重名抛出 `DuplicateToolError`；非法名称、说明或 schema 抛出 `InvalidToolDefinitionError`。这些注册期错误不转换成 ToolResult。
- schema 在 `register()` 中由 Ajv 编译。没有 schema 时，参数仍必须是非 null、非数组的 JSON object；无参数 Tool 使用 `{}`。
- schema 校验失败返回 `invalid_arguments`；未知名称返回 `unknown_tool`；Tool 抛出的任意值统一返回 `execution_failed`。
- 可预期的 Workspace 失败由内置 Tool 转成对应 `ToolResult` 后返回，不通过 throw 传递。
- Registry 对 Tool 返回值做 JSON 值运行时检查，拒绝 `undefined`、函数、symbol、bigint、非有限数字、稀疏数组、循环引用和非普通对象；违规结果归一化为 `execution_failed`。
- Registry 使用 `JSON.stringify(result)` 生成紧凑 JSON。若超过硬上限，改为完整的 `resource_limit` 失败 envelope，不截断 JSON 字符串。
- 默认 Registry 序列化硬上限为 24,000 字符；CLI 组装时使用 Workspace Policy 中的对应值显式配置。
- `getConcurrency()` 对未知或未声明 Tool 返回 `"serial"`，仅用于 Runner 调度，不进入 Provider schema。

#### Workspace 公共签名

```ts
interface ToolExecutionContext {
  workspaceReader: WorkspaceReader;
}

interface WorkspaceResolvedPath {
  path: string;
  type: "file" | "directory" | "other";
  isSymbolicLink: boolean;
}

class WorkspaceError extends Error {
  readonly code: ToolErrorCode;
  readonly details?: JsonObject;
}

class WorkspaceAccessPolicy {
  constructor(overrides?: WorkspaceAccessPolicyOverrides);
  readonly deniedPaths: readonly string[];
  readonly searchExcludes: readonly string[];
  readonly limits: Readonly<WorkspaceResourceLimits>;
  isDenied(relativePath: string): boolean;
  isSearchExcluded(relativePath: string): boolean;
}

class WorkspaceReader {
  constructor(input: {
    workspaceRoot: string;
    policy: WorkspaceAccessPolicy;
  });
  readonly workspaceRoot: string;
  readonly policy: WorkspaceAccessPolicy;
  resolvePath(path: string): Promise<WorkspaceResolvedPath>;
}
```

- `workspaceRoot` 在构造时解析并固定；Reader 和 Tool 执行期间都不读取 `process.cwd()`。
- `ToolExecutionContext` 使用必填 `workspaceReader` 字段，不做泛型化，也不新增第二套 Workspace 抽象接口。
- WorkspaceReader 的路径解析、目录列举、遍历、窗口读取和文本搜索方法按对应 Batch 的最小行为逐步加入；这些方法返回内部结构化数据，并以一个 `WorkspaceError` 类表达设计中的预期错误码。
- `resolvePath()` 只返回规范化的 `/` 分隔相对路径、真实目标类型和原路径是否为符号链接，不向 Tool 或测试暴露绝对路径。
- 所有 WorkspaceReader 方法异步；禁止 `node:fs` 同步 API。
- 路径输入先拒绝绝对路径和词法 `..` 越界，再用 canonical realpath 判断真实边界。不存在和断裂目标保留 `path_not_found`，工作区外或策略禁止目标返回 `access_denied`。
- Policy overrides 对数组字段采用整体替换，对数值上限采用逐字段覆盖；所有上限在构造时校验为正整数。
- Policy 路径规则使用受限内部模式：普通路径精确匹配，尾部 `/**` 同时匹配该路径本身和所有后代，单个 `*` 只匹配一个路径段内的任意字符；不把该语法暴露为模型 Tool 参数。
- 内置 Tool 导出为无状态的 `AgentTool` 常量，通过 `execute(args, context)` 使用 Reader，不捕获 workspaceRoot 或 Policy。

#### Runner、事件与 Loop 签名

```ts
interface AgentRunnerOptions {
  maxConcurrentToolCalls?: number;
}

class AgentRunner {
  constructor(provider: ModelProvider, options?: AgentRunnerOptions);
}

interface AgentLoopInput {
  sessionStore: SessionStore;
  contextBuilder: ContextBuilder;
  runner: Pick<AgentRunner, "run">;
  tools?: ToolRegistry;
}
```

- `maxConcurrentToolCalls` 默认 4，必须是正整数；它是 Runtime 配置，不进入 Tool 参数或 Provider 请求。
- AgentRunner 的 `run()`、`AgentRunnerInput`、`AgentRunnerResult`、HeadlessTurn 输入/结果和 checkpoint 签名保持现状。
- Batch 1 中 ToolMessage 一律使用 `ToolExecutionOutput.content`；成功和失败都是可解析的完整 JSON envelope。
- Batch 7 中只有整批 Tool Call 都解析成功且 Registry 报告为 `safe` 时才并发；存在参数解析失败、未知 Tool 或任一串行 Tool 时整批按原顺序串行。
- 并发限制覆盖从 Registry execute 开始到结果完成的整个生命周期；不预先启动超出上限的 Promise。
- 并发结果、ToolMessage、working messages 和 checkpoint 始终按原始 Tool Call 顺序组装；单个失败不取消同批其他调用。
- `tool.completed` 使用 Design 中的 `toolName`、`durationMs`、`outputCharacters`、`resultPreview`、`resultPreviewTruncated`；preview 按 Unicode code point 截取前 500 个字符。
- `tool.failed` 使用 Design 中的 `toolName`、`durationMs`、`errorCode`、`message`；完整失败 envelope 只进入 ToolMessage。
- AgentLoop 缺省 `tools` 时创建空 Registry；传入时保留同一实例，不复制注册项。

#### 持久化、边界与工程约定

- 用户消息、AssistantMessage、ToolMessage、final assistant 的持久化时机、maxIterations 计数和 Provider 空响应行为保持现有实现，不在本计划中改变。
- 四个内置 Tool 的参数、成功 payload、分页、字符位置、跳过详情和错误语义完全采用 Design 第 7～13 节，不增加字段。
- 文件名使用 kebab-case；测试放在根 `test/agent`、`test/core`、`test/cli`，通过 `@byte-mentor/*` public API 导入。
- `packages/agent/src/index.ts` 只导出 CLI 组装、测试和调用方需要的公共类型、类与内置 Tool；Workspace 内部遍历 helper 不导出。
- CLI 的 `CliConfig` 增加必填 `workspaceRoot: string`，值为 `loadCliConfig()` 收到的启动 `cwd`；`createRuntime()` 不再次读取全局 cwd。
- 不增加运行时依赖，不创建新 workspace package，不修改通用 Message 为对象 payload，不引入写入、Shell、MCP、glob、正则或多 workspace roots。

## 3. 实现顺序

### Batch 1: Tool 运行时契约与 Registry 边界

建议 commit：`refactor(agent): establish runtime tool contracts`

范围：

- `packages/agent/src/tools/contracts.ts`
- `packages/agent/src/tools/tool-registry.ts`
- `packages/agent/src/providers/provider.ts`
- `packages/agent/src/runner/agent-runner.ts`
- `packages/agent/src/index.ts`
- `test/agent/tool-contracts.test.ts`
- `test/agent/tool-registry*.test.ts`
- 受结果序列化影响的 Runner / Provider 现有测试

目标：

- 将 Tool 执行契约从 Provider 边界迁入 `tools/contracts.ts`，Provider 只保留模型调用需要的 `ToolDefinition`。
- 引入结构化 ToolResult / ToolError、JSON payload 约束和 Runtime 内部的并发资格。该执行属性不进入 Provider schema。
- 让 Registry 在注册时完成名称、说明、schema 和重名检查，并在运行时完成实参校验、异常归一化和结果 JSON 序列化。
- 保持 `ToolDefinition` 排序和 OpenAI Provider 映射行为兼容。

测试：

- 注册阶段对非法名称、空描述、无效 schema 和重名快速失败。
- 运行阶段区分 `unknown_tool`、`invalid_arguments` 和未预期的 `execution_failed`。
- 成功与失败结果均被序列化为完整、可解析的 JSON ToolMessage，且超过 Registry 硬上限时返回 `resource_limit`。
- `list()` 不泄露 `execute`、运行时上下文或并发属性。

Review 重点：

- Provider 适配契约与 Tool 运行时契约是否真正分离。
- Registry 是否是唯一的 schema 校验、异常归一化和序列化边界。
- 契约迁移是否没有把对象 payload 扩散到通用 Message 或 Provider 协议。

TDD 小步：

1. [x] `serializes a successful structured tool result`：迁移 JsonValue、ToolResult、AgentTool 与 ToolExecutionOutput 契约，并验证成功 envelope 的紧凑 JSON；实际新增 1 个目标测试，并迁移受契约影响的现有测试。
2. [x] `rejects invalid tool definitions during registration`：覆盖非法名称、空说明、无效 schema 和重名；注册期快速失败已实现。
3. [x] `normalizes registry execution boundary failures`：覆盖 unknown_tool、invalid_arguments 和 execute throw；结构化错误与失败 JSON 已实现。
4. [x] `rejects non-JSON tool payloads`：覆盖 undefined、非有限数、bigint、函数、symbol、稀疏数组、循环引用和非普通对象；违规结果归一化已实现。
5. [x] `returns resource_limit when serialized output exceeds the hard limit`：成功数据或失败 details 超限后返回完整、受限的合法 JSON；默认上限为 24,000 字符。
6. [x] `projects only model-visible fields from registered tools`：稳定排序和模型字段投影保持兼容；Registry 提供并发资格查询，未声明或未知工具默认串行。
7. [x] `writes serialized tool envelopes into ToolMessage`：Runner 对成功与失败 envelope、Provider 映射、checkpoint 和消息顺序均通过回归测试。

开发进度：

- 2026-07-25：Batch 1 / 小步 1 GREEN。Registry 返回结构化 `result` 与等价 JSON `content`；Runner 使用前者判断状态、后者写入 ToolMessage。全量 151 个测试、typecheck、lint、format check 通过。
- 2026-07-25：Batch 1 / 小步 2 RED。新增 4 个注册期完整性测试；当前 Registry 对非法名称、空说明、无效 schema 和重名均未抛错，目标测试按预期失败（4 failed、6 passed）。
- 2026-07-25：Batch 1 / 小步 2 GREEN。新增 `InvalidToolDefinitionError`、`DuplicateToolError` 和注册期名称、说明、schema、重名校验；移除无效 schema 延迟到 execute 的旧测试。全量 154 个测试、typecheck、lint、format check 通过。
- 2026-07-25：Batch 1 / 小步 3 RED。错误契约测试改为 `code` 字段和完整 `invalid_arguments` 名称，并要求失败结果生成等价 JSON；当前实现仍返回旧 `kind` 字段，且无 schema 时仍接受 null（8 failed、13 passed）。
- 2026-07-25：Batch 1 / 小步 3 GREEN。`ToolError` 收敛为完整错误码联合与可选 details，Registry 统一生成 unknown_tool、invalid_arguments、execution_failed，并拒绝无 schema 时的非对象参数；失败对象与 ToolMessage JSON 保持一致。全量 154 个测试、typecheck、lint、format check 通过。
- 2026-07-25：Batch 1 / 小步 4 RED。新增成功 data 与失败 details 的 JSON 安全边界测试；当前 Registry 会静默丢失 undefined 等字段、改变部分值或接受非普通对象，没有统一替换为 execution_failed（2 failed、10 passed）。
- 2026-07-25：Batch 1 / 小步 4 GREEN。Registry 在唯一序列化入口递归验证完整 ToolResult，只接受 JSON primitive、密集数组和普通对象，拒绝循环引用及所有会被 JSON 静默改变的值；违规结果替换为可序列化的 execution_failed。全量 156 个测试、typecheck、lint、format check 通过。
- 2026-07-25：Batch 1 / 小步 5 RED。新增成功 data 与失败 details 的序列化硬上限测试；当前 ToolRegistry 忽略 `maxSerializedToolResultCharacters` 配置并直接返回超限结果（1 failed、12 passed）。
- 2026-07-25：按用户要求切换为 Batch 级 TDD，并一次性补齐 Batch 1 剩余测试：增加默认 24,000 字符上限、成功/失败超限、并发资格查询与模型可见字段隔离、Runner 失败 envelope 集成测试。Batch 1 定向测试当前 4 failed、60 passed；失败原因仅为序列化上限和 `getConcurrency()` 尚未实现。
- 2026-07-25：Batch 1 GREEN。ToolRegistry 支持可配置序列化上限和默认 24,000 字符限制，超限结果归一化为 resource_limit；新增 runtime-only 并发资格查询，list() 继续只投影 Provider 可见字段；Runner 成功、失败 envelope 及既有 checkpoint/消息顺序回归通过。全量 162 个测试、typecheck、lint、format check 通过。

Batch 1 完成定义：以上小步全部 GREEN，受影响测试、全量测试、typecheck、lint 与 format check 通过；随后停下等待 Review，不自动进入 Batch 2。

### Batch 2: Workspace Policy、真实路径边界与执行上下文

建议 commit：`feat(agent): enforce workspace read boundaries`

范围：

- `packages/agent/src/tools/workspace/workspace-policy.ts`
- `packages/agent/src/tools/workspace/workspace-reader.ts`
- `packages/agent/src/tools/contracts.ts`
- `packages/agent/src/tools/tool-registry.ts`
- `test/agent/workspace-policy.test.ts`
- `test/agent/workspace-reader.test.ts`
- Registry 上下文注入测试

目标：

- 建立可配置的 `WorkspaceAccessPolicy`，固定默认拒绝路径、搜索排除和资源上限。
- 建立 `WorkspaceReader` 的异步路径解析基础，拒绝绝对路径、`..` 越界和真实目标位于工作区外的符号链接。
- 让 ToolRegistry 持有并注入 `ToolExecutionContext`；具体 Tool 保持无状态，不自行读取 `process.cwd()`。

测试：

- 普通相对路径、`.`、绝对路径、`..` 越界和不存在路径。
- 指向工作区内部、外部、被禁止目标和断裂目标的符号链接。
- `.git`、`.byte-mentor`、`.env*` 和 `.env.example` 的默认策略语义。
- Registry 将同一个显式上下文传入 Tool，空 Registry 仍可被 AgentLoop 安全使用。

Review 重点：

- 工作区边界是否基于 canonical realpath，而非字符串前缀。
- 安全策略是否集中在 Workspace 层，没有散落到各个内置 Tool。
- 代码是否只使用 Node.js 异步文件 API。

Batch 2 TDD 状态：

- [x] 测试先行：新增 5 个 Policy 测试、6 个真实文件系统 Reader 测试、2 个 Registry context 测试和 1 个 AgentTool context 契约测试。
- [x] RED 已验证：定向测试 12 failed、28 passed；失败原因是 WorkspaceAccessPolicy / WorkspaceReader 公共 API 尚不存在，以及 Registry 尚未注入 context。
- [x] GREEN：实现 Policy、Reader、WorkspaceError、ToolExecutionContext 与 Registry context 注入，并通过全量验证。

开发进度：

- 2026-07-25：Batch 2 RED。测试使用真实临时目录、文件和符号链接，不 mock 文件系统；覆盖默认/覆盖 Policy、资源上限、普通路径、绝对路径、`..` 越界、不存在/断裂路径、工作区内外及 denied target 符号链接、canonical realpath 前缀绕过和 Registry 同一 context 注入。
- 2026-07-25：Batch 2 GREEN。Policy 集中实现默认/覆盖规则和正整数资源上限；Reader 使用异步 lstat、realpath、stat 完成词法边界、canonical realpath 边界、敏感目标与符号链接校验；Registry 保存并原样注入显式 ToolExecutionContext，同时保留无上下文空 Registry 兼容路径。Batch 2 定向 40 个测试、全量 176 个测试、typecheck、lint 与 format check 全部通过。

### Batch 3: `list_directory` 纵向切片

建议 commit：`feat(agent): add directory listing tool`

范围：

- `packages/agent/src/tools/workspace/workspace-reader.ts`
- `packages/agent/src/tools/builtins/list-directory.ts`
- 内置 Tool 共享的小型参数或输出辅助模块（如确有复用）
- `packages/agent/src/index.ts`
- `test/agent/list-directory.test.ts`

目标：

- 完成直接子项浏览、稳定排序、类型/大小元数据、符号链接显示和禁止项的最小暴露。
- 完成 `offset + limit` 分页和输出预算触发的显式截断。
- 在 Tool 本身定义模型可见说明和完整 JSON Schema，不在 Provider 中拼接文档。

测试：

- 文件、目录、工作区内符号链接、断裂链接和被禁止子项。
- 平台无关排序、`/` 分隔的相对路径、空页和 `nextOffset`。
- 请求 limit 越界、未知字段、路径类型错误和输出预算截断。
- 模型可见说明包含 Use when / Do not use when / Returns / Example。

Review 重点：

- 禁止项是否只返回设计允许的最小信息。
- Tool 是否只是 WorkspaceReader 的模型面向映射，没有复制路径安全逻辑。
- 分页与输出预算是否同时生效且返回合法 JSON。

Batch 3 实施契约：

- 公共入口导出无状态常量 `listDirectoryTool`；它声明 `concurrency: "safe"`，并通过 `ToolExecutionContext.workspaceReader` 访问工作区。
- `WorkspaceReader.listDirectory(path)` 返回规范化目录路径和完整的直接子项集合；Reader 负责路径/符号链接安全、最小 denied 元数据和平台无关稳定排序，不负责模型参数默认值或分页。
- Tool 负责 `path = "."`、`offset = 0` 和 Policy `defaultResultLimit` 默认值，校验 Policy `maxResultLimit`，再执行无状态 `offset + limit` 分页。
- 输出预算按 Registry 最终生成的完整 `{ ok: true, data }` 紧凑 JSON envelope 计算。若加入下一条会超限，当前页返回 `truncatedBy: "output_limit"`、`hasMore: true` 和 `nextOffset = offset + returned`；若连当前 offset 的单个条目都无法容纳，则返回 `resource_limit`，避免返回无法前进的相同 offset。
- Tool 只把预期 `WorkspaceError` 转成同码失败 ToolResult；未预期异常继续抛出，由 Registry 统一归一化为 `execution_failed`。

Batch 3 TDD 状态：

- [x] Batch 2 已以 `cef0d78 feat(agent): enforce workspace read boundaries` 提交。
- [x] RED：一次性完成 `list_directory` 的条目、符号链接、denied 最小暴露、分页、参数、错误、输出预算和模型说明测试。
- [x] GREEN：实现 WorkspaceReader 目录列举与 `listDirectoryTool`，并通过全量验证。

开发进度：

- 2026-07-25：Batch 3 RED。新增 12 个真实文件系统与 Registry 纵向测试；覆盖普通条目稳定排序和元数据、工作区内/断裂/敏感/外部符号链接、denied 最小暴露和禁止进入、真实 `..` 工作区越界与外部目录链接的直接列举拒绝、默认值、分页空页、schema 与 Policy limit、wrong_path_type、完整成功 envelope 输出预算以及四段模型说明。定向测试 12 failed，全部按预期失败于公共入口尚未导出 `listDirectoryTool`；typecheck、lint 和 format check 通过，未写 Batch 3 生产代码。
- 2026-07-25：Batch 3 GREEN。WorkspaceReader 异步列举直接子项并集中完成稳定排序、文件大小、链接目标分类及 denied 最小元数据；无状态 `listDirectoryTool` 提供完整模型说明/schema、Policy 默认值与上限、offset 分页、精确成功 envelope 输出预算和 WorkspaceError 映射。Batch 3 定向 12 个测试、全量 188 个测试、typecheck、lint 与 format check 全部通过。

### Batch 4: `find_files` 纵向切片

建议 commit：`feat(agent): add workspace file discovery tool`

范围：

- `packages/agent/src/tools/workspace/workspace-reader.ts`
- `packages/agent/src/tools/builtins/find-files.ts`
- `packages/agent/src/index.ts`
- `test/agent/find-files.test.ts`
- 需要共享的 Workspace traversal 测试

目标：

- 增加可复用的确定性递归遍历，在进入目录前应用 deniedPaths 和 searchExcludes。
- 使用 canonical directory visited set 防止符号链接循环和重复扫描。
- 实现文件名/相对路径的字面量匹配、大小写选项、稳定排序、无总数分页和遍历资源上限。

测试：

- 文件名与工作区相对路径匹配，大小写敏感/不敏感。
- 排除 node_modules、dist、build、coverage 和所有 deniedPaths。
- 工作区内文件链接、外部/断裂链接、目录链接循环和重复真实目录。
- 稳定路径顺序、`hasMore` / `nextOffset`、输出截断和 traversal hard limit。
- 参数 schema 和模型可见说明的契约测试。

Review 重点：

- 遍历是否保持稳定顺序，且每个真实目录每次调用最多访问一次。
- `find_files` 是否只查找文件路径，没有渗入内容搜索语义。
- 达到硬资源上限时是否返回 `resource_limit`，而不是伪装成完整结果。

Batch 4 实施契约：

- 公共入口导出无状态常量 `findFilesTool`，声明 `concurrency: "safe"`，通过 `ToolExecutionContext.workspaceReader` 访问工作区。
- `WorkspaceReader.walkFiles(path)` 返回规范化起点和全部可搜索文件；Reader 负责异步确定性遍历、denied/searchExcludes、canonical 目录 visited set、符号链接目标安全、稳定路径排序和 `maxTraversalEntries`，Tool 不复制这些文件系统规则。
- 遍历按每层名称的 Unicode 字符串顺序深度优先；第一次到达一个 canonical 真实目录的相对别名获胜，后续目录别名和循环不再进入。visited set 只去重目录，多个安全文件链接仍作为各自可见路径返回。
- 每个从目录中取得的直接子项计入 traversal entry；尝试访问第 `maxTraversalEntries + 1` 项时抛出 `resource_limit`，不返回部分成功。
- 普通文件使用自身字节数；指向工作区内普通文件的链接返回 `type: "symbolic_link"`、目标文件 `sizeBytes` 和 `targetType: "file"`。外部、denied、search-excluded、断裂或非文件目标链接不进入文件结果。
- Tool 对文件名或完整工作区相对路径做字面量 substring 匹配；`caseSensitive: false` 使用确定性的字符串小写比较，不读取文件内容。匹配完成后按完整相对路径排序。
- Tool 负责 `path = "."`、`caseSensitive = false`、`offset = 0`、Policy 默认 limit、Policy max limit、无 `total` 分页和完整成功 envelope 输出预算；单条匹配无法容纳时返回 `resource_limit`。
- Tool 只把预期 `WorkspaceError` 转为同码 ToolResult；未预期异常交由 Registry 归一化。

Batch 4 TDD 状态：

- [x] Batch 3 已以 `b2637fb feat(agent): add directory listing tool` 提交。
- [x] RED：一次性完成字面量匹配、内容隔离、排除规则、链接/循环/去重、边界、分页、输出预算、遍历上限、参数和模型说明测试。
- [x] GREEN：实现可复用 Workspace 文件遍历与 `findFilesTool`，并通过全量验证。

开发进度：

- 2026-07-25：Batch 4 RED。新增 13 个真实文件系统与 Registry 纵向测试；覆盖文件名/完整相对路径字面量匹配、大小写、正文隔离、默认 denied/searchExcludes 及 canonical 目标绕过、内部文件链接、外部/断裂链接、目录别名/循环/去重、真实工作区越界、稳定无总数分页、成功 envelope 输出预算、traversal hard limit、wrong_path_type、schema/Policy limit 和四段模型说明。定向测试 13 failed，全部按预期失败于公共入口尚未导出 `findFilesTool`；typecheck、lint 与 format check 通过，未写 Batch 4 生产代码。
- 2026-07-25：Batch 4 GREEN。WorkspaceReader 新增异步确定性文件遍历，按目录项计数资源、应用可见路径与 canonical 目标策略、用真实目录 visited set 阻止循环和重复扫描，并返回普通文件及安全文件链接；无状态 `findFilesTool` 完成字面量名称/路径匹配、大小写选项、无总数分页、完整成功 envelope 输出预算、schema/说明和 WorkspaceError 映射。Batch 4 定向 13 个测试、全量 201 个测试、typecheck、lint 与 format check 全部通过。

### Batch 5: `read_file` 纵向切片

建议 commit：`feat(agent): add windowed text file reader`

范围：

- `packages/agent/src/tools/workspace/workspace-reader.ts`
- `packages/agent/src/tools/builtins/read-file.ts`
- `packages/agent/src/index.ts`
- `test/agent/read-file.test.ts`
- WorkspaceReader 的文本编码与窗口读取测试

目标：

- 以异步、有扫描上限的方式读取 UTF-8 文本窗口，不因读取文件前部而加载完整大文件。
- 保留原始 LF / CRLF / CR 行尾，处理 UTF-8 BOM，并严格拒绝 NUL 和非法 UTF-8。
- 实现基于 Unicode code point 的 1-based 行列定位、行数/字符上限和可精确续读的 `nextPosition`。

测试：

- UTF-8、UTF-8 BOM、LF、CRLF、CR、emoji/非 BMP code point。
- 空文件、起始行超过 EOF、起始列越界和工作区路径错误。
- 无效 UTF-8、NUL 二进制内容和不支持内容的结构化错误。
- 超长单行、`lineLimit`、字符硬上限、扫描字节上限以及多次续读无重复/无丢失。
- 参数 schema 和模型可见说明的契约测试。

Review 重点：

- 列计数是否基于 Unicode code point，而不是 JavaScript UTF-16 code unit。
- `range`、`eof`、`truncatedBy` 和 `nextPosition` 在边界位置是否一致。
- 字符截断是否保留完整 code point 和合法 JSON，没有对序列化字符串做硬切割。

Batch 5 实施契约：

- 公共入口导出无状态常量 `readFileTool`，声明 `concurrency: "safe"`，通过 `ToolExecutionContext.workspaceReader` 读取文本。
- `WorkspaceReader.readTextWindow(path, options)` 负责路径类型、增量异步读取、严格 UTF-8/NUL 检查、BOM、混合行尾、Unicode code point 行列、扫描预算与精确续读；Tool 只负责参数默认值、Policy 行数上限和错误映射。
- Reader 从 4 KiB 开始按倍增块扫描，窗口一旦具备截断或 EOF 证据即停止 I/O；实际读取字节达到 `maxReadScanBytes` 仍无法确定窗口时返回 `resource_limit`，不按文件总大小预先拒绝。
- 行尾作为所属逻辑行的完整文本单元保留；LF、CR 和 CRLF 消费后续位置均为下一行第 1 列。行末后一列可以读取行尾，再后一列返回 `invalid_arguments`。
- `range` 是首尾返回文本单元的 1-based 闭区间；空窗口为 `null`。字符上限按 Unicode code point 计数，CRLF 不从中间切断。
- `lineLimit` 包含起始位置所在行；只有确有剩余内容时才产生 `line_limit`。字符上限优先于尚未达到的行数上限，并通过同一位置模型生成 `nextPosition`。
- Tool 只把预期 `WorkspaceError` 转为同码 ToolResult；最终 payload 由 Registry 再次执行 JSON 与序列化硬上限校验。

Batch 5 TDD 状态：

- [x] Batch 4 已以 `932cf85 feat(agent): add workspace file discovery tool` 提交。
- [x] RED：一次性完成编码/行尾、Unicode 定位、空窗口、路径与内容错误、行/字符/扫描上限、无损续读、schema 和模型说明测试。
- [x] GREEN：实现增量 UTF-8 文本窗口与 `readFileTool`，并通过全量验证。

开发进度：

- 2026-07-25：Batch 5 RED。新增 14 个真实文件系统与 Registry 纵向测试；覆盖 UTF-8 BOM、LF/CRLF/CR、emoji code point 列、Policy 默认行数、行/字符分页无损续读、空文件/EOF/列边界、非法 UTF-8、NUL、实际扫描字节上限、路径错误、schema/Policy limit 与四段模型说明。定向测试 14 failed，全部按预期失败于公共入口尚未导出 `readFileTool`。
- 2026-07-25：Batch 5 GREEN。WorkspaceReader 新增异步倍增块扫描、严格增量 UTF-8 解码、原始行尾位置模型与精确窗口；无状态 `readFileTool` 完成参数/Policy 映射和 WorkspaceError 归一化。Batch 5 定向 14 个测试、全量 215 个测试、typecheck、lint 与 format check 全部通过。

### Batch 6: `search_text` 纵向切片

建议 commit：`feat(agent): add bounded workspace text search`

范围：

- `packages/agent/src/tools/workspace/workspace-reader.ts`
- `packages/agent/src/tools/builtins/search-text.ts`
- `packages/agent/src/index.ts`
- `test/agent/search-text.test.ts`
- 文本搜索、跳过详情和资源上限的 WorkspaceReader 测试

目标：

- 支持针对单个文件或目录的字面量内容搜索，每个结果表示一条匹配行。
- 返回首次匹配列、同行出现次数和有界预览，并按路径/行号稳定排序。
- 在目录搜索中显式统计和有界返回 binary、invalid UTF-8、过大或不可读文件；单文件搜索则返回相应错误。
- 同时落实单文件、总扫描字节数和遍历项目数上限。

测试：

- 单文件/目录搜索、大小写选项、同行多次出现和 Unicode 列号。
- 300 字符预览、匹配附近截取、`previewRange` 和 `previewTruncated`。
- 递归搜索跳过详情上限、完整 `skippedFileCount` 以及单文件直接失败语义。
- 稳定排序、分页、输出截断、单文件大小上限、总扫描上限和 traversal hard limit。
- 参数 schema 和模型可见说明的契约测试。

Review 重点：

- 搜索是否复用 Workspace 路径、遍历和编码能力，而非在 Tool 中建立第二套安全规则。
- 一条结果是否代表一条匹配行，不是每次 substring 出现。
- 总扫描或遍历硬上限是否中止为 `resource_limit`，没有返回易被误解为完整的部分成功。

Batch 6 实施契约：

- 公共入口导出无状态常量 `searchTextTool`，声明 `concurrency: "safe"`，通过 `ToolExecutionContext.workspaceReader` 搜索单文件或目录。
- `WorkspaceReader.searchText(path, options)` 复用 `resolvePath()` 与 `walkFiles()`；Reader 负责严格 UTF-8/NUL 分类、顺序文件读取、总扫描计数、逐行字面量匹配、跳过详情和稳定排序，Tool 不复制路径或编码规则。
- 单文件大于 `maxSearchFileBytes` 返回 `resource_limit`，二进制/非法 UTF-8 返回 `unsupported_content`，不可读返回 `access_denied`；目录搜索分别记录 `file_too_large`、`binary`、`invalid_utf8`、`unreadable`，并保留完整 `skippedFileCount` 与至多 `maxSkippedFileDetails` 条稳定详情。
- 总扫描字节在启动下一文件前按已知大小检查，并在真实读取后再次校验；超过 `maxSearchTotalBytes` 返回 `resource_limit`，不交付部分匹配。目录遍历上限继续由 `walkFiles()` 统一执行。
- 匹配只发生在单个逻辑行的 Unicode code point 数组内；大小写不敏感时逐 code point 折叠，同一行使用非重叠出现次数，首次位置和预览范围均为原始文本 1-based code point 列。
- 预览最多 300 个 code point，以首次匹配前最多 150 个字符为锚点，靠近行尾时向前补足；行尾不进入预览。
- Tool 负责 `offset + limit`、无总数分页和完整成功 envelope 输出预算；无法容纳下一条完整匹配时返回 `resource_limit`。

Batch 6 TDD 状态：

- [x] Batch 5 已以 `d9abe96 feat(agent): add windowed text file reader` 提交。
- [x] RED：一次性完成单文件/目录匹配、Unicode 列与同行计数、预览、跳过详情、分页/输出预算、文件/总扫描/遍历上限、schema 和模型说明测试。
- [x] 补充 RED：撤去不可读文件归一化后，真实权限测试按预期失败；恢复最小分支后 GREEN。
- [x] GREEN：实现 Workspace 文本搜索与 `searchTextTool`，并通过全量验证。

开发进度：

- 2026-07-25：Batch 6 RED。新增 13 个真实文件系统与 Registry 纵向测试；覆盖单文件/目录字面量搜索、大小写、同行多次出现、Unicode 列、跨行隔离、300 字符预览、binary/invalid UTF-8/过大文件跳过及单文件失败、稳定分页、输出预算、总扫描/遍历上限、schema/Policy limit 与四段模型说明。定向测试 13 failed，全部按预期失败于公共入口尚未导出 `searchTextTool`。
- 2026-07-25：Batch 6 补充 RED/GREEN。新增真实不可读文件测试，验证目录搜索返回受限 `unreadable` 详情、显式单文件搜索返回 `access_denied`；撤去实现时 1 failed、13 passed，恢复最小错误映射后 14 passed。
- 2026-07-25：Batch 6 GREEN。WorkspaceReader 新增复用安全遍历的顺序内容搜索、严格内容分类、单文件与总扫描预算、Unicode 行匹配与预览；无状态 `searchTextTool` 完成默认值、无总数分页、输出预算、schema/说明和 WorkspaceError 映射。Batch 6 定向 14 个测试、全量 229 个测试、typecheck、lint 与 format check 全部通过。
- 2026-07-25：Batch 5/6 Review 修复。`$review-agent` 确认 3 个问题：字符边界拆分 CRLF、不可读文件泄露绝对路径、Unicode/转义正文超过完整 JSON 预算。新增 3 个 RED 回归测试后，Reader 延迟尾随 CR 判定并归一化读取权限错误，`readFileTool` 按完整成功 envelope 二分收缩字符预算；全量 232 个测试、typecheck、lint 与 format check 全部通过。报告见 `.agents/.session/read-only-runtime-tools-batch5-6-review.md`。

### Batch 7: 只读 Tool Call 有界并发与 RuntimeEvent 收敛

建议 commit：`feat(agent): run read-only tool calls concurrently`

范围：

- `packages/agent/src/runner/agent-runner.ts`
- `packages/agent/src/tools/contracts.ts`
- `packages/agent/src/tools/tool-registry.ts`
- `packages/core/src/runtime-event.ts`
- `test/agent/agent-runner.test.ts`
- `test/agent/headless-turn.integration.test.ts`
- `test/core/runtime-event.test.ts`

目标：

- 当同一 AssistantMessage 的 Tool Call 全部明确允许并发时，使用默认上限为 4 的计数信号量/并发限制器执行。
- 采用保守的混合批次规则：只要批次中存在未声明可并发的 Tool，整批按原顺序串行，避免为未来写入 Tool 提前引入隐式并发。
- ToolMessage 和 checkpoint 始终按原始 Tool Call 顺序组装；单个只读调用失败不取消同批其他调用。
- 将 Tool RuntimeEvent 收敛为耗时、输出字符数、500 字符预览或结构化错误元数据，不复制完整 ToolResult。

测试：

- 通过可控 Promise 证明多个内置只读调用会重叠执行，且 in-flight 数从不超过 `maxConcurrentToolCalls`。
- 未声明并发资格或混合资格的批次保持串行。
- 完成顺序被人为打乱时，ToolMessage、working messages 和 `tools_completed` checkpoint 仍按原调用顺序。
- 一个调用失败时其他调用仍完成；参数解析失败仍产生对应位置的 ToolMessage。
- completed / failed event 包含新观测字段，preview 按 Unicode code point 截断且完整结果只存在于 ToolMessage。
- 原有 awaiting-tools checkpoint 失败时仍不启动任何 Tool。

Review 重点：

- 并发限制是否作用于整个 Tool Call 生命周期，没有无上限创建已开始的 Promise。
- 并发是否只影响执行时间，没有改变模型轨迹、checkpoint 和恢复语义。
- RuntimeEvent 是否仅用于观测，完整结果仍以 ToolMessage 为唯一模型输入来源。

### Batch 8: CLI 组装与只读感知闭环

建议 commit：`feat(cli): wire read-only workspace tools`

范围：

- `packages/agent/src/loop/agent-loop.ts`
- `packages/agent/src/index.ts`
- `apps/cli/src/config.ts`
- `apps/cli/src/run-chat.ts`
- `test/agent/agent-loop.test.ts`
- `test/agent/headless-turn.integration.test.ts`
- `test/cli/config.test.ts`
- `test/cli/run-chat.test.ts`

目标：

- 让 AgentLoop 支持注入已组装的 ToolRegistry，缺省时继续使用空 Registry。
- CLI 将启动时 `cwd` 作为显式 `workspaceRoot`，组装 Policy、WorkspaceReader、ToolExecutionContext 和注册了四个内置 Tool 的 Registry。
- 使用临时工作区和 fake provider 验证 list -> find -> search -> read 闭环，不访问真实模型 API。

测试：

- CLI 配置保留启动 `cwd` 作为 `workspaceRoot`，不由 Tool 执行时重新读取全局 cwd。
- 真实 Runtime 向 Provider 暴露四个稳定排序的 ToolDefinition。
- AgentLoop 注入 Registry 和缺省空 Registry 两条路径均通过现有 turn/checkpoint 测试。
- fake provider 完成目录列表、文件查找、内容搜索和分段读取，ToolMessage 全部是可解析 JSON。
- 尝试读取工作区外、`.env`、`.git` 和 `.byte-mentor` 均返回结构化拒绝。

Review 重点：

- CLI 是否是唯一的应用组装层，AgentLoop 是否仍不依赖具体文件系统实现。
- workspaceRoot 是否在 Runtime 创建时固定，不会被后续 `process.cwd()` 变化影响。
- smoke 是否经过真实 AgentLoop / AgentRunner / Registry / Tool 链路，同时保持纯本地且可重复。

## 4. 最终验收

所有 Batch 完成后统一执行：

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

同时确认：

- 四个 Tool 可完成“列目录 -> 找文件 -> 搜内容 -> 分段读取”。
- 模型无法突破 workspaceRoot 或读取默认 deniedPaths。
- 所有结果都是完整 JSON，所有分页、跳过和截断都显式可见。
- 只读 Tool Call 有界并发，未声明并发资格的 Tool 保持串行。
- 四个 Tool 不启动 Shell，不依赖 `rg` 或其他外部命令。
- 现有 Provider、Session、checkpoint、restore 和消息顺序行为无回归。

## 5. 明确不在本计划内

- 写入、编辑、Shell 或 MCP Tool。
- 单个 `find_files` / `search_text` 内部的多文件 worker pool。
- 跨 Tool Call 的整轮总扫描预算；第一阶段依靠单调用上限与默认并发度 4 控制放大。
- glob、正则搜索、非 UTF-8 自动猜测和二进制 Base64 返回。
- 多 workspace roots、实时 RuntimeEvent callback 和独立完整审计存储。
- 为 Tool 体系新建 workspace package，或将结构化 payload 扩散到通用 Message 类型。

## 6. 计划 Review 检查表

- Batch 是否足够完整，可以作为一个 commit 审阅，而没有被拆成“先测试、后实现”的人工碎片。
- 四个 Tool 各自形成一个可运行、可测试、可 Review 的纵向切片。
- 安全基础、Tool 契约、并发调度和 CLI 组装没有被混入某个具体 Tool commit。
- 每批都有明确的测试和 Review 重点，且前一批结束时仓库保持 GREEN。
