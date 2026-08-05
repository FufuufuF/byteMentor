import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellEnvironment, resolveShellPath, ShellError } from "@byte-mentor/agent";

const temporaryPaths = new Set<string>();

// 每个测试后删除它创建的临时目录与 fake shell，避免文件系统状态跨用例泄漏。
afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  temporaryPaths.clear();
});

// 创建一个真实临时目录并登记清理，供环境构造与路径解析测试使用。
async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "byte-mentor-env-test-"));
  temporaryPaths.add(dir);
  return dir;
}

// 在临时目录创建一个指定权限的 bash 伪文件，供路径解析校验存在性/普通文件/可执行权限。
async function createFakeShell(mode: number, name = "bash"): Promise<string> {
  const dir = await createWorkspace();
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, mode);
  return path;
}

// 构造一个覆盖基础集合、固定值、denylist 与额外候选的父进程环境样本。
function sampleParentEnv(): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/tester",
    USER: "tester",
    LOGNAME: "tester",
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "C",
    TERM: "xterm-256color",
    PWD: "/home/tester",
    CI: "true",
    OPENAI_API_KEY: "sk-secret",
    BYTE_MENTOR_BASH_PATH: "/custom/byte-mentor/bash",
    NODE_ENV: "test",
  };
}

describe("createShellEnvironment", () => {
  it("复制基础集合变量到子进程环境", () => {
    // 验证 PATH/HOME/USER/LOGNAME/TMPDIR/LANG 及所有 LC_* locale 变量从父进程环境复制。
    const env = createShellEnvironment({
      parentEnv: sampleParentEnv(),
      allowlist: [],
      shellPath: "/bin/bash",
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/tester");
    expect(env.USER).toBe("tester");
    expect(env.LOGNAME).toBe("tester");
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.LC_CTYPE).toBe("C");
  });

  it("跳过父进程中不存在的基础变量", () => {
    // 验证基础集合中父进程缺失的变量不出现在结果中，不写入空值占位。
    const parentEnv = sampleParentEnv();
    delete parentEnv.USER;
    delete parentEnv.TMPDIR;
    const env = createShellEnvironment({ parentEnv, allowlist: [], shellPath: "/bin/bash" });
    expect(env.USER).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("写入 Runtime 固定值并覆盖父进程同名值", () => {
    // 验证 SHELL=<shellPath>、TERM=dumb、NO_COLOR=1 固定写入，且覆盖父进程的 TERM。
    const env = createShellEnvironment({
      parentEnv: sampleParentEnv(),
      allowlist: [],
      shellPath: "/usr/local/bash",
    });
    expect(env.SHELL).toBe("/usr/local/bash");
    expect(env.TERM).toBe("dumb");
    expect(env.NO_COLOR).toBe("1");
  });

  it("不复制 PWD 且不设置 CI", () => {
    // 验证 PWD 由 Bash 按固定 cwd 重建、CI 不进入子进程，避免改变工具行为。
    const env = createShellEnvironment({
      parentEnv: sampleParentEnv(),
      allowlist: [],
      shellPath: "/bin/bash",
    });
    expect(env.PWD).toBeUndefined();
    expect(env.CI).toBeUndefined();
  });

  it("从白名单复制父进程中存在的额外变量", () => {
    // 验证 allowlist 中存在的变量被复制，且不在 allowlist 中的变量（如 OPENAI_API_KEY）不进入。
    const env = createShellEnvironment({
      parentEnv: sampleParentEnv(),
      allowlist: ["NODE_ENV"],
      shellPath: "/bin/bash",
    });
    expect(env.NODE_ENV).toBe("test");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("白名单中父进程缺失的变量被静默跳过", () => {
    // 验证 allowlist 中父进程不存在的变量不出现在结果中。
    const env = createShellEnvironment({
      parentEnv: sampleParentEnv(),
      allowlist: ["MISSING_VAR"],
      shellPath: "/bin/bash",
    });
    expect(env.MISSING_VAR).toBeUndefined();
  });

  it("固定值覆盖白名单中的同名变量", () => {
    // 验证 SHELL/TERM/NO_COLOR 即使出现在白名单中也取 Runtime 固定值。
    const parentEnv = { ...sampleParentEnv(), SHELL: "/evil", NO_COLOR: "0" };
    const env = createShellEnvironment({
      parentEnv,
      allowlist: ["SHELL", "TERM", "NO_COLOR"],
      shellPath: "/usr/local/bash",
    });
    expect(env.SHELL).toBe("/usr/local/bash");
    expect(env.TERM).toBe("dumb");
    expect(env.NO_COLOR).toBe("1");
  });

  it("固定 denylist 始终优先于白名单", () => {
    // 验证 OPENAI_API_KEY、PWD、OLDPWD、BASH_ENV、ENV、CDPATH、PROMPT_COMMAND
    // 即使出现在白名单且父进程存在，也不进入子进程环境。
    const parentEnv = {
      ...sampleParentEnv(),
      OLDPWD: "/home",
      BASH_ENV: "/etc/bash.bashrc",
      ENV: "/custom/env",
      CDPATH: ".",
      PROMPT_COMMAND: "echo hook",
    };
    const env = createShellEnvironment({
      parentEnv,
      allowlist: ["OPENAI_API_KEY", "PWD", "OLDPWD", "BASH_ENV", "ENV", "CDPATH", "PROMPT_COMMAND"],
      shellPath: "/bin/bash",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PWD).toBeUndefined();
    expect(env.OLDPWD).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.ENV).toBeUndefined();
    expect(env.CDPATH).toBeUndefined();
    expect(env.PROMPT_COMMAND).toBeUndefined();
  });

  it("拒绝所有 BYTE_MENTOR_ 前缀变量", () => {
    // 验证任意 BYTE_MENTOR_ 前缀变量（如 BYTE_MENTOR_BASH_PATH）被整体拒绝。
    const env = createShellEnvironment({
      parentEnv: sampleParentEnv(),
      allowlist: ["BYTE_MENTOR_BASH_PATH", "BYTE_MENTOR_SESSION_DIR"],
      shellPath: "/bin/bash",
    });
    expect(env.BYTE_MENTOR_BASH_PATH).toBeUndefined();
    expect(env.BYTE_MENTOR_SESSION_DIR).toBeUndefined();
  });
});

describe("resolveShellPath", () => {
  // 统一断言解析失败抛出 code 为 shell_unavailable 的 ShellError。
  function expectShellUnavailable(fn: () => string): void {
    try {
      fn();
      expect.unreachable("expected ShellError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ShellError);
      if (error instanceof ShellError) {
        expect(error.code).toBe("shell_unavailable");
      }
    }
  }

  it("显式绝对路径被优先采用而非默认路径", async () => {
    // 验证 explicitShellPath 指向可执行普通文件时，即使默认路径也可用，仍返回显式路径。
    const fakeBash = await createFakeShell(0o755);
    const defaultBash = await createFakeShell(0o755);
    const result = resolveShellPath({
      parentEnv: { PATH: "/usr/bin:/bin" },
      explicitShellPath: fakeBash,
      defaultShellPath: defaultBash,
    });
    expect(result).toBe(fakeBash);
  });

  it("显式相对路径被拒绝为 shell_unavailable", () => {
    // 验证显式配置必须是绝对路径，相对路径不启动子进程。
    expectShellUnavailable(() =>
      resolveShellPath({
        parentEnv: { PATH: "/usr/bin:/bin" },
        explicitShellPath: "bin/bash",
      }),
    );
  });

  it("显式路径不存在时返回 shell_unavailable", async () => {
    // 验证显式路径不存在时抛 ShellError("shell_unavailable")。
    const dir = await createWorkspace();
    expectShellUnavailable(() =>
      resolveShellPath({
        parentEnv: { PATH: "/usr/bin:/bin" },
        explicitShellPath: join(dir, "missing-bash"),
      }),
    );
  });

  it("显式路径是目录时返回 shell_unavailable", async () => {
    // 验证显式路径为目录（非普通文件）时抛 ShellError("shell_unavailable")。
    const dir = await createWorkspace();
    expectShellUnavailable(() =>
      resolveShellPath({
        parentEnv: { PATH: "/usr/bin:/bin" },
        explicitShellPath: dir,
      }),
    );
  });

  it("显式路径不可执行时返回 shell_unavailable", async () => {
    // 验证显式路径无执行权限时抛 ShellError("shell_unavailable")。
    const nonExecutable = await createFakeShell(0o644);
    expectShellUnavailable(() =>
      resolveShellPath({
        parentEnv: { PATH: "/usr/bin:/bin" },
        explicitShellPath: nonExecutable,
      }),
    );
  });

  it("默认路径存在时直接返回默认路径", async () => {
    // 验证 defaultShellPath（默认 /bin/bash）可执行时直接返回，不落入 PATH 查找。
    const fakeBash = await createFakeShell(0o755);
    const result = resolveShellPath({
      parentEnv: { PATH: "/usr/bin:/bin" },
      defaultShellPath: fakeBash,
    });
    expect(result).toBe(fakeBash);
  });

  it("真实环境默认 /bin/bash 存在时返回它", () => {
    // 验证未注入 defaultShellPath 时使用默认 /bin/bash；环境缺失时跳过该用例。
    if (!existsSync("/bin/bash")) {
      return;
    }
    expect(resolveShellPath({ parentEnv: process.env })).toBe("/bin/bash");
  });

  it("默认路径缺失时通过受控 PATH 查找 bash", async () => {
    // 验证默认路径不可用时，从 parentEnv.PATH 的目录逐个查找可执行 bash。
    const fakeBash = await createFakeShell(0o755);
    const dir = join(fakeBash, "..");
    const result = resolveShellPath({
      parentEnv: { PATH: dir },
      defaultShellPath: join(dir, "missing-bash"),
    });
    expect(result).toBe(fakeBash);
  });

  it("PATH 查找跳过不可执行候选并继续后续目录", async () => {
    // 验证 PATH 中不可执行的 bash 候选被跳过，继续查找后续目录中的可执行 bash。
    const dirA = await createWorkspace();
    const dirB = await createWorkspace();
    await writeFile(join(dirA, "bash"), "#!/bin/sh\n");
    await chmod(join(dirA, "bash"), 0o644);
    await writeFile(join(dirB, "bash"), "#!/bin/sh\n");
    await chmod(join(dirB, "bash"), 0o755);
    const result = resolveShellPath({
      parentEnv: { PATH: `${dirA}:${dirB}` },
      defaultShellPath: join(dirA, "missing-bash"),
    });
    expect(result).toBe(join(dirB, "bash"));
  });

  it("默认路径与 PATH 均找不到时返回 shell_unavailable", async () => {
    // 验证默认路径缺失且 PATH 中无 bash 时抛 ShellError("shell_unavailable")，不降级到 sh。
    const emptyDir = await createWorkspace();
    expectShellUnavailable(() =>
      resolveShellPath({
        parentEnv: { PATH: emptyDir },
        defaultShellPath: join(emptyDir, "missing-bash"),
      }),
    );
  });

  it("无 PATH 且无默认路径时返回 shell_unavailable", async () => {
    // 验证父进程无 PATH、默认路径也缺失时没有可用的 bash 候选。
    const emptyDir = await createWorkspace();
    expectShellUnavailable(() =>
      resolveShellPath({
        parentEnv: {},
        defaultShellPath: join(emptyDir, "missing-bash"),
      }),
    );
  });

  it("默认路径是目录时返回 shell_unavailable", async () => {
    // 验证默认路径本身不是普通文件时直接失败，不继续 PATH 查找。
    const dir = await createWorkspace();
    await mkdir(join(dir, "bash"));
    expectShellUnavailable(() =>
      resolveShellPath({
        parentEnv: { PATH: "/usr/bin:/bin" },
        defaultShellPath: join(dir, "bash"),
      }),
    );
  });
});
