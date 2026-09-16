import { describe, expect, it } from "vitest";
import { SessionTree, type SessionCorruptionCode } from "@byte-mentor/session";
import type { SessionSnapshot } from "@byte-mentor/session";
import type { SessionEntry } from "@byte-mentor/session";
import type { SessionId } from "@byte-mentor/core";

// 测试工具：构造一个最小 SessionSnapshot。默认空 session（无 entry、leaf 为 null）。
function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001" as SessionId,
    workspaceRoot: "/w",
    initialProvider: "openai",
    initialModelId: "gpt-5",
    initialThinkingLevel: "medium",
    activeLeafId: null,
    nextEntrySeq: 1,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries: [],
    ...overrides,
  };
}

function userEntry(id: string, seq: number, parentId: string | null): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "user",
    content: `user ${id}`,
  };
}

function assistantEntry(
  id: string,
  seq: number,
  parentId: string | null,
  modelId = "gpt-5",
): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "assistant",
    content: `assistant ${id}`,
    toolCalls: [],
    model: { provider: "openai", modelId },
    stopReason: "completed",
  };
}

function expectCorruption(
  result: ReturnType<SessionTree["rebuildActivePath"]>,
  code: SessionCorruptionCode,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
  }
}

// 场景：leaf 为 null 的空 session。预期：路径为空，不报损坏。
describe("SessionTree rebuildActivePath valid paths", () => {
  it("returns an empty path when the active leaf is null", () => {
    const tree = new SessionTree(makeSnapshot());
    expect(tree.rebuildActivePath()).toEqual({ ok: true, path: [] });
  });

  // 场景：单根 entry，leaf 指向它。预期：路径只含该根。
  it("returns a single-root path", () => {
    const root = userEntry("u1", 1, null);
    const tree = new SessionTree(makeSnapshot({ activeLeafId: "u1", entries: [root] }));
    expect(tree.rebuildActivePath()).toEqual({ ok: true, path: [root] });
  });

  // 场景：深链 u1→a1→u2→a2，leaf 指向 a2。预期：路径按根到 leaf 顺序完整。
  it("returns a deep path in root-to-leaf order", () => {
    const entries = [
      userEntry("u1", 1, null),
      assistantEntry("a1", 2, "u1"),
      userEntry("u2", 3, "a1"),
      assistantEntry("a2", 4, "u2"),
    ];
    const tree = new SessionTree(makeSnapshot({ activeLeafId: "a2", entries }));
    expect(tree.rebuildActivePath()).toEqual({ ok: true, path: entries });
  });

  // 场景：多根多分支，leaf 在分支 B。预期：只含 B 的祖先链，sibling 分支 A 不进入。
  it("excludes sibling branches from the active path", () => {
    const branchA = userEntry("ua", 1, null);
    const branchB = userEntry("ub", 2, null);
    const leafB = assistantEntry("ab", 3, "ub");
    const tree = new SessionTree(
      makeSnapshot({ activeLeafId: "ab", entries: [branchA, branchB, leafB] }),
    );
    expect(tree.rebuildActivePath()).toEqual({ ok: true, path: [branchB, leafB] });
  });
});

// 场景：activeLeafId 指向不存在的 entry。预期：leaf-missing 损坏，严格失败。
describe("SessionTree rebuildActivePath corruption", () => {
  it("reports leaf-missing when the active leaf does not exist", () => {
    const tree = new SessionTree(makeSnapshot({ activeLeafId: "ghost", entries: [] }));
    expectCorruption(tree.rebuildActivePath(), "leaf-missing");
  });

  // 场景：parentId 指向不存在的 entry。预期：parent-missing 损坏。
  it("reports parent-missing when a parent does not exist", () => {
    const entries = [userEntry("u1", 1, "ghost")];
    const tree = new SessionTree(makeSnapshot({ activeLeafId: "u1", entries }));
    expectCorruption(tree.rebuildActivePath(), "parent-missing");
  });

  // 场景：parent 链循环在合法 sequence（严格递增）下不可能出现——因为环上必有一处
  // parent.sequence >= child.sequence，会被 parent-seq-order 拦截。本用例验证：
  // 即使数据被手工破坏成环，也以严格失败报告损坏（不会死循环）。
  it("reports corruption instead of looping forever when the parent chain cycles", () => {
    const entries = [userEntry("u1", 1, "u2"), userEntry("u2", 2, "u1")];
    const tree = new SessionTree(makeSnapshot({ activeLeafId: "u2", entries }));
    const result = tree.rebuildActivePath();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 环上 u1 的 parent u2 sequence 2 >= 1，先被 parent-seq-order 拦截。
      expect(["parent-cycle", "parent-seq-order"]).toContain(result.error.code);
    }
  });

  // 场景：parent.sequence >= child.sequence。预期：parent-seq-order 损坏。
  it("reports parent-seq-order when a parent sequence is not strictly earlier", () => {
    const entries = [
      userEntry("u1", 2, null),
      userEntry("u2", 1, "u1"), // parent seq 2 >= child seq 1
    ];
    const tree = new SessionTree(makeSnapshot({ activeLeafId: "u2", entries }));
    expectCorruption(tree.rebuildActivePath(), "parent-seq-order");
  });
});

// 场景：entry 结构不合法（如缺失 content 的 user）。预期：invalid-entry-structure 损坏。
describe("SessionTree rebuildActivePath structural corruption", () => {
  it("reports invalid-entry-structure for a malformed entry", () => {
    const bad = {
      id: "u1",
      sequence: 1,
      parentId: null,
      createdAt: "",
      type: "user",
    } as unknown as SessionEntry;
    const tree = new SessionTree(makeSnapshot({ activeLeafId: "u1", entries: [bad] }));
    expectCorruption(tree.rebuildActivePath(), "invalid-entry-structure");
  });
});
