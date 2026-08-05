import type { Stats } from "node:fs";
import { lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { WorkspaceAccessPolicy } from "./workspace-policy.js";
import {
  WorkspaceError,
  WorkspacePathResolver,
  isMissingPathError,
  isOutsideRoot,
  toWorkspacePath,
} from "./workspace-path-resolver.js";
export { WorkspaceError };

export interface WorkspaceResolvedPath {
  path: string;
  type: "file" | "directory" | "other";
  isSymbolicLink: boolean;
}

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symbolic_link" | "other";
  access: "allowed" | "denied";
  sizeBytes?: number;
  targetType?: "file" | "directory" | "other" | "missing";
}

export interface WorkspaceDirectoryListing {
  path: string;
  entries: WorkspaceDirectoryEntry[];
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  type: "file" | "symbolic_link";
  sizeBytes: number;
  targetType?: "file";
}

export interface WorkspaceFileTraversal {
  path: string;
  files: WorkspaceFileEntry[];
}

export interface WorkspaceTextPosition {
  line: number;
  column: number;
}

export interface WorkspaceTextRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface WorkspaceTextWindow {
  path: string;
  encoding: "utf-8";
  bom: boolean;
  content: string;
  range: WorkspaceTextRange | null;
  eof: boolean;
  truncated: boolean;
  truncatedBy?: "line_limit" | "character_limit";
  nextPosition?: WorkspaceTextPosition;
}

export interface WorkspaceTextSearchMatch {
  path: string;
  line: number;
  firstMatchColumn: number;
  occurrenceCount: number;
  preview: string;
  previewRange: {
    startColumn: number;
    endColumn: number;
  };
  previewTruncated: boolean;
}

export type WorkspaceSkippedFileReason =
  "binary" | "invalid_utf8" | "file_too_large" | "unreadable";

export interface WorkspaceSkippedFile {
  path: string;
  reason: WorkspaceSkippedFileReason;
}

export interface WorkspaceTextSearch {
  path: string;
  matches: WorkspaceTextSearchMatch[];
  skippedFileCount: number;
  skippedFiles: WorkspaceSkippedFile[];
}

interface ReadTextWindowOptions {
  startLine: number;
  startColumn: number;
  lineLimit: number;
  maxCharacters: number;
}

interface SearchTextOptions {
  query: string;
  caseSensitive: boolean;
}

interface FileTraversalState {
  visitedDirectories: Set<string>;
  visitedEntries: number;
  files: WorkspaceFileEntry[];
}

interface TraversalTarget {
  canonicalPath: string;
  canonicalRelativePath: string;
  metadata: Stats;
}

interface ParsedTextLine {
  body: string[];
  ending: "" | "\n" | "\r" | "\r\n";
  complete: boolean;
}

interface PositionedTextUnit {
  text: string;
  line: number;
  column: number;
  next: WorkspaceTextPosition;
}

type TextWindowAnalysis =
  | { status: "need_more" }
  | { status: "complete"; window: Omit<WorkspaceTextWindow, "path" | "encoding" | "bom"> };

export class WorkspaceReader {
  readonly workspaceRoot: string;
  readonly policy: WorkspaceAccessPolicy;
  private readonly resolver: WorkspacePathResolver;

  // 固定显式工作区根目录和访问策略，并复用共享解析器执行所有路径边界校验。
  constructor(input: { workspaceRoot: string; policy: WorkspaceAccessPolicy }) {
    this.workspaceRoot = resolve(input.workspaceRoot);
    this.policy = input.policy;
    this.resolver = new WorkspacePathResolver({
      workspaceRoot: this.workspaceRoot,
      policy: input.policy,
    });
  }

  // 解析并校验一个工作区相对路径，返回稳定的相对别名、真实目标类型和链接属性。
  async resolvePath(path: string): Promise<WorkspaceResolvedPath> {
    const resolved = await this.resolver.resolveAccessiblePath(path);
    return {
      path: resolved.relativePath,
      type: resolved.type,
      isSymbolicLink: resolved.isSymbolicLink,
    };
  }

