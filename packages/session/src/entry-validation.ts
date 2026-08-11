import type { EntryId, SessionEntry } from "./entries.js";

// Session Entry 树结构的纯函数校验（M2 共同不变量）。校验只依赖同一批 entries，
// 不访问 Store；返回结构化错误分类，不抛裸异常。活动祖先路径级校验（toolCallId 必须
// 在活动路径上、compaction 的 firstKeptEntryId 必须在活动路径上且早于该 compaction）
// 属于 Batch 4/5 的活动路径重建职责，不在此实现。

// 校验错误分类：领域层只消费 code，不解析原始错误字符串。
export type EntryValidationErrorCode =
  | "duplicate-id"
  | "duplicate-sequence"
  | "non-positive-sequence"
  | "self-parent"
  | "missing-parent"
  | "parent-after-child"
  | "dangling-tool-call"
  | "dangling-source-leaf"
  | "dangling-first-kept";

// 单条校验错误：code 供程序分支，entryId 定位违规节点，message 供人读。
export interface EntryValidationError {
  code: EntryValidationErrorCode;
  entryId: EntryId;
  message: string;
}

// 校验结果：ok 时无错误；失败时一次性返回全部违规，不截断。
export type EntryValidationResult = { ok: true } | { ok: false; errors: EntryValidationError[] };

// 校验整批 entries 的结构不变量：id/sequence 唯一性、sequence 为正、parent 存在且非自身、
// parent 的 sequence 严格早于 child、tool-call/tool-result 与 branch/compaction 引用的树级存在性。
export function validateSessionEntries(entries: readonly SessionEntry[]): EntryValidationResult {
  const errors: EntryValidationError[] = [];
  const byId = new Map<EntryId, SessionEntry>();
  const sequenceOwners = new Map<number, EntryId>();

  const report = (entry: SessionEntry, code: EntryValidationErrorCode, message: string): void => {
    errors.push({ code, entryId: entry.id, message });
  };

  for (const entry of entries) {
    if (byId.has(entry.id)) {
      report(entry, "duplicate-id", `duplicate entry id: ${entry.id}`);
    } else {
      byId.set(entry.id, entry);
    }

    const seqOwner = sequenceOwners.get(entry.sequence);
    if (seqOwner !== undefined) {
      report(entry, "duplicate-sequence", `duplicate sequence ${entry.sequence} with ${seqOwner}`);
    } else {
      sequenceOwners.set(entry.sequence, entry.id);
    }

    if (!Number.isInteger(entry.sequence) || entry.sequence <= 0) {
      report(entry, "non-positive-sequence", `sequence must be a positive integer`);
    }

    if (entry.parentId === entry.id) {
      report(entry, "self-parent", `entry cannot be its own parent`);
    } else if (entry.parentId !== null) {
      const parent = byId.get(entry.parentId);
      if (parent === undefined) {
        report(entry, "missing-parent", `parent ${entry.parentId} does not exist in the tree`);
      } else if (parent.sequence >= entry.sequence) {
        report(entry, "parent-after-child", `parent sequence must be strictly earlier than child`);
      }
    }
  }

  // 第二轮：引用校验需要看到整棵树，且依赖 id 存在性（已在上轮收集）。
  for (const entry of entries) {
    if (entry.type === "tool_result") {
      const matched = entries.some(
        (candidate) =>
          candidate.type === "assistant" &&
          candidate.toolCalls.some((call) => call.id === entry.toolCallId),
      );
      if (!matched) {
        report(entry, "dangling-tool-call", `no tool call with id ${entry.toolCallId} in the tree`);
      }
    } else if (entry.type === "branch_summary" && entry.sourceLeafId !== null) {
      if (!byId.has(entry.sourceLeafId)) {
        report(entry, "dangling-source-leaf", `sourceLeafId ${entry.sourceLeafId} does not exist`);
      }
    } else if (entry.type === "compaction" && entry.firstKeptEntryId !== null) {
      if (!byId.has(entry.firstKeptEntryId)) {
        report(
          entry,
          "dangling-first-kept",
          `firstKeptEntryId ${entry.firstKeptEntryId} does not exist`,
        );
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
