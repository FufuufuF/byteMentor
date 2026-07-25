# 只读运行时 Tool 实现计划

## 1. 计划状态

- 状态：开发中（Batch 1 / TDD 小步 1 已完成）
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

- 保留无参构造以支持 AgentLoop 的空 Registry；执行已注册 Tool 时必须已经提供显式上下文。缺少上下文属于 Runtime 组装错误，归一化为 `execution_failed`。
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
}
```

- `workspaceRoot` 在构造时解析并固定；Reader 和 Tool 执行期间都不读取 `process.cwd()`。
- `ToolExecutionContext` 使用必填 `workspaceReader` 字段，不做泛型化，也不新增第二套 Workspace 抽象接口。
- WorkspaceReader 的路径解析、目录列举、遍历、窗口读取和文本搜索方法按对应 Batch 的最小行为逐步加入；这些方法返回内部结构化数据，并以一个 `WorkspaceError` 类表达设计中的预期错误码。
- 所有 WorkspaceReader 方法异步；禁止 `node:fs` 同步 API。
- 路径输入先拒绝绝对路径和词法 `..` 越界，再用 canonical realpath 判断真实边界。不存在和断裂目标保留 `path_not_found`，工作区外或策略禁止目标返回 `access_denied`。
- Policy overrides 对数组字段采用整体替换，对数值上限采用逐字段覆盖；所有上限在构造时校验为正整数。
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
2. [ ] `rejects invalid tool definitions during registration`：覆盖非法名称、空说明、无效 schema 和重名；预计 100～180 行。
3. [ ] `normalizes registry execution boundary failures`：覆盖 unknown_tool、invalid_arguments 和 execute throw；预计 100～180 行。
4. [ ] `rejects non-JSON tool payloads`：覆盖非有限数、bigint、循环引用和非普通对象；预计 80～150 行。
5. [ ] `returns resource_limit when serialized output exceeds the hard limit`：验证超限后仍返回完整合法 JSON；预计 50～100 行。
6. [ ] `projects only model-visible fields from registered tools`：验证稳定排序且不泄露 execute、concurrency 或 Runtime 属性；预计 50～100 行。
7. [ ] `writes serialized tool envelopes into ToolMessage`：验证 Runner、Provider、checkpoint 和消息顺序在新契约下不回归；预计 100～180 行。

开发进度：

- 2026-07-25：Batch 1 / 小步 1 GREEN。Registry 返回结构化 `result` 与等价 JSON `content`；Runner 使用前者判断状态、后者写入 ToolMessage。全量 151 个测试、typecheck、lint、format check 通过。

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
