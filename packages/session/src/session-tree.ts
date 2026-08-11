import type { SessionEntry } from "./entries.js";
import {
  SessionCorruptedError,
  type ActivePathResult,
  type SessionSnapshot,
} from "./session-store.js";

// Session 树的内存索引与活动路径重建（M4.1）。
// 构造函数只建立 id -> entry 映射（O(n)），不做严格校验；
// rebuildActivePath 从 active_leaf_id 沿 parent 链追溯（O(d)），
// 任何结构损坏都按严格失败策略返回 SessionCorruptedError，不截断、不自动修复。
export class SessionTree {
  private readonly byId: Map<string, SessionEntry>;
  private readonly snapshot: SessionSnapshot;

  constructor(snapshot: SessionSnapshot) {
    this.snapshot = snapshot;
    this.byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  }

  // 从 active leaf 沿 parent 链向上追溯至 null，再反转为根到 leaf 顺序。
  // 校验：leaf 存在、parent 存在、无循环（最多走 entries 数量步）、parent.sequence 严格早于 child、
  // entry 结构合法（user 必有 content）。
  rebuildActivePath(): ActivePathResult {
    const { activeLeafId } = this.snapshot;
    if (activeLeafId === null) {
      return { ok: true, path: [] };
    }
    if (!this.byId.has(activeLeafId)) {
      return {
        ok: false,
        error: new SessionCorruptedError("leaf-missing", `active leaf ${activeLeafId} not found`),
      };
    }
    const chain: SessionEntry[] = [];
    const seen = new Set<string>();
    let cursorId: string | null = activeLeafId;
    while (cursorId !== null) {
      if (seen.has(cursorId)) {
        return {
          ok: false,
          error: new SessionCorruptedError(
            "parent-cycle",
            `parent chain loops at entry ${cursorId}`,
          ),
        };
      }
      seen.add(cursorId);
      const entry = this.byId.get(cursorId);
      if (entry === undefined) {
        return {
          ok: false,
          error: new SessionCorruptedError("parent-missing", `parent ${cursorId} does not exist`),
        };
      }
      if (entry.type === "user" && typeof entry.content !== "string") {
        return {
          ok: false,
          error: new SessionCorruptedError(
            "invalid-entry-structure",
            `entry ${entry.id} (${entry.type}) is structurally invalid`,
          ),
        };
      }
      if (entry.parentId !== null) {
        const parent = this.byId.get(entry.parentId);
        if (parent === undefined) {
          return {
            ok: false,
            error: new SessionCorruptedError(
              "parent-missing",
              `parent ${entry.parentId} of ${entry.id} does not exist`,
            ),
          };
        }
        if (parent.sequence >= entry.sequence) {
          return {
            ok: false,
            error: new SessionCorruptedError(
              "parent-seq-order",
              `parent sequence ${parent.sequence} is not strictly earlier than ${entry.sequence}`,
            ),
          };
        }
      }
      chain.push(entry);
      cursorId = entry.parentId;
    }
    chain.reverse();
    // 防御：即使 entries 为空（leaf 为 null 已处理），也保证返回结构一致。
    if (chain.length === 0) {
      return { ok: true, path: [] };
    }
    return { ok: true, path: chain };
  }
}
