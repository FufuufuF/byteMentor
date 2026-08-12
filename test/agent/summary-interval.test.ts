import { describe, expect, it } from "vitest";
import { computeSummaryInterval } from "@byte-mentor/agent";
import type { SessionSnapshot } from "@byte-mentor/session";
import type { SessionEntry } from "@byte-mentor/session";
import type { SessionId } from "@byte-mentor/core";

// 测试工具：构造最小 SessionSnapshot。
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
  return { id, sequence: seq, parentId, createdAt: "", type: "user", content: `user ${id}` };
}

function assistantEntry(id: string, seq: number, parentId: string | null): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "",
    type: "assistant",
    content: `assistant ${id}`,
    toolCalls: [],
    model: { provider: "openai", modelId: "gpt-5" },
    stopReason: "completed",
  };
}

// 分支树：
// u1(根)
// ├─ a1 → u2 → a2        （分支 A）
// └─ a3 → u3 → a4        （分支 B）
function makeBranchTree(): SessionSnapshot {
  const entries: SessionEntry[] = [
    userEntry("u1", 1, null),
    assistantEntry("a1", 2, "u1"),
    userEntry("u2", 3, "a1"),
    assistantEntry("a2", 4, "u2"),
    assistantEntry("a3", 5, "u1"),
    userEntry("u3", 6, "a3"),
    assistantEntry("a4", 7, "u3"),
  ];
  return makeSnapshot({ activeLeafId: "a4", entries });
}

// 线性链：u1 → a1 → u2 → a2（T 是 S 的祖先时用这个）
function makeLinearTree(): SessionSnapshot {
  const entries: SessionEntry[] = [
    userEntry("u1", 1, null),
    assistantEntry("a1", 2, "u1"),
    userEntry("u2", 3, "a1"),
    assistantEntry("a2", 4, "u2"),
  ];
  return makeSnapshot({ activeLeafId: "a2", entries });
}

// 场景：普通跨分支。预期：LCA=u1，区间=(u1, S] 即分支 B 的 a3→u3→a4，不含公共历史与目标分支。
describe("computeSummaryInterval basic", () => {
  it("computes (LCA, sourceLeaf] for a cross-branch move", () => {
    const snapshot = makeBranchTree();
    const result = computeSummaryInterval(snapshot, "a4", "a2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lcaId).toBe("u1");
    expect(result.interval.map((e) => e.id)).toEqual(["a3", "u3", "a4"]);
  });
});

// 场景：T 是 S 的祖先（同一条链上回退）。预期：区间=(T, S]，正常（不退化）。
describe("computeSummaryInterval ancestor target", () => {
  it("summarizes (T, S] when the target is an ancestor of the source", () => {
    const snapshot = makeLinearTree();
    // S = a2，T = u1（a2 的祖先）→ 区间 = u1 之后到 a2 = a1→u2→a2
    const result = computeSummaryInterval(snapshot, "a2", "u1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lcaId).toBe("u1");
    expect(result.interval.map((e) => e.id)).toEqual(["a1", "u2", "a2"]);
  });
});

// 场景：退化情形。预期：ok=false + 明确原因，调用方退化为直接导航。
// 注：M5.3 的"总结区间为空"对应 S=T、S=null、S 是 T 祖先等没有离开旧分支的情形，
// 已由下方用例覆盖；(T,S] 至少包含 S 自身，不存在字面上的空区间。
describe("computeSummaryInterval no-leave cases", () => {
  it("degenerates when source equals target", () => {
    const snapshot = makeBranchTree();
    const result = computeSummaryInterval(snapshot, "a4", "a4");
    expect(result).toEqual({ ok: false, reason: "same-leaf" });
  });

  it("degenerates when the source leaf is null", () => {
    const snapshot = makeBranchTree();
    const result = computeSummaryInterval(snapshot, null, "a4");
    expect(result).toEqual({ ok: false, reason: "no-branch-leave" });
  });

  it("degenerates when the source is an ancestor of the target (target deeper on same chain)", () => {
    const snapshot = makeLinearTree();
    // S = u1（a2 的祖先），T = a2 → 导航是"前进"，没有离开旧分支
    const result = computeSummaryInterval(snapshot, "u1", "a2");
    expect(result).toEqual({ ok: false, reason: "no-branch-leave" });
  });
});

// 场景：目标不存在/源不存在。预期：返回错误原因（不抛异常）。
describe("computeSummaryInterval invalid ids", () => {
  it("reports unknown source or target", () => {
    const snapshot = makeBranchTree();
    expect(computeSummaryInterval(snapshot, "ghost", "a2")).toEqual({
      ok: false,
      reason: "unknown-entry",
    });
    expect(computeSummaryInterval(snapshot, "a4", "ghost")).toEqual({
      ok: false,
      reason: "unknown-entry",
    });
  });
});
