import { normalizeUsage } from "@byte-mentor/core";
import type { Message, ModelRef, TokenUsage } from "@byte-mentor/core";
import type { ToolDefinition } from "../providers/provider.js";

// M6.2 token 本地估算：无真实 usage 时按字符数 + 固定协议开销估算请求大小。
// 首版不引入完整 tokenizer：ASCII 约 chars/4，非 ASCII 字符保守按约 1 token。

// 每条消息的固定协议开销（role 标记、结构字段等）。
const PROTOCOL_OVERHEAD_PER_MESSAGE = 4;
// 每个 tool definition 的固定协议开销（name/description/类型骨架）。
const TOOL_OVERHEAD = 8;

export interface EstimateRequestInput {
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
}

// 估算一次完整 provider 请求的 token 数：有效消息 + tool definitions/schema + system prompt。
export function estimateRequestTokens(input: EstimateRequestInput): number {
  let total = 0;
  if (input.systemPrompt !== undefined && input.systemPrompt.length > 0) {
    total += estimateTextTokens(input.systemPrompt) + PROTOCOL_OVERHEAD_PER_MESSAGE;
  }
  for (const message of input.messages) {
    total += estimateMessageTokens(message);
  }
  for (const tool of input.tools ?? []) {
    total += estimateToolDefinitionTokens(tool);
  }
  return total;
}

// 单条消息估算：文本（content/tool 结果）按字符估算，tool-call 参数稳定 JSON 序列化后估算，
// 再加固定协议开销。
function estimateMessageTokens(message: Message): number {
  let text = "";
  switch (message.role) {
    case "user":
      text = message.content;
      break;
    case "assistant":
      text = message.content ?? "";
      for (const call of message.toolCalls ?? []) {
        text += JSON.stringify(stableSerialize(call.args)) + call.name;
      }
      break;
    case "tool":
      text = message.content;
      break;
  }
  return estimateTextTokens(text) + PROTOCOL_OVERHEAD_PER_MESSAGE;
}

// 单个 tool definition：description 与 schema 的稳定 JSON 文本按字符估算，加固定开销。
function estimateToolDefinitionTokens(tool: ToolDefinition): number {
  let text = `${tool.name}\n${tool.description}`;
  if (tool.parametersJsonSchema !== undefined) {
    text += JSON.stringify(stableSerialize(tool.parametersJsonSchema));
  }
  return estimateTextTokens(text) + TOOL_OVERHEAD;
}

// 文本 → token：ASCII 字符按 chars/4；非 ASCII 字符（含中文等多字节）保守按约 1 token。
function estimateTextTokens(text: string): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) {
      asciiCount += 1;
    } else {
      nonAsciiCount += 1;
    }
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}

// 稳定序列化：对象键按字典序排序，保证同参数不同键序估算一致。
function stableSerialize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableSerialize);
  }
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = stableSerialize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// 估算锚点（M6.2）：最近一次位于当前有效上下文、由同一模型成功生成的 assistant usage。
export interface EstimationAnchor {
  usage: TokenUsage;
  model: ModelRef;
}

export interface EstimateWithAnchorInput {
  messages: Message[];
  // 锚点对应的消息（锚点生成时的上下文）；compaction/模型切换/分支变化后应放弃锚点。
  anchor: EstimationAnchor;
  // 锚点在 messages 中的结束位置（含）：index < anchorEndsAtIndex 的消息已计入锚点 total。
  anchorEndsAtIndex: number;
  // 当前模型；与锚点模型不一致时放弃锚点。
  model?: ModelRef;
}

// 有合法锚点时增量估算：归一化后的锚点 total + 其后新增消息（含待发送 User/新 ToolResult）。
// 锚点失效（模型切换）时退化为全量估算。
export function estimateMessagesWithAnchor(input: EstimateWithAnchorInput): number {
  const { messages, anchor, anchorEndsAtIndex, model } = input;
  if (
    model !== undefined &&
    (model.provider !== anchor.model.provider || model.modelId !== anchor.model.modelId)
  ) {
    return estimateRequestTokens({ messages });
  }
  const base = normalizeUsage(anchor.usage).totalTokens;
  const added = messages.slice(anchorEndsAtIndex);
  return base + estimateRequestTokens({ messages: added });
}
