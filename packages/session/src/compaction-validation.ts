import type { EntryId } from "./entries.js";
import { SessionStoreError, type PendingCompactionEntry } from "./session-store.js";

// 校验 pending Compaction 的稳定身份与持久化引用；调用方提供 Entry 查询，避免两种 Store 的规则漂移。
export function validatePendingCompaction(
  entry: PendingCompactionEntry,
  activeLeafId: EntryId | null,
  hasEntry: (entryId: EntryId) => boolean,
): void {
  if (entry.summary.trim().length === 0) {
    throw new SessionStoreError("constraint", "commitCompaction requires a non-empty summary");
  }
  if (entry.parentId !== activeLeafId) {
    throw new SessionStoreError(
      "constraint",
      "commitCompaction entry parentId must equal the current active leaf",
    );
  }
  if (hasEntry(entry.id)) {
    throw new SessionStoreError("constraint", `entry id already exists: ${entry.id}`);
  }
  if (entry.parentId !== null && !hasEntry(entry.parentId)) {
    throw new SessionStoreError("constraint", `parent ${entry.parentId} does not exist in session`);
  }
  if (entry.firstKeptEntryId !== null && !hasEntry(entry.firstKeptEntryId)) {
    throw new SessionStoreError(
      "constraint",
      `firstKeptEntryId ${entry.firstKeptEntryId} does not exist in session`,
    );
  }
}
