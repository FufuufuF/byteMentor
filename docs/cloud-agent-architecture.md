# Byte Mentor 云端 Agent 架构设计

## 1. 文档目的

本文档记录 Byte Mentor 从本地单用户 Agent 应用演进为云端多租户 Agent 系统时的总体架构方向。

当前阶段主要确定：

- 系统的三个主要部署单元。
- Go 后端与 TypeScript Agent Runtime 的职责边界。
- 一个 Session 对应一个活跃容器的生命周期模型。
- 现有 TypeScript monorepo 的演进方式。
- 云端状态、容器状态与工作区数据的归属。

本文档是方向性设计，不提前固化具体云厂商、容器编排平台、数据库表结构或内部 API 字段。

## 2. 核心架构结论

Byte Mentor 云端版本划分为三个主要部署单元：

1. Web 前端。
2. Go Control Plane。
3. 运行 TypeScript Agent Worker 的隔离容器。

总体结构如下：

```text
┌─────────────────────┐
│      Web 前端        │
│                     │
│ 对话、学习状态、历史  │
└──────────┬──────────┘
           │ HTTPS / SSE
           ▼
┌──────────────────────────────┐
│       Go Control Plane       │
│                              │
│ Auth / Tenant / Session      │
│ Run / Queue / Quota          │
│ Sandbox 调度 / 生命周期管理   │
│ PostgreSQL / Observability   │
└──────────┬───────────────────┘
           │ 内部协议
           │ 启动、执行、取消、回收
           ▼
┌──────────────────────────────┐
│   Session Sandbox Container  │
│                              │
│ apps/agent-worker            │
│       ↓                      │
│ packages/agent               │
│ packages/knowledge           │
│ packages/core                │
│ Tools / Bash / Workspace     │
└──────────────────────────────┘
```

其中：

- 前端只访问 Go Control Plane，不直接访问 Agent 容器。
- Go 负责管理 Agent 的创建、调度、状态和资源。
- TypeScript 负责运行已有 AgentLoop、AgentRunner、Provider、Tools 和教学逻辑。
- PostgreSQL 等外部存储保存系统的权威状态。
- Agent 容器是可回收、可重建的临时计算资源。

## 3. 部署单元与代码 Package 的区别

部署单元和代码 package 不是同一层概念。

当前的 `packages/agent` 是一个 TypeScript 库，导出 AgentLoop、AgentRunner、Provider 和工具等能力。它没有独立进程入口、网络协议、健康检查和容器生命周期，因此不能被单独作为一个服务部署。

云端版本应在 `packages/agent` 外增加一个很薄的可执行应用：

```text
apps/agent-worker
```

容器实际启动的是 `apps/agent-worker`。该应用在运行时加载并组装 `packages/agent` 及其依赖。

```text
Docker Container
└── apps/agent-worker          可执行进程入口
    ├── packages/agent         Agent Runtime 库
    ├── packages/knowledge     教学与知识逻辑
    ├── packages/core          共享基础类型
    └── Cloud Adapter          与 Go 后端通信
```

因此，Agent 容器不是另一个面向用户的业务后端。更准确的定位是：

> Agent Worker 是由 Go Control Plane 管理的、运行在隔离环境中的 Agent Runtime Host。

## 4. 三个部署单元的职责

### 4.1 Web 前端

Web 前端负责：

- 用户登录和交互界面。
- 创建、选择和查看学习 Session。
- 提交用户输入。
- 显示 Agent 流式输出和工具执行状态。
- 展示历史消息、知识状态和学习记录。
- 请求取消当前 Run。

Web 前端不负责：

- 直接创建或管理容器。
- 直接调用 Agent Worker。
- 保存权威 Session 状态。
- 执行模型或工具调用。

### 4.2 Go Control Plane

Go 服务是系统的业务后端和控制平面，负责：

