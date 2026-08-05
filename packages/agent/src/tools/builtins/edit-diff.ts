import { createTwoFilesPatch, diffLines } from "diff";

export interface EditOperation {
  oldText: string;
  newText: string;
}

export type EditDiffErrorCode =
  "edit_target_not_found" | "edit_target_not_unique" | "edit_targets_overlap" | "edit_no_change";

export interface EditDiffError {
  code: EditDiffErrorCode;
  editIndex?: number;
  occurrences?: number;
  message: string;
}

export interface EditDiffSuccess {
  text: string;
  replacements: number;
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

export type EditDiffResult = ({ ok: true } & EditDiffSuccess) | { ok: false; error: EditDiffError };

type NewlineStyle = "lf" | "crlf" | "cr";

interface PlacedEdit {
  editIndex: number;
  newText: string;
  start: number;
  end: number;
  sLine: number;
  eLine: number;
}

interface PreparedEdit {
  editIndex: number;
  oldLf: string;
  newLf: string;
}

// 基于同一原始快照定位并应用所有替换，统一换行后匹配、按受影响行块重建并生成 diff/patch。
export function applyEdits(source: string, edits: EditOperation[]): EditDiffResult {
  const newlineStyle = detectNewlineStyle(source);
  const lfSource = toLf(source);
  const prepared = edits.map<PreparedEdit>((edit, editIndex) => ({
    editIndex,
    oldLf: toLf(edit.oldText),
    newLf: toLf(edit.newText),
  }));

  const precisePositions = prepared.map((edit) => findOverlappingMatches(lfSource, edit.oldLf));
  const allPreciseUnique = precisePositions.every((positions) => positions.length === 1);

  let spaceText: string;
  let placements: PlacedEdit[];
  if (allPreciseUnique) {
    spaceText = lfSource;
    placements = prepared.map((edit, index) =>
      placeEdit(edit, precisePositions[index]![0]!, edit.oldLf.length, spaceText),
    );
  } else {
    spaceText = fuzzyNormalize(lfSource);
    placements = [];
    for (const edit of prepared) {
      const fuzzyOld = fuzzyNormalize(edit.oldLf);
      if (fuzzyOld.length === 0) {
        return editFailure("edit_target_not_unique", edit.editIndex, 0);
      }
      const positions = findOverlappingMatches(spaceText, fuzzyOld);
      if (positions.length === 0) {
        return editFailure("edit_target_not_found", edit.editIndex);
      }
      if (positions.length > 1) {
        return editFailure("edit_target_not_unique", edit.editIndex, positions.length);
      }
      placements.push(placeEdit(edit, positions[0]!, fuzzyOld.length, spaceText));
    }
  }

  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      if (rangesOverlap(placements[i]!, placements[j]!)) {
        return editFailure("edit_targets_overlap");
      }
    }
  }

  const newSpaceText = applyReplacements(spaceText, placements);
  if (newSpaceText === spaceText) {
    return editFailure("edit_no_change");
  }

  const restored = rebuildText(source, spaceText, placements, newlineStyle);
  const changedLine = firstChangedLine(source, restored);
  return {
    ok: true,
    text: restored,
    replacements: placements.length,
    diff: renderDisplayDiff(source, restored),
    patch: createTwoFilesPatch("a", "b", source, restored),
    ...(changedLine === undefined ? {} : { firstChangedLine: changedLine }),
  };
}

// 根据匹配位置与归一化后的目标长度把单个编辑映射为匹配空间内的放置记录和行块边界。
function placeEdit(
  edit: PreparedEdit,
  start: number,
  needleLength: number,
  spaceText: string,
): PlacedEdit {
  return {
    editIndex: edit.editIndex,
    newText: edit.newLf,
    start,
    end: start + needleLength,
    sLine: lineOf(start, spaceText),
    eLine: lineOf(Math.max(start, start + needleLength - 1), spaceText),
  };
}

// 统计一个文本中所有匹配位置，允许候选相互重叠（如 aa 在 aaa 中出现两次）。
function findOverlappingMatches(text: string, needle: string): number[] {
  const positions: number[] = [];
  if (needle.length === 0) {
    return positions;
  }
  let index = text.indexOf(needle);
  while (index !== -1) {
    positions.push(index);
    index = text.indexOf(needle, index + 1);
  }
  return positions;
}

// 判断两个替换区间是否重叠或嵌套；仅首尾相接的相邻区间不视为重叠。
function rangesOverlap(a: PlacedEdit, b: PlacedEdit): boolean {
  return a.start < b.end && b.start < a.end;
}

