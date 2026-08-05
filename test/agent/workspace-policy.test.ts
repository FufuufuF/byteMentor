import { describe, expect, it } from "vitest";
import * as agentExports from "@byte-mentor/agent";
import type { WorkspaceAccessPolicy, WorkspaceAccessPolicyOverrides } from "@byte-mentor/agent";

type WorkspaceAccessPolicyConstructor = new (
  overrides?: WorkspaceAccessPolicyOverrides,
) => WorkspaceAccessPolicy;

// 从包公共入口取得 Policy 构造器，使缺少导出时表现为清晰的 RED 断言，而不是测试模块加载错误。
function getPolicyConstructor(): WorkspaceAccessPolicyConstructor {
  const candidate = (agentExports as Record<string, unknown>)["WorkspaceAccessPolicy"];
  expect(candidate).toBeTypeOf("function");
  if (typeof candidate !== "function") {
    throw new Error("WorkspaceAccessPolicy is not exported");
  }
  return candidate as WorkspaceAccessPolicyConstructor;
}

// 使用包公开构造器创建 Policy，供默认规则和覆盖行为测试复用。
function createPolicy(overrides?: WorkspaceAccessPolicyOverrides): WorkspaceAccessPolicy {
  const Policy = getPolicyConstructor();
  return new Policy(overrides);
}

describe("WorkspaceAccessPolicy defaults", () => {
  // 默认敏感路径必须阻止直接访问及其子路径，同时明确允许可提交到仓库的 .env.example。
  it("denies sensitive paths while allowing .env.example", () => {
    const policy = createPolicy();

    expect(policy.isDenied(".git")).toBe(true);
    expect(policy.isDenied(".git/config")).toBe(true);
    expect(policy.isDenied(".byte-mentor/session.json")).toBe(true);
    expect(policy.isDenied(".env")).toBe(true);
    expect(policy.isDenied(".env.local")).toBe(true);
    expect(policy.isDenied(".env.example")).toBe(false);
    expect(policy.isDenied("src/index.ts")).toBe(false);
  });

  // 递归搜索必须跳过敏感路径和高噪声构建目录，但这些非敏感构建目录仍可被直接读取。
  it("excludes denied and noisy directories only from recursive search", () => {
    const policy = createPolicy();

    for (const path of [
      ".git/config",
      ".byte-mentor/session.json",
      ".env.local",
      "node_modules/pkg/index.js",
      "dist/index.js",
      "build/index.js",
      "coverage/report.json",
    ]) {
      expect(policy.isSearchExcluded(path)).toBe(true);
    }
    expect(policy.isSearchExcluded("src/index.ts")).toBe(false);
    expect(policy.isSearchExcluded(".env.example")).toBe(false);
    expect(policy.isDenied("dist/index.js")).toBe(false);
  });

  // 默认资源上限是 Runtime 的安全基线；这里固定每个数值，防止 Tool 参数绕过或默认值漂移。
  it("provides the confirmed default resource limits", () => {
    const policy = createPolicy();

    expect(policy.limits).toEqual({
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
    });
  });
});

describe("WorkspaceAccessPolicy overrides", () => {
  // 调用方提供数组时应整体替换默认规则，数值上限则只覆盖指定字段并保留其余安全默认值。
  it("replaces path rules and partially overrides resource limits", () => {
    const policy = createPolicy({
      deniedPaths: ["private/**"],
      searchExcludes: ["vendor/**"],
      limits: { maxResultLimit: 25 },
    });

    expect(policy.isDenied("private/secret.txt")).toBe(true);
    expect(policy.isDenied(".git/config")).toBe(false);
    expect(policy.isSearchExcluded("vendor/package.js")).toBe(true);
    expect(policy.isSearchExcluded("node_modules/package/index.js")).toBe(false);
    expect(policy.limits.maxResultLimit).toBe(25);
    expect(policy.limits.defaultResultLimit).toBe(50);
  });

  // 资源上限必须是正整数；这里验证零、负数和小数不会进入运行时配置。
  it("rejects invalid resource limit overrides", () => {
    const Policy = getPolicyConstructor();

    expect(() => new Policy({ limits: { maxResultLimit: 0 } })).toThrow();
    expect(() => new Policy({ limits: { maxReadLines: -1 } })).toThrow();
    expect(() => new Policy({ limits: { maxTraversalEntries: 1.5 } })).toThrow();
  });
});