- 用户身份认证与授权。
- Tenant、User、Session、Run 等领域对象的管理。
- 多租户数据隔离。
- 创建、排队、调度和取消 Run。
- 创建、检查、停止和回收 Agent 容器。
- 控制全局和租户级并发、配额与限流。
- 将 Agent RuntimeEvent 持久化并转发给前端。
- 管理 PostgreSQL 等权威数据源。
- 记录日志、指标和 Trace。
- 处理超时、失败、重试与恢复。

Go Control Plane 不负责重新实现 AgentLoop 或教学逻辑。

### 4.3 TypeScript Agent Worker

Agent Worker 运行在 Session 的隔离容器内，负责：

- 读取容器配置和当前 Session/Run 身份。
- 初始化 Agent Runtime。
- 执行 AgentLoop 和 AgentRunner。
- 调用模型 Provider。
- 注册并执行文件、Shell 等工具。
- 使用当前 Session 的独立工作区。
- 接收 Turn 执行和取消请求。
- 将 RuntimeEvent、消息、checkpoint 和最终结果上报给 Go。
- 响应健康检查并支持优雅关闭。

Agent Worker 不负责：

- 用户身份认证。
- 创建 Tenant 或云端 Session。
- 决定系统级配额。
- 直接向公网前端提供服务。
- 持有数据库管理员凭据。
- 将重要状态只保存在容器内存或临时文件系统中。

## 5. 核心领域概念

云端实现需要明确区分以下概念：

### 5.1 Session

Session 表示一个长期存在的学习会话，包含多轮历史、知识上下文和工作区关联。

Session 是逻辑实体，其生命周期不依赖某一个具体容器。

### 5.2 Turn

Turn 表示一次用户输入及对应的 Agent 处理过程。

同一个 Session 内的 Turn 第一阶段采用串行执行，避免多个 Agent 执行同时读取相同历史并产生写入冲突。

### 5.3 Run

Run 表示一次可调度、可观察、可取消的执行任务。第一阶段可以让一个 Turn 对应一个 Run。

典型状态机为：

```text
queued -> provisioning -> running -> completed
                                 \-> failed
                                 \-> cancelled
                                 \-> timed_out
```

### 5.4 Sandbox Container

Sandbox Container 是运行 Agent Worker 的临时计算环境，负责提供进程、文件系统和资源隔离。

容器不是 Session 的权威状态源。容器被删除后，Session 仍然存在，并能够从外部持久化状态恢复。

## 6. 一个 Session 一个容器

当前暂定采用：

> 一个活跃 Session 在同一时间最多绑定一个 Agent 容器。

这里的“一 Session 一容器”不是指容器与 Session 永久共存，而是指活跃期间保持亲和性：

```text
创建 Session
    ↓
用户提交第一个 Turn
    ↓
Go 创建 Session Container
    ↓
多轮 Turn 复用同一容器和工作区
    ↓
Session 长时间空闲
    ↓
持久化必要状态并回收容器
    ↓
下一次交互时重新创建并恢复
```

这个模型的优点包括：

- 多轮交互无需每轮冷启动容器。
- Session 工作目录能够在连续交互中自然复用。
- Agent 进程可以保留可丢弃的本地缓存。
- 不同 Session 之间具有明确的执行和工作区隔离。

需要解决的问题包括：

- 空闲容器回收策略。
- 容器异常退出后的重建与恢复。
- 同一个 Session 的并发 Turn 串行化。
- Session 数量较多时的资源占用。
- 容器与持久化工作区的绑定和清理。

## 7. 一次 Turn 的执行链路

一次典型执行流程如下：

```text
1. 前端向 Go 提交用户输入
2. Go 鉴权并校验 Tenant、Session 和配额
3. Go 创建 queued 状态的 Run
4. 调度器检查 Session 是否已有健康容器
5. 若没有，创建容器并等待 Agent Worker ready
6. Go 向 Agent Worker 下发 Turn
7. Agent Worker 恢复 Session 上下文并执行 AgentLoop
8. Agent Worker 持续上报 RuntimeEvent 和流式内容
9. Go 持久化事件，并通过 SSE 推送给前端
10. Agent Worker 上报最终结果
11. Go 将 Run 更新为终态
12. 容器继续等待下一轮，或在空闲超时后被回收
```

