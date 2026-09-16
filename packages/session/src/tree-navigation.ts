import {
  SessionNavigationError,
  type SessionSnapshot,
  type SessionStore,
} from "./session-store.js";

// M5 Tree 直接导航领域服务：基于内存树验证目标、计算实际导航目标，并通过 Store 原语提交。
// UI 草稿等 presentation 状态不进入领域层；数据库成功后才由调用方重建 transcript/编辑器。

// Tree default 视图中的一个可见目标（M5.1）。状态 Entry 不显示；compaction/branch_summary
// 可见但不可选；user/带文本 assistant/tool_result 可选。
export interface TreeTarget {
  entryId: string;
  kind: "user" | "assistant" | "tool_result" | "compaction" | "branch_summary";
  selectable: boolean;
  // 选中后 leaf 将移动到的位置：user 归一化为 parentId，assistant/tool_result 为自身。
  navigationLeafId: string | null;
  // 选中 user 时回填编辑器的草稿（该 user 原文）；其他目标无草稿。
  draft?: string;
}

// 按 entry_seq 升序列出 Tree default 视图的全部可见目标。
export function listTreeTargets(snapshot: SessionSnapshot): TreeTarget[] {
  const targets: TreeTarget[] = [];
  for (const entry of snapshot.entries) {
    switch (entry.type) {
      case "user":
        targets.push({
          entryId: entry.id,
          kind: "user",
          selectable: true,
          navigationLeafId: entry.parentId,
          draft: entry.content,
        });
        break;
      case "assistant":
        targets.push({
          entryId: entry.id,
          kind: "assistant",
          selectable: entry.content.length > 0,
          navigationLeafId: entry.id,
        });
        break;
      case "tool_result":
        targets.push({
          entryId: entry.id,
          kind: "tool_result",
          selectable: true,
          navigationLeafId: entry.id,
        });
        break;
      case "compaction":
        targets.push({
          entryId: entry.id,
          kind: "compaction",
          selectable: false,
          navigationLeafId: entry.id,
        });
        break;
      case "branch_summary":
        targets.push({
          entryId: entry.id,
          kind: "branch_summary",
          selectable: false,
          navigationLeafId: entry.id,
        });
        break;
      case "model_change":
      case "thinking_level_change":
        // 状态 Entry 在 default 视图不显示、不可选。
        break;
    }
  }
  return targets;
}

export interface NavigateDirectlyInput {
  store: SessionStore;
  sessionId: string;
  targetEntryId: string;
}

export type NavigateDirectlyResult =
  | { ok: true; noop: boolean; newLeafId: string | null; draft?: string }
  | { ok: false; error: SessionNavigationError };

// Tree 直接导航（M5.2）：不创建 Entry，只更新 active_leaf_id。
// 选择当前 leaf 或 user 的 parent 已是 leaf 时为 no-op（不写库，user 时仍回填草稿）；
// stale target 或不可导航目标报 SessionNavigationError；数据库失败时 leaf 不变。
export async function navigateDirectly(
  input: NavigateDirectlyInput,
): Promise<NavigateDirectlyResult> {
  const snapshot = await input.store.loadSession(input.sessionId as never);
  if (snapshot === undefined) {
    return {
      ok: false,
      error: new SessionNavigationError(`session not found: ${input.sessionId}`),
    };
  }
  const entry = snapshot.entries.find((e) => e.id === input.targetEntryId);
  if (entry === undefined) {
    return {
      ok: false,
      error: new SessionNavigationError(`target ${input.targetEntryId} does not exist`),
    };
  }
  const target = listTreeTargets(snapshot).find((t) => t.entryId === entry.id);
  if (target === undefined || !target.selectable) {
    return {
      ok: false,
      error: new SessionNavigationError(`target ${input.targetEntryId} is not selectable`),
    };
  }
  const newLeafId = target.navigationLeafId;
  const draft = target.draft;
  // no-op：目标 leaf 已经是当前 leaf（user 归一化后与当前 leaf 相同也视为 no-op，只回填草稿）。
  if (newLeafId === snapshot.activeLeafId) {
    return { ok: true, noop: true, newLeafId, draft };
  }
  try {
    await input.store.updateLeaf(input.sessionId as never, newLeafId);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof SessionNavigationError
          ? error
          : new SessionNavigationError(`navigation commit failed: ${String(error)}`),
    };
  }
  return { ok: true, noop: false, newLeafId, draft };
}