  // 列举一个允许访问目录的直接子项，并集中处理稳定排序、链接目标和 denied 最小元数据。
  async listDirectory(path: string): Promise<WorkspaceDirectoryListing> {
    const resolvedDirectory = await this.resolvePath(path);
    if (resolvedDirectory.type !== "directory") {
      throw new WorkspaceError(
        "wrong_path_type",
        `workspace path is not a directory: ${resolvedDirectory.path}`,
      );
    }

    const absoluteDirectory = resolve(this.workspaceRoot, resolvedDirectory.path);
    const directoryEntries = await readdir(absoluteDirectory);
    const entries: WorkspaceDirectoryEntry[] = [];
    for (const name of directoryEntries) {
      entries.push(await this.describeDirectoryEntry(resolvedDirectory.path, name));
    }
    entries.sort(compareDirectoryEntries);
    return { path: resolvedDirectory.path, entries };
  }

  // 递归收集允许搜索的文件，并用 canonical 目录去重和遍历计数保证循环安全与资源有界。
  async walkFiles(path: string): Promise<WorkspaceFileTraversal> {
    const resolvedDirectory = await this.resolvePath(path);
    if (resolvedDirectory.type !== "directory") {
      throw new WorkspaceError(
        "wrong_path_type",
        `workspace path is not a directory: ${resolvedDirectory.path}`,
      );
    }

    const absoluteDirectory = resolve(this.workspaceRoot, resolvedDirectory.path);
    const startingTarget = await this.resolveTraversalTarget(absoluteDirectory);
    if (
      startingTarget === undefined ||
      this.policy.isSearchExcluded(resolvedDirectory.path) ||
      this.policy.isSearchExcluded(startingTarget.canonicalRelativePath)
    ) {
      return { path: resolvedDirectory.path, files: [] };
    }

    const state: FileTraversalState = {
      visitedDirectories: new Set([startingTarget.canonicalPath]),
      visitedEntries: 0,
      files: [],
    };
    await this.walkDirectory(resolvedDirectory.path, absoluteDirectory, state);
    state.files.sort(compareWorkspaceFiles);
    return { path: resolvedDirectory.path, files: state.files };
  }

  // 从指定 1-based 行列增量读取 UTF-8 窗口，并以 Policy 扫描预算限制定位成本。
  async readTextWindow(path: string, options: ReadTextWindowOptions): Promise<WorkspaceTextWindow> {
    const resolvedFile = await this.resolvePath(path);
    if (resolvedFile.type !== "file") {
      throw new WorkspaceError(
        "wrong_path_type",
        `workspace path is not a file: ${resolvedFile.path}`,
      );
    }

    const absolutePath = resolve(this.workspaceRoot, resolvedFile.path);
    let decoded;
    try {
      decoded = await readUtf8Window(absolutePath, options, this.policy.limits.maxReadScanBytes);
    } catch (error) {
      if (isPermissionError(error)) {
        throw new WorkspaceError(
          "access_denied",
          `workspace file is unreadable: ${resolvedFile.path}`,
        );
      }
      throw error;
    }
    return {
      path: resolvedFile.path,
      encoding: "utf-8",
      bom: decoded.bom,
      ...decoded.window,
    };
  }