同一个 Session 在存在运行中 Run 时，新输入默认进入 Session 队列，而不是并行启动第二次 AgentLoop。

## 8. Go 与 Agent Worker 的通信

第一阶段建议使用容器内部 HTTP 协议，便于实现、调试和观察。

Agent Worker 可以暴露类似的内部接口：

```text
GET  /health
GET  /ready
POST /turns
POST /turns/{turnId}/cancel
GET  /status
```

Agent Worker 通过 Go 的内部接口上报：

```text
POST /internal/runs/{runId}/events
POST /internal/runs/{runId}/checkpoints
POST /internal/runs/{runId}/complete
POST /internal/runs/{runId}/fail
```

后续如果动态容器寻址或双向控制成为问题，可以演进为 Agent Worker 主动连接 Go 的 WebSocket 或 gRPC 双向流。

Go 与 TypeScript 之间的协议需要有独立、稳定的契约来源，可以选择：

- OpenAPI。
- Protocol Buffers。
- JSON Schema。

不应分别手写两套缺乏校验的 Go 和 TypeScript 类型。

## 9. 状态与数据归属

### 9.1 外部权威状态

以下状态应由 Go 和外部持久化系统管理：

- Tenant 和 User。
- Session 和 Message。
- Turn 和 Run。
- RuntimeEvent。
- Knowledge Tree 和 Learning Evidence。
- 用户知识状态。
- Run checkpoint。
- Sandbox 元数据。
- 配额、用量和审计记录。

Agent 容器崩溃后，这些状态不能丢失。

### 9.2 容器临时状态

容器内可以保留：

- 当前 AgentLoop 的进程状态。
- 当前工具执行状态。
- 临时文件和可丢弃缓存。
- Provider 的流式响应状态。
- 当前活跃 Run 的取消控制器。

### 9.3 Session 工作区

一个 Session 对应一个独立工作区。第一阶段可以使用 Docker named volume，在容器回收和重建之间保留文件。

后续可以根据部署环境演进为：

- 持久化卷。
- 对象存储快照。
- Git 仓库。
- 独立 Workspace Service。

工作区的生命周期和访问权限必须绑定 Tenant 与 Session。

## 10. 对现有 Monorepo 的建议改造

建议继续使用一个 monorepo，初步结构如下：

```text
byteMentor/
├── apps/
│   ├── web/                    # Web 前端
│   ├── cli/                    # 现有本地 CLI
│   └── agent-worker/           # TS 容器进程入口
│
├── services/
│   └── control-plane/          # Go 后端
│       ├── cmd/server/
│       ├── internal/api/
│       ├── internal/auth/
│       ├── internal/session/
│       ├── internal/run/
│       ├── internal/scheduler/
│       └── internal/sandbox/
│
├── packages/
│   ├── agent/                  # AgentLoop、Runner、Tools
│   ├── knowledge/              # 教学和知识状态逻辑
│   ├── core/                   # TS 内部基础类型
│   ├── protocol/               # 跨语言协议定义或生成代码
│   ├── session/                # Session 抽象或本地适配
│   └── tui/                    # 本地 CLI 界面
│
└── deploy/
    ├── agent-worker.Dockerfile
    ├── control-plane.Dockerfile
    └── docker-compose.yml
```

当前 `apps/cli` 与未来 `apps/agent-worker` 都是 composition root：

```text
apps/cli
├── SQLite SessionStore
├── 本地工作区
├── TUI
└── packages/agent

apps/agent-worker
├── Cloud Session Adapter
├── 容器工作区
├── Worker Transport
└── packages/agent
```

两者复用同一个 Agent Runtime，但使用不同的输入输出和基础设施适配器。

## 11. 当前代码需要演进的接口

### 11.1 SessionStore 的远程化

当前 SessionStore 的 `updateMetadata(id, updater)` 接收一个本地回调函数。函数不能通过网络传输，因此不适合作为 Go Control Plane 的远程接口。

云端实现应逐步改为显式操作，例如：

