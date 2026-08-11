import { describe, expect, it } from "vitest";
import {
  replayRuntimeState,
  defaultRuntimeEnvironment,
  type ModelState,
} from "@byte-mentor/session";
import type { SessionSnapshot } from "@byte-mentor/session";
import type { SessionEntry } from "@byte-mentor/session";
import type { SessionId } from "@byte-mentor/core";

// 测试工具：构造最小 SessionSnapshot。默认基线 openai/gpt-5/medium。
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

function modelChangeEntry(
  id: string,
  seq: number,
  parentId: string | null,
  modelId: string,
): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "model_change",
    model: { provider: "openai", modelId },
  };
}

function thinkingChangeEntry(
  id: string,
  seq: number,
  parentId: string | null,
  level: "low" | "high",
): SessionEntry {
  return {
    id,
    sequence: seq,
    parentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "thinking_level_change",
    level,
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
    content: "",
    toolCalls: [],
    model: { provider: "openai", modelId },
    stopReason: "completed",
  };
}

// 场景：路径上没有任何状态 entry。预期：返回 session 初始基线。
describe("replayRuntimeState baseline", () => {
  it("returns the session initial state when the path has no state entries", () => {
    const entries = [userEntry("u1", 1, null), assistantEntry("a1", 2, "u1")];
    const snapshot = makeSnapshot({ activeLeafId: "a1", entries });
    expect(replayRuntimeState(snapshot, "a1")).toEqual({
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "medium",
    });
  });

  // 场景：空 leaf。预期：也返回基线（尚未有任何对话，状态即创建时的状态）。
  it("returns the baseline for an empty session", () => {
    const snapshot = makeSnapshot();
    expect(replayRuntimeState(snapshot, null)).toEqual({
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "medium",
    });
  });
});

// 场景：路径上有一个 model_change。预期：覆盖基线模型，thinking 不变。
describe("replayRuntimeState model changes", () => {
  it("applies a single model change over the baseline", () => {
    const entries = [
      userEntry("u1", 1, null),
      modelChangeEntry("m1", 2, "u1", "claude-opus"),
      assistantEntry("a1", 3, "m1"),
    ];
    const snapshot = makeSnapshot({ activeLeafId: "a1", entries });
    expect(replayRuntimeState(snapshot, "a1")).toEqual({
      model: { provider: "openai", modelId: "claude-opus" },
      thinkingLevel: "medium",
    });
  });

  // 场景：多个 model_change。预期：离 leaf 最近的（=从 root 数的最后一条）生效。
  it("takes the closest model change to the leaf", () => {
    const entries = [
      userEntry("u1", 1, null),
      modelChangeEntry("m1", 2, "u1", "claude-opus"),
      userEntry("u2", 3, "m1"),
      modelChangeEntry("m2", 4, "u2", "gpt-5"),
      assistantEntry("a1", 5, "m2"),
    ];
    const snapshot = makeSnapshot({ activeLeafId: "a1", entries });
    expect(replayRuntimeState(snapshot, "a1")).toEqual({
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "medium",
    });
  });
});

// 场景：thinking_level_change 独立生效，不影响 model。
describe("replayRuntimeState thinking changes", () => {
  it("applies a thinking level change without touching the model", () => {
    const entries = [
      userEntry("u1", 1, null),
      thinkingChangeEntry("t1", 2, "u1", "high"),
      assistantEntry("a1", 3, "t1"),
    ];
    const snapshot = makeSnapshot({ activeLeafId: "a1", entries });
    expect(replayRuntimeState(snapshot, "a1")).toEqual({
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "high",
    });
  });
});

// 场景：状态 entry 在非活动分支上。预期：不生效，leaf 所在路径上没有它。
describe("replayRuntimeState branch isolation", () => {
  it("ignores state entries on sibling branches", () => {
    const entries = [
      userEntry("u1", 1, null),
      modelChangeEntry("m1", 2, "u1", "claude-opus"), // 分支 A 上
      userEntry("ua", 3, "m1"), // 分支 A 的 leaf
      userEntry("ub", 4, "u1"), // 分支 B：leaf 在这里，m1 不是祖先
    ];
    const snapshot = makeSnapshot({ activeLeafId: "ub", entries });
    expect(replayRuntimeState(snapshot, "ub")).toEqual({
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "medium",
    });
  });
});

// 场景：路径上有 assistant entry 携带 model。预期：不影响后续状态（只记账）。
describe("replayRuntimeState assistant model is not state", () => {
  it("does not let AssistantEntry.model affect the replayed state", () => {
    const entries = [userEntry("u1", 1, null), assistantEntry("a1", 2, "u1", "claude-opus")];
    const snapshot = makeSnapshot({ activeLeafId: "a1", entries });
    expect(replayRuntimeState(snapshot, "a1")).toEqual({
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "medium",
    });
  });
});

// 场景：恢复出的状态不可执行。预期：canExecute 返回失败原因，Session 不判定损坏。
describe("runtime environment availability", () => {
  it("blocks execution when the environment cannot run the restored state", () => {
    const entries = [userEntry("u1", 1, null), modelChangeEntry("m1", 2, "u1", "retired-model")];
    const snapshot = makeSnapshot({ activeLeafId: "m1", entries });
    const state: ModelState = replayRuntimeState(snapshot, "m1");
    const env = {
      canExecute: (s: ModelState) =>
        s.model.modelId === "retired-model"
          ? { ok: false as const, reason: "model retired" }
          : { ok: true as const },
    };
    expect(env.canExecute(state)).toEqual({ ok: false, reason: "model retired" });
  });

  // 场景：默认环境实现。预期：恒可用，不阻止。
  it("default environment never blocks", () => {
    const entries = [userEntry("u1", 1, null), modelChangeEntry("m1", 2, "u1", "any-model")];
    const snapshot = makeSnapshot({ activeLeafId: "m1", entries });
    const state = replayRuntimeState(snapshot, "m1");
    expect(defaultRuntimeEnvironment.canExecute(state)).toEqual({ ok: true });
  });
});