  // 在单文件或允许递归的目录内顺序搜索文本，并集中执行编码、跳过详情和扫描资源策略。
  async searchText(path: string, options: SearchTextOptions): Promise<WorkspaceTextSearch> {
    const resolvedPath = await this.resolvePath(path);
    if (resolvedPath.type === "file") {
      const matchResult = await this.searchSingleFile(resolvedPath.path, options, true);
      return {
        path: resolvedPath.path,
        matches: matchResult.matches,
        skippedFileCount: 0,
        skippedFiles: [],
      };
    }
    if (resolvedPath.type !== "directory") {
      throw new WorkspaceError(
        "wrong_path_type",
        `workspace path is not a file or directory: ${resolvedPath.path}`,
      );
    }

    const traversal = await this.walkFiles(resolvedPath.path);
    const matches: WorkspaceTextSearchMatch[] = [];
    const skippedFiles: WorkspaceSkippedFile[] = [];
    let skippedFileCount = 0;
    let scannedBytes = 0;
    for (const file of traversal.files) {
      if (file.sizeBytes > this.policy.limits.maxSearchFileBytes) {
        skippedFileCount += 1;
        appendSkippedFile(skippedFiles, file.path, "file_too_large", this.policy);
        continue;
      }
      if (scannedBytes + file.sizeBytes > this.policy.limits.maxSearchTotalBytes) {
        throw new WorkspaceError(
          "resource_limit",
          `text search exceeds ${this.policy.limits.maxSearchTotalBytes} scanned bytes`,
        );
      }

      const result = await this.searchSingleFile(file.path, options, false);
      scannedBytes += result.scannedBytes;
      if (scannedBytes > this.policy.limits.maxSearchTotalBytes) {
        throw new WorkspaceError(
          "resource_limit",
          `text search exceeds ${this.policy.limits.maxSearchTotalBytes} scanned bytes`,
        );
      }
      if (result.skippedReason !== undefined) {
        skippedFileCount += 1;
        appendSkippedFile(skippedFiles, file.path, result.skippedReason, this.policy);
        continue;
      }
      matches.push(...result.matches);
    }
    matches.sort(compareTextSearchMatches);
    return { path: resolvedPath.path, matches, skippedFileCount, skippedFiles };
  }

