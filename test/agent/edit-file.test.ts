import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agentExports from "@byte-mentor/agent";
import {
  ToolRegistry,
  WorkspaceAccessPolicy,
  WorkspaceEditor,
  WorkspaceReader,
  type AgentTool,
  type ToolExecutionOutput,
  type WorkspaceAccessPolicyOverrides,
} from "@byte-mentor/agent";

const temporaryPaths = new Set<string>();

// 每个测试后删除它创建的真实工作区，避免文件内容跨用例泄漏。
afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  temporaryPaths.clear();
});

// 创建并登记一个真实临时工作区，使编辑行为来自 Node 文件系统。
async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "byte-mentor-edit-"));
  temporaryPaths.add(root);
  return root;
}

// 从包公共入口取得 edit_file Tool，使 Batch 2 缺少导出时以明确断言进入 RED。
function getEditFileTool(): AgentTool {
  const candidate = (agentExports as Record<string, unknown>)["editFileTool"];
  expect(candidate).toBeTypeOf("object");
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("editFileTool is not exported");
  }
  return candidate as AgentTool;
}

// 使用同一 Policy 组装 Reader、Editor 与 Registry，使编辑与序列化共享调用方硬上限。
function createRegistry(
  workspaceRoot: string,
  overrides?: WorkspaceAccessPolicyOverrides,
): ToolRegistry {
  const policy = new WorkspaceAccessPolicy(overrides);
  const workspaceReader = new WorkspaceReader({ workspaceRoot, policy });
  const workspaceEditor = new WorkspaceEditor({ workspaceRoot, policy });
  const registry = new ToolRegistry({
    context: { workspaceReader, workspaceEditor },
    maxSerializedToolResultCharacters: policy.limits.maxSerializedToolResultCharacters,
  });
  registry.register(getEditFileTool());
  return registry;
}

// 经 Registry 执行 edit_file，返回对象结果与 ToolMessage JSON 供契约断言复用。
async function executeEditFile(
  workspaceRoot: string,
  args: unknown,
  overrides?: WorkspaceAccessPolicyOverrides,
): Promise<ToolExecutionOutput> {
  return createRegistry(workspaceRoot, overrides).execute("edit_file", args);
}

// 确认 Tool 成功后取得编辑 payload，让各测试只描述成功语义。
function successData(output: ToolExecutionOutput): Record<string, unknown> {
  expect(output.result.ok).toBe(true);
  if (!output.result.ok) {
    throw new Error(`expected edit_file success, got ${output.result.error.code}`);
  }
  return output.result.data as Record<string, unknown>;
}

describe("edit_file success", () => {
  // 单项替换返回规范化 path、替换数、首个变化行，并把新内容原子写入目标文件。
  it("edits a file and returns the success payload", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "const a = 1;\nconst b = 2;\n");

    const output = await executeEditFile(root, {
      path: "f.txt",
      edits: [{ oldText: "const a = 1;", newText: "const a = 10;" }],
    });
    const data = successData(output);
    expect(data.path).toBe("f.txt");
    expect(data.replacements).toBe(1);
    expect(data.firstChangedLine).toBe(1);
    expect(data.diff).toContain("const a = 10;");
    expect(data.patch).toContain("+const a = 10;");
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("const a = 10;\nconst b = 2;\n");
  });

  // 一次调用内多个不相交替换全部生效，文件内容完整反映所有修改。
  it("applies multiple non-overlapping edits in one call", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "const a = 1;\nconst b = 2;\n");

    const output = await executeEditFile(root, {
      path: "f.txt",
      edits: [
        { oldText: "const a = 1;", newText: "const a = 10;" },
        { oldText: "const b = 2;", newText: "const b = 20;" },
      ],
    });
    const data = successData(output);
    expect(data.replacements).toBe(2);
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("const a = 10;\nconst b = 20;\n");
  });

  // CRLF 文件编辑后其余行与修改行都保持 CRLF，不被改写为 LF。
  it("preserves CRLF newlines in the written file", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "one\r\ntwo\r\n");

    const output = await executeEditFile(root, {
      path: "f.txt",
      edits: [{ oldText: "two", newText: "TWO" }],
    });
    successData(output);
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("one\r\nTWO\r\n");
  });

  // 带 UTF-8 BOM 的文件编辑后 BOM 仍保留，模型无需在 oldText 中提供不可见字符。
  it("preserves a UTF-8 BOM when writing the file", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "\uFEFFhello\n");

    const output = await executeEditFile(root, {
      path: "f.txt",
      edits: [{ oldText: "hello", newText: "HELLO" }],
    });
    successData(output);
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("\uFEFFHELLO\n");
  });

  // 有限模糊匹配通过 Tool 入口生效，智能引号差异不会导致失败。
  it("matches through fuzzy normalization at the tool boundary", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "it\u2019s a test\n");

    const output = await executeEditFile(root, {
      path: "f.txt",
      edits: [{ oldText: "it's", newText: "ITS" }],
    });
    successData(output);
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("ITS a test\n");
  });
});

