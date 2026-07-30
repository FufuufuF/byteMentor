# Byte Mentor

Byte Mentor 当前提供一个本地多轮交互闭环：

```text
交互式 TUI -> SQLite session -> AgentLoop / AgentRunner -> OpenAI-compatible provider / tools -> 实时渲染并保存消息
```

## 安装

先安装依赖并构建 workspace，CLI bin 指向构建后的 `dist` 文件：

```bash
pnpm install
pnpm build
```

## 配置

交互命令从环境变量读取配置：

| 变量                          | 必填 | 说明                                                                         |
| ----------------------------- | ---- | ---------------------------------------------------------------------------- |
| `OPENAI_API_KEY`              | 是   | API key。使用兼容 OpenAI Chat Completions 的服务时，也通过这个变量传入 key。 |
| `BYTE_MENTOR_MODEL`           | 是   | Chat Completions 模型名，例如 `.env.example` 中的 `deepseek-v4-pro`。        |
| `BYTE_MENTOR_OPENAI_BASE_URL` | 否   | 可选的 OpenAI-compatible base URL。使用官方 OpenAI 时可以不设置。            |
| `BYTE_MENTOR_DB_PATH`         | 否   | 可选 SQLite 路径。相对路径会按当前工作目录解析。                             |

可以从 `.env.example` 创建本地 `.env`，再导出到当前 shell：

```bash
cp .env.example .env
# 编辑 .env，填入真实 key
set -a
source .env
set +a
```

CLI 不会自动加载 `.env`，环境变量必须已经存在于当前进程环境中。

## 运行交互式 TUI

建议在 repo 根目录运行。默认 SQLite 数据库会生成在 `.byte-mentor/byte-mentor.sqlite`。

不带初始消息时，TUI 启动后等待输入：

```bash
pnpm exec node apps/cli/dist/index.js chat
```

也可以提供一条自动提交的 initial message；首轮完成后仍会停留在同一个 TUI 中：

```bash
pnpm exec node apps/cli/dist/index.js chat "解释一下 Promise"
```

也可以用 inline env 运行：

```bash
OPENAI_API_KEY=sk-... BYTE_MENTOR_MODEL=deepseek-v4-pro BYTE_MENTOR_OPENAI_BASE_URL=https://api.deepseek.com pnpm exec node apps/cli/dist/index.js chat "解释一下 Promise"
```

如果使用官方 OpenAI，可以去掉 `BYTE_MENTOR_OPENAI_BASE_URL`，并把 `BYTE_MENTOR_MODEL` 换成实际要用的 Chat Completions 模型。

这里直接用 `node apps/cli/dist/index.js` 是因为本地 workspace 中 `@byte-mentor/cli` 的 `bin.byte-mentor` 还没有被安装成可执行命令；`pnpm --filter @byte-mentor/cli exec byte-mentor ...` 在当前包内部找不到这个 bin。直接从 repo 根执行 dist 入口可以保证 `process.cwd()` 是 repo 根目录，默认数据库路径也会保持为 `.byte-mentor/byte-mentor.sqlite`。

普通 Enter 提交，Shift+Enter 或 Ctrl+J 换行。空闲时 Ctrl+C，或空输入时 Ctrl+D，正常退出。生成期间按 Ctrl+C 会显示延迟退出状态，并在当前 turn 完成、SQLite 关闭后退出。

同一进程中的后续问题复用同一个 sessionId；每次重新启动进程会创建新 session。当前不支持跨进程 resume 或 session picker。

## Smoke 验证

首次运行后查看数据库：

```bash
sqlite3 .byte-mentor/byte-mentor.sqlite "SELECT id, created_at FROM sessions"
sqlite3 .byte-mentor/byte-mentor.sqlite "SELECT seq, role FROM messages"
```

应能看到一条 session，并且 `messages` 中至少有一条 `user` 和一条 `assistant`，按 `seq` 递增。

在同一个 TUI 中连续提交多个问题，数据库应仍只有本次进程创建的一条 session，并按顺序包含多轮 user、assistant 和 tool 消息。退出后重新运行命令会创建另一条 session。

每次运行结束后，`.byte-mentor/byte-mentor.sqlite` 不应残留 `-journal` 或 `-wal` 文件。如果进程退出后这些文件仍然存在，需要检查 store close 路径。

也可以用错误 API key 或断网验证失败路径。单轮失败会显示在 transcript 中，TUI 保持运行并允许继续提交；启动或终端初始化失败才返回非零退出码。

## 当前范围

当前代码已经实现：

- SQLite-backed session 和 message 存储。
- OpenAI Chat Completions provider。
- assistant content 的真实逐事件 streaming。
- RuntimeEvent 与工具 pending/running/success/error 卡片。
- 基于 pi-tui 的 Markdown、多行 Editor、响应式 Footer 和 CJK/emoji 安全布局。
- 进程内多轮对话与同一 sessionId 复用。

当前阶段不实现：

- Knowledge、Teaching Brief 或 Observation Log。
- Responses API。
- 多 provider 注册中心。
- session compact 或 summary。
- SQLite 迁移框架。
- 真实 OpenAI API 集成测试。
- `--session`、session 列表、跨进程恢复或标题生成。
- 生成期间取消、steer/follow-up queue、session/model/theme selector。