```text
patchMetadata(sessionId, patch, expectedVersion)
saveCheckpoint(sessionId, checkpoint, expectedVersion)
clearCheckpoint(sessionId, expectedVersion)
```

这些操作需要结合版本号、唯一约束或其他并发控制机制，避免多个写入互相覆盖。

### 11.2 云端 Session 的创建权

当前 AgentLoop 在没有传入 sessionId 时可以自行创建 Session。本地 CLI 可以保留这个行为；云端 Agent Worker 必须执行由 Go 创建并授权的 Session。

云端 Turn 输入至少需要包含：

```text
tenantId
sessionId
runId
turnId
userMessage
```

Agent Worker 不应自行创建 Tenant 或云端 Session。

### 11.3 RuntimeEvent 的可靠传输

当前 RuntimeEvent 主要通过进程内 callback 传递。云端版本需要增加 EventSink 或上报客户端，并明确：

- 事件序号。
- 重复上报的幂等处理。
- 网络暂时失败时的缓冲与重试。
- Run 完成前关键事件的落盘要求。
- 前端断线重连后的事件恢复。

## 12. Agent 容器安全边界

Byte Mentor 的 Agent 具备 Bash 和文件操作能力，因此容器需要作为明确的安全边界设计。

至少应满足：

- 使用非 root 用户运行。
- 不挂载 Docker socket。
- 不挂载宿主机敏感目录。
- 每个 Session 使用独立工作区。
- 限制 CPU、内存、进程数、磁盘和执行时间。
- 不向容器提供数据库管理员凭据。
- 使用短期、仅限当前 Session/Run 的内部访问令牌。
- 控制容器的网络访问范围。
- 容器结束后执行可靠清理。
- Go 对 Agent Worker 上报的 tenantId、sessionId 和 runId 做服务端校验。

Docker 可以作为第一阶段的隔离方式，但不应默认被视为运行任意不可信代码时的绝对安全沙箱。后续可以按需求评估 gVisor、Kata Containers 或 Firecracker 等更强隔离方案。

## 13. 第一阶段实现边界

为了控制复杂度，第一阶段建议：

- 使用模块化 Go 单体，而不是拆分多个微服务。
- 使用 PostgreSQL 保存权威数据。
- 使用 Docker Engine 管理 Session 容器。
- 使用内部 HTTP 完成 Go 与 Agent Worker 通信。
- 使用 SSE 向前端推送事件。
- 同一 Session 内串行执行 Run。
- 使用空闲超时回收容器。
- 使用 Docker volume 保留 Session 工作区。
- 先实现清晰的状态机、幂等和恢复，再引入专用消息中间件。

第一阶段暂不要求：

- Kubernetes。
- Kafka 或复杂事件总线。
- 服务网格。
- 跨地域调度。
- 自动扩缩容系统。
- 完整商业化计费。
- 支持任意不可信代码的强安全沙箱。

## 14. 后续待设计事项

以下问题需要在详细设计阶段继续确定：

- Session 容器的空闲回收时间。
- 容器创建失败和 Worker 失联时的重试策略。
- Run、Turn 与 AgentLoop checkpoint 的准确映射。
- Agent Worker 内部 HTTP API 的具体契约。
- RuntimeEvent 的版本化与事件序号设计。
- PostgreSQL 表结构和租户隔离策略。
- Session 队列的第一版实现方式。
- Provider API key 由平台托管还是用户自带。
- Session 工作区的持久化、快照和清理策略。
- 容器出站网络和工具权限策略。
- Knowledge 数据由 Worker 直接计算后提交，还是由独立领域服务管理。

## 15. 总结

Byte Mentor 云端版本的核心边界是：

> Go Control Plane 管理 Tenant、Session、Run、调度、容器和资源；TypeScript Agent Worker 在 Session 级隔离容器中复用现有 Agent Runtime；外部存储保存所有可恢复的权威状态。

现有 `packages/agent` 保持为纯 Agent Runtime 库，不直接承载网络和容器逻辑。新增的 `apps/agent-worker` 负责把这个库包装成可以由 Go 调度、监控、取消和回收的容器进程。
