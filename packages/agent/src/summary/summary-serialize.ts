import type { SessionEntry } from "@byte-mentor/session";
import { applyCompaction } from "../context/session-context.js";

// M5.4/M6.8 摘要输入序列化：把待总结区间转换为固定标签包裹的纯文本，作为独立摘要请求发送。
// 不把任意片段伪装成原生 provider 对话；状态 Entry 排除；区间内 Compaction 按 M4
// "最后一次生效"规则裁剪，避免重新展开已压缩历史。

// 序列化区间为摘要输入。输入区间已被 computeSummaryInterval 裁剪为 (LCA, S]，
// 这里再次应用 Compaction 裁剪并逐条转文本。
export function serializeSummaryInput(entries: readonly SessionEntry[]): string {
  const compactionResult = applyCompaction(entries);
  const effective = compactionResult.ok ? compactionResult.entries : [...entries];
  const parts: string[] = [];
  for (const entry of effective) {
    const text = entryToSummaryText(entry);
    if (text !== null) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

// 单条 Entry → 摘要文本；状态 Entry 返回 null（不参与摘要）。
function entryToSummaryText(entry: SessionEntry): string | null {
  switch (entry.type) {
    case "user":
      return `<user>${entry.content}</user>`;
    case "assistant": {
      const toolCalls = entry.toolCalls
        .map((call) => `tool_call(${call.name}): ${JSON.stringify(call.args)}`)
        .join("\n");
      const body = entry.content.length > 0 ? entry.content : toolCalls;
      return `<assistant>${body}</assistant>`;
    }
    case "tool_result":
      return `<tool_result>${truncateToolResultForSummary(entry.content)}</tool_result>`;
    case "branch_summary":
      return `<branch_summary>${entry.summary}</branch_summary>`;
    case "compaction":
      return `<compaction_summary>${entry.summary}</compaction_summary>`;
    case "model_change":
    case "thinking_level_change":
      return null;
  }
}

// 摘要输入中的单个 ToolResult 最多保留 maxChars 字符（默认 2000），标记截断与原长度；
// 只作用于摘要请求，不修改 Session 中保存的原始 ToolResult。
export function truncateToolResultForSummary(content: string, maxChars = 2000): string {
  if (content.length <= maxChars) {
    return content;
  }
  const head = content.slice(0, Math.floor(maxChars * 0.7));
  const tail = content.slice(content.length - Math.floor(maxChars * 0.3));
  return `${head}\n...[truncated: original ${content.length} chars]...\n${tail}`;
}