  // 读取单个直接子项的安全元数据；被拒绝的路径仅保留名称、路径、类型和访问状态。
  private async describeDirectoryEntry(
    directoryPath: string,
    name: string,
  ): Promise<WorkspaceDirectoryEntry> {
    const path = directoryPath === "." ? name : `${directoryPath}/${name}`;
    const metadata = await lstat(resolve(this.workspaceRoot, path));
    const type = toDirectoryEntryType(metadata);

    try {
      const resolvedEntry = await this.resolvePath(path);
      if (type === "symbolic_link") {
        return {
          name,
          path,
          type,
          access: "allowed",
          targetType: resolvedEntry.type,
        };
      }
      return {
        name,
        path,
        type,
        access: "allowed",
        ...(type === "file" ? { sizeBytes: metadata.size } : {}),
      };
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "access_denied") {
        return { name, path, type, access: "denied" };
      }
      if (
        type === "symbolic_link" &&
        error instanceof WorkspaceError &&
        error.code === "path_not_found"
      ) {
        return { name, path, type, access: "allowed", targetType: "missing" };
      }
      throw error;
    }
  }

  // 按名称顺序深度优先访问一个目录，将安全文件加入结果并在进入目录前执行策略与 canonical 去重。
  private async walkDirectory(
    directoryPath: string,
    absoluteDirectory: string,
    state: FileTraversalState,
  ): Promise<void> {
    const names = await readdir(absoluteDirectory);
    names.sort(compareStrings);

    for (const name of names) {
      state.visitedEntries += 1;
      if (state.visitedEntries > this.policy.limits.maxTraversalEntries) {
        throw new WorkspaceError(
          "resource_limit",
          `workspace traversal exceeds ${this.policy.limits.maxTraversalEntries} entries`,
        );
      }

      const path = directoryPath === "." ? name : `${directoryPath}/${name}`;
      if (this.policy.isSearchExcluded(path)) {
        continue;
      }

      const absolutePath = resolve(this.workspaceRoot, path);
      const linkMetadata = await lstat(absolutePath);
      const target = await this.resolveTraversalTarget(absolutePath);
      if (target === undefined || this.policy.isSearchExcluded(target.canonicalRelativePath)) {
        continue;
      }

      if (target.metadata.isDirectory()) {
        if (state.visitedDirectories.has(target.canonicalPath)) {
          continue;
        }
        state.visitedDirectories.add(target.canonicalPath);
        await this.walkDirectory(path, absolutePath, state);
        continue;
      }

      if (target.metadata.isFile()) {
        state.files.push({
          name,
          path,
          type: linkMetadata.isSymbolicLink() ? "symbolic_link" : "file",
          sizeBytes: target.metadata.size,
          ...(linkMetadata.isSymbolicLink() ? { targetType: "file" as const } : {}),
        });
      }
    }
  }

  // 将遍历候选解析为工作区内允许搜索的 canonical 目标；外部、敏感、断裂和循环链接统一跳过。
  private async resolveTraversalTarget(absolutePath: string): Promise<TraversalTarget | undefined> {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(absolutePath);
    } catch (error) {
      if (isMissingPathError(error) || isSymbolicLinkLoopError(error)) {
        return undefined;
      }
      throw error;
    }

    const canonicalRoot = await this.resolver.canonicalWorkspaceRoot;
    const targetRelativePath = relative(canonicalRoot, canonicalPath);
    if (isOutsideRoot(targetRelativePath)) {
      return undefined;
    }
    const canonicalRelativePath = toWorkspacePath(targetRelativePath);
    if (this.policy.isSearchExcluded(canonicalRelativePath)) {
      return undefined;
    }
    return {
      canonicalPath,
      canonicalRelativePath,
      metadata: await stat(canonicalPath),
    };
  }

  // 读取并严格分类一个搜索候选；单文件调用把跳过原因提升为结构化错误，目录调用返回跳过状态。
  private async searchSingleFile(
    path: string,
    options: SearchTextOptions,
    failOnUnsupported: boolean,
  ): Promise<{
    matches: WorkspaceTextSearchMatch[];
    scannedBytes: number;
    skippedReason?: WorkspaceSkippedFileReason;
  }> {
    const absolutePath = resolve(this.workspaceRoot, path);
    const metadata = await stat(absolutePath);
    if (metadata.size > this.policy.limits.maxSearchFileBytes) {
      if (failOnUnsupported) {
        throw new WorkspaceError(
          "resource_limit",
          `file exceeds ${this.policy.limits.maxSearchFileBytes} search bytes: ${path}`,
        );
      }
      return { matches: [], scannedBytes: 0, skippedReason: "file_too_large" };
    }
    if (metadata.size > this.policy.limits.maxSearchTotalBytes) {
      throw new WorkspaceError(
        "resource_limit",
        `text search exceeds ${this.policy.limits.maxSearchTotalBytes} scanned bytes`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      if (isPermissionError(error)) {
        if (failOnUnsupported) {
          throw new WorkspaceError("access_denied", `workspace file is unreadable: ${path}`);
        }
        return { matches: [], scannedBytes: 0, skippedReason: "unreadable" };
      }
      throw error;
    }
    if (bytes.length > this.policy.limits.maxSearchFileBytes) {
      if (failOnUnsupported) {
        throw new WorkspaceError(
          "resource_limit",
          `file exceeds ${this.policy.limits.maxSearchFileBytes} search bytes: ${path}`,
        );
      }
      return { matches: [], scannedBytes: bytes.length, skippedReason: "file_too_large" };
    }

    const decoded = decodeSearchText(bytes);
    if (decoded.reason !== undefined) {
      if (failOnUnsupported) {
        throw new WorkspaceError(
          "unsupported_content",
          `workspace file is not supported UTF-8 text: ${path}`,
        );
      }
      return { matches: [], scannedBytes: bytes.length, skippedReason: decoded.reason };
    }
    return {
      matches: findTextMatches(path, decoded.text, options),
      scannedBytes: bytes.length,
    };
  }
}

// 将目录搜索的跳过文件计入完整总数，并只保存 Policy 允许数量的稳定详情。
function appendSkippedFile(
  skippedFiles: WorkspaceSkippedFile[],
  path: string,
  reason: WorkspaceSkippedFileReason,
  policy: WorkspaceAccessPolicy,
): void {
  if (skippedFiles.length < policy.limits.maxSkippedFileDetails) {
    skippedFiles.push({ path, reason });
  }
}

// 严格解码一个受单文件上限约束的 Buffer，并区分二进制 NUL 与非法 UTF-8。
function decodeSearchText(
  bytes: Buffer,
): { text: string; reason?: undefined } | { text?: undefined; reason: "binary" | "invalid_utf8" } {
  if (bytes.includes(0)) {
    return { reason: "binary" };
  }
  const content =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(content) };
  } catch {
    return { reason: "invalid_utf8" };
  }
}