// 按位置倒序在同一文本上应用全部替换，使替换不依赖彼此的结果。
function applyReplacements(
  text: string,
  matches: Array<{ start: number; end: number; newText: string }>,
): string {
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  let result = text;
  for (const match of sorted) {
    result = result.slice(0, match.start) + match.newText + result.slice(match.end);
  }
  return result;
}

// 把 CRLF、CR、LF 统一为 LF，形成与行结构无关的匹配坐标空间。
function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// 从文件开头最先出现的有效换行确定主要换行风格，没有换行时使用 LF。
function detectNewlineStyle(text: string): NewlineStyle {
  const first = text.match(/\r\n|\n|\r/);
  if (first === null) {
    return "lf";
  }
  if (first[0] === "\r\n") {
    return "crlf";
  }
  if (first[0] === "\n") {
    return "lf";
  }
  return "cr";
}

// 对 LF 文本执行有限模糊归一化，吸收无语义差异的字符变化；行尾空白逐行去除。
function fuzzyNormalize(text: string): string {
  const nfkc = text.normalize("NFKC");
  const lines = nfkc.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  return lines
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
}

// 把 LF 换行恢复为指定换行风格，供写回与展示使用。
function restoreNewlines(text: string, style: NewlineStyle): string {
  if (style === "lf") {
    return text;
  }
  if (style === "crlf") {
    return text.replace(/\n/g, "\r\n");
  }
  return text.replace(/\n/g, "\r");
}

