import type { SessionEntry } from "./entries.js";
import {
  ForkValidationError,
  SessionCorruptedError,
  SessionNavigationError,
  SessionNotFoundError,
  type SessionSnapshot,
  type SessionStore,
} from "./session-store.js";

// M3.12 Fork 领域服务：把 root 到所选 user entry 之 parent 的稳定单路径复制为独立新 session。
// 领域层负责路径提取与引用归一化（纯内存），store 的 createSessionWithEntries 负责原子落库。

export interface ForkInput {
  store: SessionStore;
  sourceSessionId: string;
  // 所选 user entry；复制路径为 root → user.parentId（不含所选 user 本身）。
  targetUserId: string;
}

export type ForkResult =
  | { ok: true; newSession: SessionSnapshot; draft: string }
  | {
      ok: false;
      error:
        SessionNotFoundError | SessionCorruptedError | SessionNavigationError | ForkValidationError;
    };

// 执行 fork：提取复制路径、归一化引用、原子创建新 session。
// 源 session 始终不变；只有新 session 提交成功后调用方才能切换运行上下文。
export async function forkSession(input: ForkInput): Promise<ForkResult> {
  const snapshot = await input.store.loadSession(input.sourceSessionId as never);
  if (snapshot === undefined) {
    return {
      ok: false,
      error: new SessionNotFoundError(`source session not found: ${input.sourceSessionId}`),
    };
  }
  const target = snapshot.entries.find((e) => e.id === input.targetUserId);
  if (target === undefined) {
    return {
      ok: false,
      error: new SessionNavigationError(`target ${input.targetUserId} does not exist`),
    };
  }
  if (target.type !== "user") {
    return {
      ok: false,
      error: new ForkValidationError(`target ${input.targetUserId} is not a user entry`),
    };
  }
  // 提取 root → target.parentId 的单路径（不含 target 自身）。
  const byId = new Map(snapshot.entries.map((e) => [e.id, e]));
  const path: SessionEntry[] = [];
  let cursorId = target.parentId;
  const seen = new Set<string>();
  while (cursorId !== null) {
    if (seen.has(cursorId)) {
      return {
        ok: false,
        error: new SessionCorruptedError("parent-cycle", `parent chain loops at ${cursorId}`),
      };
    }
    seen.add(cursorId);
    const entry = byId.get(cursorId);
    if (entry === undefined) {
      return {
        ok: false,
        error: new SessionCorruptedError("parent-missing", `parent ${cursorId} does not exist`),
      };
    }
    path.push(entry);
    cursorId = entry.parentId;
  }
  path.reverse();

  // 复制并重排 seq：保留 id/content/createdAt，parent 指向复制路径前驱。
  const pathIds = new Set(path.map((e) => e.id));
  const copied: SessionEntry[] = path.map((entry, index) => {
    const previousId = index === 0 ? null : path[index - 1].id;
    return normalizeEntryReferences(
      { ...entry, sequence: index + 1, parentId: previousId },
      pathIds,
    );
  });

  const newSession = await input.store.createSessionWithEntries({
    workspaceRoot: snapshot.workspaceRoot,
    initialProvider: snapshot.initialProvider,
    initialModelId: snapshot.initialModelId,
    initialThinkingLevel: snapshot.initialThinkingLevel,
    entries: copied,
  });
  return { ok: true, newSession, draft: target.content };
}

// 归一化 payload 引用：指向复制路径外的 sourceLeafId/firstKeptEntryId 置为 null；
// 路径内引用保持有效（id 未重写）。toolCallId 只引用同 session 的 assistant，随路径复制保留。
function normalizeEntryReferences(entry: SessionEntry, pathIds: Set<string>): SessionEntry {
  if (
    entry.type === "branch_summary" &&
    entry.sourceLeafId !== null &&
    !pathIds.has(entry.sourceLeafId)
  ) {
    return { ...entry, sourceLeafId: null };
  }
  if (
    entry.type === "compaction" &&
    entry.firstKeptEntryId !== null &&
    !pathIds.has(entry.firstKeptEntryId)
  ) {
    return { ...entry, firstKeptEntryId: null };
  }
  return entry;
}
