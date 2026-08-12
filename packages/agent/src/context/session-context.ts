import type { Message, MessageId } from "@byte-mentor/core";
import type { SessionEntry } from "@byte-mentor/session";
import { SessionCorruptedError, type ModelState } from "@byte-mentor/session";
import {
  defaultRuntimeEnvironment,
  type RuntimeEnvironment,
} from "../runtime/runtime-environment.js";
import { replayRuntimeState } from "@byte-mentor/session";

// M4.3～4.7 的上下文重建：把活动路径（已由 SessionTree 重建、状态由 replayRuntimeState 恢复）
// 转换为 provider-neutral 的统一 Message[]，并应用 M4.6 的压缩感知裁剪。
// 本模块不生成 provider 专属请求，也不持久化 provider message。

// 普通 Entry → Message 映射：Entry ID 作为消息 ID；状态 Entry 不生成消息。
// BranchSummary/Compaction 转换为固定 wrapper 的 UserMessage（M4.5/4.7）。
export function mapEntriesToMessages(entries: readonly SessionEntry[]): Message[] {
  const messages: Message[] = [];
  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        messages.push({ id: entry.id as MessageId, role: "user", content: entry.content });
        break;
      case "assistant":
        messages.push({
          id: entry.id as MessageId,
          role: "assistant",
          content: entry.content,
          toolCalls: entry.toolCalls,
        });
        break;
      case "tool_result":
        messages.push({
          id: entry.id as MessageId,
          role: "tool",
          toolCallId: entry.toolCallId,
          content: entry.content,
        });
        break;
      case "branch_summary":
        messages.push({
          id: entry.id as MessageId,
          role: "user",
          content: branchSummaryWrapper(entry.summary),
        });
        break;
      case "compaction":
        messages.push({
          id: entry.id as MessageId,
          role: "user",
          content: compactionSummaryWrapper(entry.summary),
        });
        break;
      case "model_change":
      case "thinking_level_change":
        // 状态 Entry 不生成消息，只参与状态回放。
        break;
    }
  }
  return messages;
}

// M4.6 压缩感知裁剪：以活动路径上最后一个 Compaction 计算有效上下文 [C] + [K..C) + (C..leaf]。
// firstKeptEntryId = null 时不保留 C 之前的尾部；非空时必须是路径中严格早于 C 的节点，否则损坏。
export function applyCompaction(
  path: readonly SessionEntry[],
): { ok: true; entries: SessionEntry[] } | { ok: false; error: SessionCorruptedError } {
  const lastCompactionIndex = findLastIndex(path, (e) => e.type === "compaction");
  if (lastCompactionIndex === -1) {
    return { ok: true, entries: [...path] };
  }
  const compaction = path[lastCompactionIndex];
  if (compaction.type !== "compaction") {
    throw new Error("unreachable");
  }
  const kept: SessionEntry[] = [compaction];
  if (compaction.firstKeptEntryId !== null) {
    const keptIndex = path.findIndex((e) => e.id === compaction.firstKeptEntryId);
    if (keptIndex === -1 || keptIndex >= lastCompactionIndex) {
      return {
        ok: false,
        error: new SessionCorruptedError(
          "invalid-entry-structure",
          `firstKeptEntryId ${compaction.firstKeptEntryId} is not on the active path strictly before the compaction`,
        ),
      };
    }
    kept.push(...path.slice(keptIndex, lastCompactionIndex));
  }
  kept.push(...path.slice(lastCompactionIndex + 1));
  return { ok: true, entries: kept };
}

// M4.9 完整上下文重建流水线：给定快照与已重建的活动路径，返回裁剪后的 Message[]、
// 恢复出的 ModelState 与执行可用性判定。
export function buildProviderContext(
  snapshot: Parameters<typeof replayRuntimeState>[0],
  path: readonly SessionEntry[],
  environment: RuntimeEnvironment = defaultRuntimeEnvironment,
):
  | {
      ok: true;
      messages: Message[];
      modelState: ModelState;
      execution: { ok: true } | { ok: false; reason: string };
    }
  | { ok: false; error: SessionCorruptedError } {
  const compactionResult = applyCompaction(path);
  if (!compactionResult.ok) {
    return compactionResult;
  }
  const messages = mapEntriesToMessages(compactionResult.entries);
  const leafId = path.length > 0 ? path[path.length - 1].id : null;
  const modelState = replayRuntimeState(snapshot, leafId);
  return {
    ok: true,
    messages,
    modelState,
    execution: environment.canExecute(modelState),
  };
}

// 固定 Branch Summary wrapper（M4.5）：不伪装成真实用户消息，不用 Assistant/system role。
function branchSummaryWrapper(summary: string): string {
  return `The following is a summary of a branch that this conversation returned from:\n\n<branch_summary>\n${summary}\n</branch_summary>`;
}

// 固定 Compaction Summary wrapper（M4.7）：位于压缩感知上下文最前面。
function compactionSummaryWrapper(summary: string): string {
  return `The conversation history before this point was compacted into the following summary:\n\n<compaction_summary>\n${summary}\n</compaction_summary>`;
}

// 从数组末尾找最后一个满足谓词的下标；-1 表示无。
function findLastIndex<T>(array: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = array.length - 1; i >= 0; i -= 1) {
    if (predicate(array[i])) {
      return i;
    }
  }
  return -1;
}

// 类型辅助（供 buildProviderContext 使用，避免引用完整 SessionSnapshot 造成循环依赖）。
export type { MessageId };
