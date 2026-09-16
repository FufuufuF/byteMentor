import type { EntryId } from "./entries.js";
import { SessionStoreError, type PendingSessionEntry } from "./session-store.js";

// 校验一批已冻结 pending Entry 的稳定身份、连续 parent 与同批引用；不判断 Entry 的业务语义。
export function validatePendingSessionEntries(
  entries: readonly PendingSessionEntry[],
  activeLeafId: EntryId | null,
  hasPersistedEntry: (entryId: EntryId) => boolean,
): void {
  const pendingIds = new Set<EntryId>();
  let expectedParentId = activeLeafId;

  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new SessionStoreError("constraint", "pending entry must have a stable id");
    }
    if (typeof entry.createdAt !== "string") {
      throw new SessionStoreError("constraint", `entry ${entry.id} must have createdAt`);
    }
    if (pendingIds.has(entry.id) || hasPersistedEntry(entry.id)) {
      throw new SessionStoreError("constraint", `entry id already exists: ${entry.id}`);
    }
    if (entry.parentId !== expectedParentId) {
      throw new SessionStoreError(
        "constraint",
        `entry ${entry.id} parentId must equal the preceding active entry`,
      );
    }
    if (
      entry.parentId !== null &&
      !pendingIds.has(entry.parentId) &&
      !hasPersistedEntry(entry.parentId)
    ) {
      throw new SessionStoreError(
        "constraint",
        `parent ${entry.parentId} does not exist in session`,
      );
    }
    if (
      entry.type === "compaction" &&
      entry.firstKeptEntryId !== null &&
      !pendingIds.has(entry.firstKeptEntryId) &&
      !hasPersistedEntry(entry.firstKeptEntryId)
    ) {
      throw new SessionStoreError(
        "constraint",
        `firstKeptEntryId ${entry.firstKeptEntryId} does not exist in session or pending batch`,
      );
    }

    pendingIds.add(entry.id);
    expectedParentId = entry.id;
  }
}
