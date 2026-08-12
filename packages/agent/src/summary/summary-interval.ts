import type { SessionEntry } from "@byte-mentor/session";
import type { SessionSnapshot } from "@byte-mentor/session";

// M5.3 Branch Summary 总结区间计算：给定导航前 source leaf S 与归一化后的目标 T，
// 计算最近公共祖先 LCA 与待总结区间 (LCA, S]（不含 LCA，含 S）。
// 区间为空或没有离开旧分支时返回退化原因，调用方退化为直接导航。

export type SummaryIntervalResult =
  | { ok: true; lcaId: string | null; interval: SessionEntry[] }
  | { ok: false; reason: "same-leaf" | "no-branch-leave" | "empty-interval" | "unknown-entry" };

export function computeSummaryInterval(
  snapshot: SessionSnapshot,
  sourceLeafId: string | null,
  targetLeafId: string | null,
): SummaryIntervalResult {
  if (sourceLeafId === null) {
    return { ok: false, reason: "no-branch-leave" };
  }
  const byId = new Map(snapshot.entries.map((e) => [e.id, e]));
  if (!byId.has(sourceLeafId) || (targetLeafId !== null && !byId.has(targetLeafId))) {
    return { ok: false, reason: "unknown-entry" };
  }
  if (sourceLeafId === targetLeafId) {
    return { ok: false, reason: "same-leaf" };
  }

  // 计算 source 的祖先链（含自身）。
  const sourceAncestors = new Set<string>();
  {
    let cursor: string | null = sourceLeafId;
    while (cursor !== null) {
      sourceAncestors.add(cursor);
      const entry = byId.get(cursor);
      cursor = entry?.parentId ?? null;
    }
  }
  // 从 target 向上找第一个也在 source 祖先链中的节点 = LCA。
  let lcaId: string | null = null;
  {
    let cursor: string | null = targetLeafId;
    while (cursor !== null) {
      if (sourceAncestors.has(cursor)) {
        lcaId = cursor;
        break;
      }
      const entry = byId.get(cursor);
      cursor = entry?.parentId ?? null;
    }
  }

  // S 是 T 的祖先时，S 在 T 的祖先链中 → LCA = S → 没有离开旧分支。
  if (lcaId === sourceLeafId) {
    return { ok: false, reason: "no-branch-leave" };
  }
  const resolvedLcaId = lcaId as string;

  // 收集 (LCA, S] 区间：从 S 向上走到 LCA（不含 LCA），再反转。
  const interval: SessionEntry[] = [];
  {
    let cursor: string | null = sourceLeafId;
    while (cursor !== null && cursor !== resolvedLcaId) {
      const entry = byId.get(cursor);
      if (entry === undefined) {
        return { ok: false, reason: "unknown-entry" };
      }
      interval.push(entry);
      cursor = entry.parentId;
    }
    interval.reverse();
  }
  if (interval.length === 0) {
    return { ok: false, reason: "empty-interval" };
  }
  return { ok: true, lcaId: resolvedLcaId, interval };
}
