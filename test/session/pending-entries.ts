import type { DistributiveOmit, PendingSessionEntry, SessionEntry } from "@byte-mentor/session";

type PendingEntryDraft = DistributiveOmit<
  SessionEntry,
  "id" | "sequence" | "parentId" | "createdAt"
>;

// 测试工具：为一批 pending Entry 固定稳定 ID、时间和连续 parent，模拟 checkpoint 已冻结的链。
export function makePendingEntries(
  prefix: string,
  parentId: string | null,
  drafts: readonly PendingEntryDraft[],
): PendingSessionEntry[] {
  let currentParentId = parentId;
  return drafts.map((draft, index) => {
    const entry = {
      ...draft,
      id: `${prefix}-${index + 1}`,
      parentId: currentParentId,
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    } as PendingSessionEntry;
    currentParentId = entry.id;
    return entry;
  });
}
