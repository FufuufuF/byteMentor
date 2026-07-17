# Byte Mentor

Byte Mentor 目前处在 agent runtime bring-up 阶段。当前代码提供一个最小本地 smoke 闭环：

```text
CLI 输入 -> SQLite session -> OpenAI Chat provider -> AgentLoop / AgentRunner -> 保存消息 -> 输出 assistant 回复
```

## 安装

先安装依赖并构建 workspace，CLI bin 指向构建后的 `dist` 文件：

```bash
pnpm install
pnpm build
```

## 配置

Smoke 命令从环境变量读取配置：

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

## 运行 Smoke

建议在 repo 根目录运行。默认 SQLite 数据库会生成在 `.byte-mentor/byte-mentor.sqlite`。

如果使用 `.env.example` 中的配置形态，可以直接导出 `.env` 后运行：

```bash
pnpm exec node apps/cli/dist/index.js chat "解释一下 Promise"
```

也可以用 inline env 运行：

```bash
OPENAI_API_KEY=sk-... BYTE_MENTOR_MODEL=deepseek-v4-pro BYTE_MENTOR_OPENAI_BASE_URL=https://api.deepseek.com pnpm exec node apps/cli/dist/index.js chat "解释一下 Promise"
```

如果使用官方 OpenAI，可以去掉 `BYTE_MENTOR_OPENAI_BASE_URL`，并把 `BYTE_MENTOR_MODEL` 换成实际要用的 Chat Completions 模型。

这里直接用 `node apps/cli/dist/index.js` 是因为本地 workspace 中 `@byte-mentor/cli` 的 `bin.byte-mentor` 还没有被安装成可执行命令；`pnpm --filter @byte-mentor/cli exec byte-mentor ...` 在当前包内部找不到这个 bin。直接从 repo 根执行 dist 入口可以保证 `process.cwd()` 是 repo 根目录，默认数据库路径也会保持为 `.byte-mentor/byte-mentor.sqlite`。

预期结果：终端流式打印 assistant 回复，结束后本轮消息写入 SQLite。

## Smoke 验证

首次运行后查看数据库：

```bash
sqlite3 .byte-mentor/byte-mentor.sqlite "SELECT id, created_at FROM sessions"
sqlite3 .byte-mentor/byte-mentor.sqlite "SELECT seq, role FROM messages"
```

应能看到一条 session，并且 `messages` 中至少有一条 `user` 和一条 `assistant`，按 `seq` 递增。

不要删除 `.byte-mentor/`，再次运行：

```bash
pnpm exec node apps/cli/dist/index.js chat "换个方式解释"
```

当前阶段还没有实现 `--session`，所以 CLI 每次启动都会创建新 session。同一个 SQLite 文件中此时应该能看到两条 session。

每次运行结束后，`.byte-mentor/byte-mentor.sqlite` 不应残留 `-journal` 或 `-wal` 文件。如果进程退出后这些文件仍然存在，需要检查 store close 路径。

也可以用错误 API key 或断网验证失败路径。CLI 应打印清晰错误，不泄露 key，并且 SQLite store 仍应被关闭。

## 当前范围

当前代码已经实现：

- SQLite-backed session 和 message 存储。
- OpenAI Chat Completions provider。
- 最终 assistant content 的 provider streaming。
- 非 TUI 的 CLI smoke command。

当前阶段不实现：

- Knowledge、Teaching Brief 或 Observation Log。
- TUI。
- Responses API。
- 多 provider 注册中心。
- session compact 或 summary。
- SQLite 迁移框架。
- 真实 OpenAI API 集成测试。
- `--session`、session 列表、标题生成或多轮交互 shell。