// 计算一个字符偏移所属的 0-based 行号，行结构来自 LF 文本。
function lineOf(offset: number, text: string): number {
  let line = 0;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i += 1) {
    if (text[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

// 只重建受影响的行块，未触及的行从原始文本复制，避免把全文意外归一化。
function rebuildText(
  source: string,
  spaceText: string,
  placements: PlacedEdit[],
  newlineStyle: NewlineStyle,
): string {
  const originalLines = splitLinesWithEndings(source);
  const spaceLines = spaceText.split("\n");
  const lineOffsets: number[] = [];
  let offset = 0;
  for (let i = 0; i < spaceLines.length; i += 1) {
    lineOffsets.push(offset);
    offset += spaceLines[i]!.length + (i < spaceLines.length - 1 ? 1 : 0);
  }

  const touched = new Set<number>();
  for (const placed of placements) {
    for (let line = placed.sLine; line <= placed.eLine; line += 1) {
      touched.add(line);
    }
  }

  const blocks: Array<{ start: number; end: number }> = [];
  let current: { start: number; end: number } | undefined;
  for (let i = 0; i < spaceLines.length; i += 1) {
    if (touched.has(i)) {
      if (current === undefined) {
        current = { start: i, end: i };
      } else {
        current.end = i;
      }
    } else if (current !== undefined) {
      blocks.push(current);
      current = undefined;
    }
  }
  if (current !== undefined) {
    blocks.push(current);
  }

  const separator = newlineSeparator(newlineStyle);
  const output: string[] = [];
  let blockIndex = 0;
  for (let i = 0; i < originalLines.length; i += 1) {
    const block = blocks[blockIndex];
    if (block !== undefined && i === block.start) {
      const blockStart = lineOffsets[block.start]!;
      const blockEnd =
        block.end < spaceLines.length - 1
          ? lineOffsets[block.end]! + spaceLines[block.end]!.length + 1
          : spaceText.length;
      const blockText = spaceText.slice(blockStart, blockEnd);
      const blockMatches = placements
        .filter((placed) => placed.sLine >= block.start && placed.eLine <= block.end)
        .map((placed) => ({
          start: placed.start - blockStart,
          end: placed.end - blockStart,
          newText: placed.newText,
        }));
      const blockNew = applyReplacements(blockText, blockMatches);
      const blockNewLines = blockNew.split("\n");
      const endsWithNewline = blockNewLines.length > 1 && blockNewLines.at(-1) === "";
      if (endsWithNewline) {
        blockNewLines.pop();
      }
      const joined = blockNewLines
        .map((line) => restoreNewlines(line, newlineStyle))
        .join(separator);
      output.push(endsWithNewline ? `${joined}${separator}` : joined);
      i = block.end;
      blockIndex += 1;
    } else {
      output.push(originalLines[i]!);
    }
  }
  return output.join("");
}

// 返回用于重建行的换行分隔符。
function newlineSeparator(style: NewlineStyle): string {
  if (style === "crlf") {
    return "\r\n";
  }
  if (style === "cr") {
    return "\r";
  }
  return "\n";
}

// 把文本拆成保留原始换行的行片段，供未触及行原样复制。
function splitLinesWithEndings(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (text[i] === "\r") {
      if (text[i + 1] === "\n") {
        lines.push(text.slice(start, i + 2));
        i += 1;
        start = i + 1;
      } else {
        lines.push(text.slice(start, i + 1));
        start = i + 1;
      }
    }
  }
  if (start < text.length || text.length === 0) {
    lines.push(text.slice(start));
  }
  return lines;
}

// 返回新旧文本首个不同行的 1-based 行号，两文本完全相同时返回 undefined。
function firstChangedLine(original: string, updated: string): number | undefined {
  const originalLines = original.split("\n");
  const updatedLines = updated.split("\n");
  const count = Math.max(originalLines.length, updatedLines.length);
  for (let i = 0; i < count; i += 1) {
    if (originalLines[i] !== updatedLines[i]) {
      return i + 1;
    }
  }
  return undefined;
}

interface DiffDisplayEvent {
  kind: "context" | "removed" | "added";
  text: string;
  oldLine: number;
  newLine: number;
}

// 生成带行号和有限上下文的展示型 diff，供 ToolResult 预览和模型核对修改。
function renderDisplayDiff(oldText: string, newText: string, context = 3): string {
  const changes = diffLines(toLf(oldText), toLf(newText));
  const events: DiffDisplayEvent[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const change of changes) {
    const lines = splitChangeLines(change.value);
    if (change.added) {
      for (const line of lines) {
        events.push({ kind: "added", text: line, oldLine: 0, newLine });
        newLine += 1;
      }
    } else if (change.removed) {
      for (const line of lines) {
        events.push({ kind: "removed", text: line, oldLine, newLine: 0 });
        oldLine += 1;
      }
    } else {
      for (const line of lines) {
        events.push({ kind: "context", text: line, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  if (events.length === 0) {
    return "";
  }

  const changeIndices = events
    .map((event, index) => (event.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);
  const hunks: Array<{ start: number; end: number }> = [];
  for (const changeIndex of changeIndices) {
    const start = Math.max(0, changeIndex - context);
    const end = Math.min(events.length - 1, changeIndex + context);
    const last = hunks.at(-1);
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      hunks.push({ start, end });
    }
  }

  const lines: string[] = [];
  for (const hunk of hunks) {
    const slice = events.slice(hunk.start, hunk.end + 1);
    const firstOld = slice.find((event) => event.oldLine > 0)?.oldLine ?? 1;
    const firstNew = slice.find((event) => event.newLine > 0)?.newLine ?? 1;
    const oldCount = slice.filter((event) => event.kind !== "added").length;
    const newCount = slice.filter((event) => event.kind !== "removed").length;
    lines.push(`@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`);
    for (const event of slice) {
      if (event.kind === "added") {
        lines.push(`+${event.newLine} | ${event.text}`);
      } else if (event.kind === "removed") {
        lines.push(`-${event.oldLine} | ${event.text}`);
      } else {
        lines.push(` ${event.oldLine} | ${event.text}`);
      }
    }
  }
  return lines.join("\n");
}

// 把 jsdiff 的整块 value 拆为不含末尾空串的单行列表。
function splitChangeLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

// 构造带稳定错误码、相关编辑索引和出现次数的结构化失败。
function editFailure(
  code: EditDiffErrorCode,
  editIndex?: number,
  occurrences?: number,
): EditDiffResult {
  return {
    ok: false,
    error: {
      code,
      ...(editIndex === undefined ? {} : { editIndex }),
      ...(occurrences === undefined ? {} : { occurrences }),
      message: editErrorMessage(code, editIndex, occurrences),
    },
  };
}

// 生成面向模型的稳定修正提示，不同失败码说明可采取的动作。
function editErrorMessage(
  code: EditDiffErrorCode,
  editIndex?: number,
  occurrences?: number,
): string {
  switch (code) {
    case "edit_target_not_found":
      return `edit ${editIndex} target was not found in the file`;
    case "edit_target_not_unique":
      return `edit ${editIndex} target is not unique${occurrences === undefined ? "" : ` (${occurrences} occurrences)`}; add more surrounding context`;
    case "edit_targets_overlap":
      return "edit targets overlap or nest; merge overlapping edits into one";
    case "edit_no_change":
      return "the replacement leaves the file unchanged";
  }
}