// 按逻辑行查找非重叠字面量，并为每条命中行生成一次有界预览。
function findTextMatches(
  path: string,
  text: string,
  options: SearchTextOptions,
): WorkspaceTextSearchMatch[] {
  const matches: WorkspaceTextSearchMatch[] = [];
  const lines = parseTextLines(text, true);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const occurrences = findLiteralOccurrences(line.body, options.query, options.caseSensitive);
    if (occurrences.length === 0) {
      continue;
    }
    const firstMatchIndex = occurrences[0]!;
    const preview = createSearchPreview(line.body, firstMatchIndex);
    matches.push({
      path,
      line: index + 1,
      firstMatchColumn: firstMatchIndex + 1,
      occurrenceCount: occurrences.length,
      ...preview,
    });
  }
  return matches;
}

// 在 code point 数组中执行可选大小写折叠的非重叠字面量匹配，保持原始列坐标稳定。
function findLiteralOccurrences(line: string[], query: string, caseSensitive: boolean): number[] {
  const queryCharacters = Array.from(query);
  const normalizedQuery = queryCharacters.map((character) =>
    caseSensitive ? character : character.toLowerCase(),
  );
  const occurrences: number[] = [];
  for (let index = 0; index <= line.length - queryCharacters.length;) {
    const matches = normalizedQuery.every((character, queryIndex) => {
      const candidate = line[index + queryIndex]!;
      return (caseSensitive ? candidate : candidate.toLowerCase()) === character;
    });
    if (matches) {
      occurrences.push(index);
      index += queryCharacters.length;
    } else {
      index += 1;
    }
  }
  return occurrences;
}

// 以首次匹配前最多 150 个 code point 为锚点生成 300 字符预览，并在行尾附近向前补足窗口。
function createSearchPreview(
  line: string[],
  firstMatchIndex: number,
): Pick<WorkspaceTextSearchMatch, "preview" | "previewRange" | "previewTruncated"> {
  let start = Math.max(0, firstMatchIndex - 150);
  const end = Math.min(line.length, start + 300);
  start = Math.max(0, end - 300);
  return {
    preview: line.slice(start, end).join(""),
    previewRange: { startColumn: start + 1, endColumn: end },
    previewTruncated: start > 0 || end < line.length,
  };
}

// 按完整相对路径和行号排序匹配，使分页不依赖文件系统或读取完成顺序。
function compareTextSearchMatches(
  left: WorkspaceTextSearchMatch,
  right: WorkspaceTextSearchMatch,
): number {
  const pathOrder = compareStrings(left.path, right.path);
  return pathOrder === 0 ? left.line - right.line : pathOrder;
}

// 按递增块大小扫描文件，严格解码 UTF-8，并在窗口已确定时立即停止后续 I/O。
async function readUtf8Window(
  absolutePath: string,
  options: ReadTextWindowOptions,
  maxScanBytes: number,
): Promise<{
  bom: boolean;
  window: Omit<WorkspaceTextWindow, "path" | "encoding" | "bom">;
}> {
  const handle = await open(absolutePath, "r");
  try {
    const metadata = await handle.stat();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let decodedText = "";
    let position = 0;
    let chunkSize = Math.min(4_096, maxScanBytes);
    let bom = false;
    let firstChunk = true;

    while (position < metadata.size) {
      if (position >= maxScanBytes) {
        throw new WorkspaceError(
          "resource_limit",
          `reading the requested position exceeds ${maxScanBytes} scanned bytes`,
        );
      }

      const readSize = Math.min(chunkSize, metadata.size - position, maxScanBytes - position);
      const buffer = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, position);
      if (bytesRead === 0) {
        break;
      }
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) {
        throw new WorkspaceError("unsupported_content", "file contains NUL binary content");
      }

      let contentBytes = bytes;
      if (
        firstChunk &&
        bytes.length >= 3 &&
        bytes[0] === 0xef &&
        bytes[1] === 0xbb &&
        bytes[2] === 0xbf
      ) {
        bom = true;
        contentBytes = bytes.subarray(3);
      }
      firstChunk = false;
      position += bytesRead;

      try {
        decodedText += decoder.decode(contentBytes, { stream: position < metadata.size });
      } catch {
        throw new WorkspaceError("unsupported_content", "file is not valid UTF-8 text");
      }

      const atEof = position >= metadata.size;
      const analysis = analyzeTextWindow(decodedText, atEof, options);
      if (analysis.status === "complete") {
        return { bom, window: analysis.window };
      }
      chunkSize = Math.min(chunkSize * 2, 1024 * 1024);
    }

    try {
      decodedText += decoder.decode();
    } catch {
      throw new WorkspaceError("unsupported_content", "file is not valid UTF-8 text");
    }
    const finalAnalysis = analyzeTextWindow(decodedText, true, options);
    if (finalAnalysis.status === "complete") {
      return { bom, window: finalAnalysis.window };
    }
    throw new WorkspaceError("execution_failed", "unable to resolve the requested text window");
  } finally {
    await handle.close();
  }
}