describe("edit_file argument validation", () => {
  // 空 edits 数组违反协议 1-64 项约束，schema 在读取文件前返回 invalid_arguments。
  it("rejects an empty edits array", async () => {
    const root = await createWorkspace();
    const output = await executeEditFile(root, { path: "f.txt", edits: [] });
    expect(output.result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  // 空 oldText 违反协议，schema 拒绝且不进入文件读取。
  it("rejects an empty oldText", async () => {
    const root = await createWorkspace();
    const output = await executeEditFile(root, {
      path: "f.txt",
      edits: [{ oldText: "", newText: "x" }],
    });
    expect(output.result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  // 超过 64 项的 edits 违反协议硬上限，schema 返回 invalid_arguments。
  it("rejects more than 64 edits", async () => {
    const root = await createWorkspace();
    const edits = Array.from({ length: 65 }, (_, index) => ({
      oldText: `old${index}`,
      newText: `new${index}`,
    }));
    const output = await executeEditFile(root, { path: "f.txt", edits });
    expect(output.result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  // 超过 4096 个 Unicode 字符的 path 在读取前返回 invalid_arguments。
  it("rejects an overlong path", async () => {
    const root = await createWorkspace();
    const output = await executeEditFile(root, {
      path: "x".repeat(4097),
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(output.result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  // 单个 oldText 超过 65536 个 Unicode 字符返回 invalid_arguments。
  it("rejects an oversized oldText field", async () => {
    const root = await createWorkspace();
    const output = await executeEditFile(root, {
      path: "f.txt",
      edits: [{ oldText: "x".repeat(65_537), newText: "b" }],
    });
    expect(output.result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  // 全部 oldText 与 newText 聚合超过 262144 个 Unicode 字符返回 invalid_arguments，
  // 且该校验发生在读取文件之前：路径不存在也返回 invalid_arguments 而非 path_not_found。
  it("rejects the combined character total before reading the file", async () => {
    const root = await createWorkspace();
    const output = await executeEditFile(root, {
      path: "missing.txt",
      edits: [{ oldText: "x".repeat(200_000), newText: "y".repeat(100_000) }],
    });
    expect(output.result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  // legacy 顶层 oldText/newText 参数与字符串形式 edits 都被 additionalProperties 拒绝。
  it("rejects legacy top-level and string-form arguments", async () => {
    const root = await createWorkspace();
    const legacy = await executeEditFile(root, {
      path: "f.txt",
      oldText: "a",
      newText: "b",
    });
    expect(legacy.result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });

    const stringForm = await executeEditFile(root, {
      path: "f.txt",
      edits: '{"oldText":"a","newText":"b"}',
    });
    expect(stringForm.result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });
});

describe("edit_file domain errors", () => {
  // 目标未找到时返回稳定错误码，details 携带 path 与 editIndex。
  it("returns edit_target_not_found with path and editIndex details", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "hello\n");

    const output = await executeEditFile(root, {
      path: "f.txt",
      edits: [{ oldText: "nope", newText: "x" }],
    });
    expect(output.result).toMatchObject({
      ok: false,
      error: {
        code: "edit_target_not_found",
        details: { path: "f.txt", editIndex: 0 },
      },
    });
  });

  // 目标重复时 details 携带 occurrences，提示模型增加上下文。
  it("returns edit_target_not_unique with occurrence count", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "dup\ndup\n");

    const output = await executeEditFile(root, {
      path: "f.txt",
      edits: [{ oldText: "dup", newText: "x" }],
    });
    expect(output.result).toMatchObject({
      ok: false,
      error: {
        code: "edit_target_not_unique",
        details: { path: "f.txt", editIndex: 0, occurrences: 2 },
      },
    });
  });

  // 替换范围重叠时整次失败，文件保持原内容。
  it("returns edit_targets_overlap and keeps the file unchanged", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "abc\n");

    const output = await executeEditFile(root, {
      path: "f.txt",
      edits: [
        { oldText: "abc", newText: "z" },
        { oldText: "b", newText: "y" },
      ],
    });
    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "edit_targets_overlap" },
    });
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("abc\n");
  });

  // 替换不产生任何变化时返回 edit_no_change，不产生虚假成功记录。
  it("returns edit_no_change when nothing changes", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "hello\n");

    const output = await executeEditFile(root, {
      path: "f.txt",
      edits: [{ oldText: "hello", newText: "hello" }],
    });
    expect(output.result).toMatchObject({
      ok: false,
      error: { code: "edit_no_change" },
    });
  });
});

describe("edit_file resource limits", () => {
  // diff/patch 超过序列化预算时在写入前返回 resource_limit，目标文件保持不变。
  it("returns resource_limit before writing when the result exceeds the budget", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "f.txt"), "short\n");

    const output = await executeEditFile(
      root,
      {
        path: "f.txt",
        edits: [{ oldText: "short", newText: "short\n" + "x".repeat(10_000) }],
      },
      { limits: { maxSerializedToolResultCharacters: 400 } },
    );
    expect(output.result).toMatchObject({ ok: false, error: { code: "resource_limit" } });
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("short\n");
  });
});

describe("edit_file runtime scheduling", () => {
  // edit_file 不声明 safe 并发，Registry 应将其归类为串行以保证写副作用按模型顺序发生。
  it("is not declared concurrency safe", () => {
    expect(getEditFileTool().concurrency).toBeUndefined();
  });
});
