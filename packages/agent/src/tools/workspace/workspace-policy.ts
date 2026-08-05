export interface WorkspaceResourceLimits {
  /** `list_directory`、`find_files`、`search_text` 在调用方未指定数量时返回的默认结果条数。 */
  defaultResultLimit: number;
  /** 模型单次请求允许返回的结果条数硬上限，超过该值的请求按 `invalid_arguments` 拒绝。 */
  maxResultLimit: number;
  /** `read_file` 在调用方未指定行数时默认读取的行数。 */
  defaultReadLines: number;
  /** 模型单次请求允许读取的行数硬上限，超过该值的请求按 `invalid_arguments` 拒绝。 */
  maxReadLines: number;
  /** 单次 `read_file` 返回的文件正文字符硬上限，为结果 envelope 预留序列化空间。 */
  maxOutputCharacters: number;
  /** 单次 ToolResult 序列化后的字符硬上限，超过该值按 `resource_limit` 拒绝，避免污染上下文。 */
  maxSerializedToolResultCharacters: number;
  /** `read_file` 为定位读取位置最多扫描的字节数，按实际扫描量限制而非按文件总大小直接拒绝。 */
  maxReadScanBytes: number;
  /** `search_text` 跳过体积更大的单个文件，并记录到 `skippedFiles` 的单文件字节阈值。 */
  maxSearchFileBytes: number;
  /** 单次内容搜索最多扫描的总字节数，达到后按 `resource_limit` 终止并不返回部分成功结果。 */
  maxSearchTotalBytes: number;
  /** 单次递归遍历最多访问的目录项数，达到后按 `resource_limit` 终止并不返回部分成功结果。 */
  maxTraversalEntries: number;
  /** 单次最多返回的跳过文件详情条数，实际跳过总数仍通过 `skippedFileCount` 完整暴露。 */
  maxSkippedFileDetails: number;
  /** 单个可编辑文件的原始字节协议硬上限，WorkspaceEditor 在 stat 与读取后各检查一次，Runtime 只能降低。 */
  maxEditableFileBytes: number;
}

export interface WorkspaceAccessPolicyOverrides {
  deniedPaths?: readonly string[];
  searchExcludes?: readonly string[];
  limits?: Partial<WorkspaceResourceLimits>;
}

const DEFAULT_DENIED_PATHS = [".git/**", ".byte-mentor/**", ".env", ".env.*"] as const;
const DEFAULT_SEARCH_EXCLUDES = [
  ...DEFAULT_DENIED_PATHS,
  "node_modules/**",
  "dist/**",
  "build/**",
  "coverage/**",
] as const;
const DEFAULT_LIMITS: Readonly<WorkspaceResourceLimits> = {
  defaultResultLimit: 50,
  maxResultLimit: 200,
  defaultReadLines: 200,
  maxReadLines: 500,
  maxOutputCharacters: 12_000,
  maxSerializedToolResultCharacters: 24_000,
  maxReadScanBytes: 10 * 1024 * 1024,
  maxSearchFileBytes: 2 * 1024 * 1024,
  maxSearchTotalBytes: 50 * 1024 * 1024,
  maxTraversalEntries: 50_000,
  maxSkippedFileDetails: 20,
  maxEditableFileBytes: 2 * 1024 * 1024,
};

export class WorkspaceAccessPolicy {
  readonly deniedPaths: readonly string[];
  readonly searchExcludes: readonly string[];
  readonly limits: Readonly<WorkspaceResourceLimits>;

  // 固定工作区的敏感路径、递归搜索排除项和资源硬上限，并校验覆盖值可安全用于计数。
  constructor(overrides: WorkspaceAccessPolicyOverrides = {}) {
    this.deniedPaths = [...(overrides.deniedPaths ?? DEFAULT_DENIED_PATHS)];
    this.searchExcludes = [...(overrides.searchExcludes ?? DEFAULT_SEARCH_EXCLUDES)];
    this.limits = { ...DEFAULT_LIMITS, ...overrides.limits };

    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError(`workspace resource limit ${name} must be a positive integer`);
      }
    }
  }

  // 判断一个工作区相对路径是否命中禁止直接访问的规则，同时保留 .env.example 例外。
  isDenied(relativePath: string): boolean {
    const normalizedPath = normalizePolicyPath(relativePath);
    if (normalizedPath === ".env.example") {
      return false;
    }
    return this.deniedPaths.some((pattern) => matchesPathRule(normalizedPath, pattern));
  }

  // 判断递归查找是否应跳过路径；任何禁止直接访问的路径也必然从搜索中排除。
  isSearchExcluded(relativePath: string): boolean {
    const normalizedPath = normalizePolicyPath(relativePath);
    if (normalizedPath === ".env.example") {
      return false;
    }
    return (
      this.isDenied(normalizedPath) ||
      this.searchExcludes.some((pattern) => matchesPathRule(normalizedPath, pattern))
    );
  }
}

// 将策略输入统一成无首尾分隔符的正斜杠路径，确保规则匹配不依赖操作系统。
function normalizePolicyPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized.length === 0 ? "." : normalized;
}

// 按受限内部语法匹配路径：尾部 /** 覆盖自身和后代，* 只覆盖单个路径段。
function matchesPathRule(relativePath: string, rule: string): boolean {
  const normalizedRule = normalizePolicyPath(rule);
  if (normalizedRule.endsWith("/**")) {
    const baseRule = normalizedRule.slice(0, -3);
    return (
      relativePath === baseRule ||
      relativePath.startsWith(`${baseRule}/`) ||
      matchesSingleSegmentPattern(relativePath, normalizedRule)
    );
  }
  return matchesSingleSegmentPattern(relativePath, normalizedRule);
}

// 将规则中的单星号限制在一个路径段内，并对其余字符执行精确匹配。
function matchesSingleSegmentPattern(relativePath: string, rule: string): boolean {
  const expression = rule
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${expression}$`).test(relativePath);
}