// 将当前已解码前缀解释为逻辑行，并在具备截断或 EOF 证据时生成精确续读位置。
function analyzeTextWindow(
  text: string,
  atEof: boolean,
  options: ReadTextWindowOptions,
): TextWindowAnalysis {
  const lines = parseTextLines(text, atEof);
  const startIndex = options.startLine - 1;
  if (startIndex >= lines.length) {
    return atEof
      ? { status: "complete", window: createEmptyTextWindow() }
      : { status: "need_more" };
  }

  const startLine = lines[startIndex]!;
  if (options.startColumn > startLine.body.length + 1) {
    if (!startLine.complete) {
      return { status: "need_more" };
    }
    throw new WorkspaceError("invalid_arguments", `startColumn exceeds line ${options.startLine}`);
  }
  if (
    options.startColumn === startLine.body.length + 1 &&
    startLine.ending === "" &&
    !startLine.complete
  ) {
    return { status: "need_more" };
  }

  const units = positionTextUnits(lines, options.startLine, options.startColumn);
  if (units.length === 0) {
    return atEof
      ? { status: "complete", window: createEmptyTextWindow() }
      : { status: "need_more" };
  }

  const lastAllowedLine = options.startLine + options.lineLimit - 1;
  const allowedUnits = units.filter((unit) => unit.line <= lastAllowedLine);
  const selected: PositionedTextUnit[] = [];
  let characters = 0;
  for (const unit of allowedUnits) {
    const unitCharacters = Array.from(unit.text).length;
    if (characters + unitCharacters > options.maxCharacters) {
      if (selected.length === 0) {
        throw new WorkspaceError(
          "resource_limit",
          "the next line ending cannot fit within the character limit",
        );
      }
      return {
        status: "complete",
        window: createTruncatedTextWindow(selected, "character_limit"),
      };
    }
    selected.push(unit);
    characters += unitCharacters;
    if (characters === options.maxCharacters) {
      const hasKnownRemainder = units.length > selected.length;
      if (hasKnownRemainder || !atEof) {
        return {
          status: "complete",
          window: createTruncatedTextWindow(selected, "character_limit"),
        };
      }
    }
  }

  if (units.some((unit) => unit.line > lastAllowedLine)) {
    return {
      status: "complete",
      window: createTruncatedTextWindow(selected, "line_limit"),
    };
  }
  if (!atEof) {
    return { status: "need_more" };
  }
  return { status: "complete", window: createCompleteTextWindow(selected) };
}

// 将文本拆为保留原始行尾的逻辑行；未到 EOF 的末行保持 incomplete 以避免过早判定列越界。
function parseTextLines(text: string, atEof: boolean): ParsedTextLine[] {
  const lines: ParsedTextLine[] = [];
  let bodyStart = 0;
  let partialEnd = text.length;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\n" && character !== "\r") {
      continue;
    }
    if (character === "\r" && index === text.length - 1 && !atEof) {
      partialEnd = index;
      break;
    }
    const isCrLf = character === "\r" && text[index + 1] === "\n";
    lines.push({
      body: Array.from(text.slice(bodyStart, index)),
      ending: isCrLf ? "\r\n" : character,
      complete: true,
    });
    index += isCrLf ? 1 : 0;
    bodyStart = index + 1;
  }
  if (bodyStart < partialEnd || (atEof && lines.length === 0)) {
    lines.push({
      body: Array.from(text.slice(bodyStart, partialEnd)),
      ending: "",
      complete: atEof,
    });
  }
  return lines;
}

