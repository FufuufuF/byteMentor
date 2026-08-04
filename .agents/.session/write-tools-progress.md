# Write-tools 开发进度

## 目标

按 `.agents/.design/write-tools-design.md` 与 `.agents/.plan/write-tools-implementation-plan.md` 实现 `edit_file`、turn 级取消链路、`bash` 三个能力的 Batch 1–6。Batch 0 设计契约已冻结。

## 状态总览

| Batch | 内容 | 状态 | Commit |
|---|---|---|---|
| 0 | 设计契约冻结 | ✅ 完成 | — |
| 1 | 共享路径边界 + 原子编辑能力 | ✅ 完成 | `2981678 refactor(agent): establish workspace edit boundary` |
| 2 | `edit_file` 纵向切片 | ✅ 完成 | `1e537f0 feat(agent): add workspace file edit tool` |
| 3 | turn 级取消链路 | ⬜ 待实现 | — |
| 4 | 受控 Shell 环境 + 一次性进程执行器 | ⬜ 待实现 | — |
| 5 | Shell 输出累加 + 完整日志生命周期 | ⬜ 待实现 | — |
| 6 | `bash` Tool 与 CLI 闭环 | ⬜ 待实现 | — |

分支：`feat/agent-write-tools`。

## 工作方式约定

- 以 batch 为单位一次性写完整测试 + 生产代码，全量验证后停等 review，不逐小步暂停。
- 汇报时区分「测试可直接验证」与「架构重点 review」两类。
- 每个 batch 完成确认后按 plan 建议的 commit message 提交。
- 测试一律使用临时目录/本地子进程，不调用真实模型 API。

## Batch 1 已交付（`2981678`）

范围：`WorkspacePathResolver` / `WorkspaceReader` 重构 / `WorkspaceEditor` / `workspace-policy`。

- **`workspace-path-resolver.ts`（新）**：`WorkspaceError` 单一来源（从 Reader 迁出）、`WorkspacePathResolver.resolveAccessiblePath()` 返回 `{ relativePath, absolutePath, canonicalTarget, canonicalRelativePath, type, isSymbolicLink }`，共享 `isOutsideRoot`/`toWorkspacePath`/`isMissingPathError`。
- **`workspace-reader.ts`（重构）**：持有 resolver 实例，`resolvePath` 委托后投影窄返回；`export { WorkspaceError }` 保持 builtin import 兼容。公共 API 不变，现有测试保持 GREEN。
- **`workspace-editor.ts`（新）**：
  - `readTextSnapshot(path)` → `{ path, content, bom }`：剥离 BOM、严格 UTF-8（NUL/非法拒绝 → `unsupported_content`）、2 MiB 上限（stat 后 + 读取后双检查 → `resource_limit`）。
  - `writeTextAtomically(path, content)`：链接编辑真实目标（`canonicalTarget`）并保留链接目录项；同目录随机名 exclusive-create 0600 临时文件 → 写内容 → chmod 原 mode → rename 原子提交；失败只清理本次临时文件。
- **`workspace-policy.ts`**：`limits.maxEditableFileBytes` 默认 2 MiB；Editor 用 `min(policy, 2 MiB)` 钳制，Runtime 只能降低。
- 测试：`workspace-editor.test.ts` 26 个 + resolver 1 个。全量 34 文件 / 314 测试 + typecheck/lint/format 通过。
- 修复的缺陷：Reader 残留本地 `WorkspaceError` 定义导致 `instanceof` 失效（18 个回归），改为单一来源 + re-export。

## Batch 2 已交付（`1e537f0`）

范围：`edit-diff` 纯函数 / `edit_file` Tool / `contracts` 扩展 / CLI 注册。

- **依赖**：`packages/agent` 增加 `diff@8.0.4`（jsdiff），同步 lockfile。
- **`edit-diff.ts`（新，纯函数）**：`applyEdits(source, edits)` 返回 `{ text, replacements, diff, patch, firstChangedLine? }` 或结构化 edit 错误。
  - 匹配空间：先精确（LF 空间），任一 edit 精确不唯一则全部在模糊空间重定位（NFKC、去行尾空白、智能引号→ASCII、dash→`-`、特殊空格→空格）。
  - 唯一性按最终选定空间计算，重叠候选统计（`aa` 在 `aaa` 计 2 次）；缺失/重复/重叠/嵌套/no-op 返回稳定错误码 + `editIndex`/`occurrences`。
  - 换行：CRLF/CR/LF 统一 LF 匹配，写回按「最先检测到的有效换行」恢复；`rebuildText` 只重建受影响行块（按 B 空间区间切片），未触及行从 A 原始文本复制，避免全文归一化副作用。
  - diff：自定义带行号 + 有限上下文展示；patch：jsdiff `createTwoFilesPatch("a","b",...)`。
- **`edit-file.ts`（新）**：协议硬上限（path ≤ 4096、edits 1–64、单字段 ≤ 65536、聚合 ≤ 262144 Unicode 字符，读取文件前校验）；成功 payload `{ path, replacements, diff, patch, firstChangedLine? }`；预算超限在写入前返回 `resource_limit`；BOM 在写回时恢复；未声明 `concurrency: "safe"`。
- **`contracts.ts`**：`ToolErrorCode` 增加 `edit_target_not_found/not_unique/overlap/no_change`；`ToolExecutionContext` 增加必填 `workspaceEditor`。
- **`run-chat.ts`**：创建 `WorkspaceEditor`、注入 context、注册 `edit_file`。
- 测试：`edit-diff.test.ts` 24 个（纯函数）+ `edit-file.test.ts` 16 个（集成）；4 个只读工具测试补 context、`run-chat.test.ts` 工具列表改 5 个。全量 36 文件 / 356 测试 + typecheck/lint/format 通过。
- 修复的缺陷：`rebuildText` 丢块尾换行；模糊模式 `placeEdit` 用 `oldLf.length` 导致 end 越界（改用归一化后 needle 长度）。

## 待确认的实现决策（Batch 2）

- BOM 恢复在 `edit-file` 层（快照剥离 + 写回加回），`edit-diff` 只处理换行。
- 展示 diff 格式 `@@ -old,count +new,count @@` + 行号前缀行；模糊模式下 `newText` 不做模糊归一化。
- 行号对齐不变量：LF/模糊归一化都不改行结构，A 与 B 行号一一对应，`rebuildText` 才能从未触及行直接复制 A。

## 下一步

Batch 3：turn 级取消链路（`StopReason: "cancelled"`、`AbortController` 贯穿 Loop→Runner→Provider/Registry/Tool、`tool.cancelled`/`turn.cancelled` 事件、`cancelled` checkpoint、合成 AssistantMessage、`edit_file` rename 提交点）。涉及 `packages/core`、Provider、Runner、Loop、CLI 与多组测试。
