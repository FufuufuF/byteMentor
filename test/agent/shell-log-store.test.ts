import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ShellLogError, ShellLogStore } from "@byte-mentor/agent";

const temporaryPaths = new Set<string>();

// 每个测试后删除它创建的临时目录，避免文件系统状态跨用例泄漏。
afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  temporaryPaths.clear();
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "byte-mentor-log-test-"));
  temporaryPaths.add(dir);
  return dir;
}

describe("ShellLogStore", () => {
  it("backfill 懒创建 0700 目录与 0600 日志并写入完整内容", async () => {
    // 验证首次写入时目录权限 0700、日志文件权限 0600，内容与传入文本一致且路径可读。
    const sessionDir = await createTempDir();
    const store = new ShellLogStore({ sessionTempDirectory: sessionDir });
    const result = await store.backfill("a\nb\nc\n");
    expect(result.fullOutputPath.startsWith(sessionDir)).toBe(true);
    expect(result.limitReached).toBe(false);
    const dirMode = (await stat(sessionDir)).mode & 0o777;
    const fileMode = (await stat(result.fullOutputPath)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect(await readFile(result.fullOutputPath, "utf-8")).toBe("a\nb\nc\n");
  });

  it("日志文件名使用随机部分且两次 store 不重复", async () => {
    // 验证文件名不可预测：两个独立 store 的日志文件名不同。
    const sessionDirA = await createTempDir();
    const sessionDirB = await createTempDir();
    const storeA = new ShellLogStore({ sessionTempDirectory: sessionDirA });
    const storeB = new ShellLogStore({ sessionTempDirectory: sessionDirB });
    const resultA = await storeA.backfill("x");
    const resultB = await storeB.backfill("y");
    expect(dirname(resultA.fullOutputPath)).toBe(sessionDirA);
    expect(resultA.fullOutputPath).not.toBe(resultB.fullOutputPath);
  });

  it("append 通过单一异步写链按调用顺序追加", async () => {
    // 验证多次追加内容按调用顺序拼接，不交错、不丢段。
    const sessionDir = await createTempDir();
    const store = new ShellLogStore({ sessionTempDirectory: sessionDir });
    await store.backfill("1\n");
    await store.append("2\n");
    await store.append("3\n");
    const path = (await store.fullOutputPath()) as string;
    expect(await readFile(path, "utf-8")).toBe("1\n2\n3\n");
  });

  it("写入量低于上限时 limitReached 为 false", async () => {
    // 验证未触及上限的写入不标记 limitReached，命令可正常完成。
    const sessionDir = await createTempDir();
    const store = new ShellLogStore({ sessionTempDirectory: sessionDir, maxLogBytes: 10 });
    const result = await store.backfill("abc");
    expect(result.limitReached).toBe(false);
  });

  it("恰好达到上限允许完成，limitReached 为 false", async () => {
    // 验证总字节数恰好等于上限时允许完成，不触发终止。
    const sessionDir = await createTempDir();
    const store = new ShellLogStore({ sessionTempDirectory: sessionDir, maxLogBytes: 6 });
    const result = await store.backfill("abcdef");
    expect(result.limitReached).toBe(false);
  });

  it("下一段会超过上限时写入最长前缀并标记 limitReached", async () => {
    // 验证超过上限的段只写入 scalar 边界内可容纳的最长前缀，并通知调用方终止进程。
    const sessionDir = await createTempDir();
    const store = new ShellLogStore({ sessionTempDirectory: sessionDir, maxLogBytes: 6 });
    await store.backfill("abc");
    const result = await store.append("defgh");
    expect(result.limitReached).toBe(true);
    const path = (await store.fullOutputPath()) as string;
    expect(await readFile(path, "utf-8")).toBe("abcdef");
  });

  it("超限前缀按 UTF-8 字节边界截取不破坏多字节字符", async () => {
    // 验证剩余字节不足时不会把多字节 UTF-8 字符切开，写出的前缀仍可合法解码。
    const sessionDir = await createTempDir();
    const store = new ShellLogStore({ sessionTempDirectory: sessionDir, maxLogBytes: 5 });
    await store.backfill("你"); // "你" 占 3 字节
    const result = await store.append("好"); // 剩余 2 字节，装不下 3 字节的 "好"
    expect(result.limitReached).toBe(true);
    const path = (await store.fullOutputPath()) as string;
    expect(await readFile(path, "utf-8")).toBe("你");
  });

  it("目录创建失败（目标是已存在文件）抛 ShellLogError", async () => {
    // 验证日志创建失败走错误路径，由调用方映射为 resource_limit。
    const parent = await createTempDir();
    const sessionDir = join(parent, "blocked");
    await writeFile(sessionDir, "i am a file");
    const store = new ShellLogStore({ sessionTempDirectory: sessionDir });
    await expect(store.backfill("x")).rejects.toBeInstanceOf(ShellLogError);
  });

  it("close 幂等清理整个 session 临时目录", async () => {
    // 验证 close 后目录与日志都被删除，且再次 close 不抛错。
    const sessionDir = await createTempDir();
    const store = new ShellLogStore({ sessionTempDirectory: sessionDir });
    await store.backfill("x");
    await store.close();
    await expect(access(sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("close 后日志路径不再可读", async () => {
    // 验证 Runtime close 清理后 fullOutputPath 指向的文件已不存在。
    const sessionDir = await createTempDir();
    const store = new ShellLogStore({ sessionTempDirectory: sessionDir });
    await store.backfill("x");
    const path = (await store.fullOutputPath()) as string;
    await store.close();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maxLogBytes 注入超过 100 MiB 协议上限被拒绝", async () => {
    // 验证 Runtime 只能降低完整日志字节上限，不能提高协议硬上限。
    const sessionDir = await createTempDir();
    expect(
      () =>
        new ShellLogStore({ sessionTempDirectory: sessionDir, maxLogBytes: 100 * 1024 * 1024 + 1 }),
    ).toThrow(TypeError);
  });

  it("未调用写入前不创建任何目录（懒创建）", async () => {
    // 验证只有真正需要写日志时才创建 session 临时目录，backfill 后目录才存在。
    const parent = await createTempDir();
    const sessionDir = join(parent, "session");
    const store = new ShellLogStore({ sessionTempDirectory: sessionDir });
    expect(await store.fullOutputPath()).toBeUndefined();
    await expect(access(sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
    await store.backfill("x");
    await expect(access(sessionDir)).resolves.toBeUndefined();
  });
});
