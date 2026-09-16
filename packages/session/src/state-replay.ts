import type { EntryId } from "./entries.js";
import type { ModelState, SessionSnapshot } from "./session-store.js";

// M4.2 模型与 thinking level 状态恢复：从 leaf 向上追溯，遇到离 leaf 最近（=从 root 数的
// 最后一条）的 ModelChangeEntry / ThinkingLevelChangeEntry 即生效，可提前终止；
// 找不到时回落到 Session 创建时的初始基线。AssistantEntry.model 只记账、不参与状态。
export function replayRuntimeState(snapshot: SessionSnapshot, leafId: EntryId | null): ModelState {
  const model = { provider: snapshot.initialProvider, modelId: snapshot.initialModelId };
  let thinkingLevel = snapshot.initialThinkingLevel;
  if (leafId === null) {
    return { model, thinkingLevel };
  }
  const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  let foundModel = false;
  let foundThinking = false;
  let cursorId: EntryId | null = leafId;
  while (cursorId !== null) {
    const entry = byId.get(cursorId);
    if (entry === undefined) {
      // 路径重建（SessionTree）已保证结构合法；这里防御性地终止，避免死循环。
      break;
    }
    if (!foundModel && entry.type === "model_change") {
      model.provider = entry.model.provider;
      model.modelId = entry.model.modelId;
      foundModel = true;
    } else if (!foundThinking && entry.type === "thinking_level_change") {
      thinkingLevel = entry.level;
      foundThinking = true;
    }
    if (foundModel && foundThinking) {
      break;
    }
    cursorId = entry.parentId;
  }
  return { model, thinkingLevel };
}