// 为正文 code point 和原始行尾建立 1-based 坐标，使 range 与 nextPosition 使用同一位置模型。
function positionTextUnits(
  lines: ParsedTextLine[],
  startLine: number,
  startColumn: number,
): PositionedTextUnit[] {
  const units: PositionedTextUnit[] = [];
  for (let index = startLine - 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    const firstColumn = lineNumber === startLine ? startColumn : 1;
    for (let column = firstColumn; column <= line.body.length; column += 1) {
      units.push({
        text: line.body[column - 1]!,
        line: lineNumber,
        column,
        next: { line: lineNumber, column: column + 1 },
      });
    }
    if (line.ending !== "" && firstColumn <= line.body.length + 1) {
      units.push({
        text: line.ending,
        line: lineNumber,
        column: line.body.length + 1,
        next: { line: lineNumber + 1, column: 1 },
      });
    }
  }
  return units;
}

// 构造没有可读字符的 EOF 窗口，避免伪造不存在的行列范围。
function createEmptyTextWindow(): Omit<WorkspaceTextWindow, "path" | "encoding" | "bom"> {
  return { content: "", range: null, eof: true, truncated: false };
}

// 构造读取至真实 EOF 的窗口，并以首尾文本单元生成闭区间坐标。
function createCompleteTextWindow(
  units: PositionedTextUnit[],
): Omit<WorkspaceTextWindow, "path" | "encoding" | "bom"> {
  if (units.length === 0) {
    return createEmptyTextWindow();
  }
  return {
    content: units.map((unit) => unit.text).join(""),
    range: createTextRange(units),
    eof: true,
    truncated: false,
  };
}

// 构造显式截断窗口，并把续读位置设置为最后一个完整文本单元之后。
function createTruncatedTextWindow(
  units: PositionedTextUnit[],
  truncatedBy: "line_limit" | "character_limit",
): Omit<WorkspaceTextWindow, "path" | "encoding" | "bom"> {
  const lastUnit = units.at(-1)!;
  return {
    content: units.map((unit) => unit.text).join(""),
    range: createTextRange(units),
    eof: false,
    truncated: true,
    truncatedBy,
    nextPosition: lastUnit.next,
  };
}

// 将首尾文本单元坐标投影为模型可见的闭区间 range。
function createTextRange(units: PositionedTextUnit[]): WorkspaceTextRange {
  const first = units[0]!;
  const last = units.at(-1)!;
  return {
    startLine: first.line,
    startColumn: first.column,
    endLine: last.line,
    endColumn: last.column,
  };
}

// 将 lstat 元数据归一化为模型可见的目录项类型，并保留符号链接自身而不是目标类型。
function toDirectoryEntryType(metadata: Stats): WorkspaceDirectoryEntry["type"] {
  if (metadata.isSymbolicLink()) {
    return "symbolic_link";
  }
  if (metadata.isFile()) {
    return "file";
  }
  if (metadata.isDirectory()) {
    return "directory";
  }
  return "other";
}

// 使用 JavaScript Unicode 字符串顺序比较名称，避免依赖平台或进程 locale 的排序差异。
function compareDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

// 按完整工作区相对路径稳定排序文件结果，使分页不受目录读取顺序影响。
function compareWorkspaceFiles(left: WorkspaceFileEntry, right: WorkspaceFileEntry): number {
  return compareStrings(left.path, right.path);
}

// 使用 JavaScript Unicode 字符串顺序比较文本，避免依赖平台或进程 locale。
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// 识别文件系统拒绝读取的错误，使单文件失败和目录跳过使用稳定语义。
function isPermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM")
  );
}

// 识别符号链接循环错误，使递归搜索跳过该入口而不是暴露底层 ELOOP。
function isSymbolicLinkLoopError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP";
}
