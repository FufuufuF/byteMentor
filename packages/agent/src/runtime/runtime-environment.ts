import type { ModelState } from "@byte-mentor/session";

// M4.8 运行环境可用性判定端口：由 Runtime（M7）注入真实实现；agent 领域层不持有
// provider 能力表。真实实现基于运行时可用的模型能力（B9 的 ModelCapabilities 表 +
// provider 栈）判定恢复出的模型状态当前能否执行；测试与尚无注入的调用方使用默认恒可用实现。

export interface RuntimeEnvironment {
  canExecute(state: ModelState): { ok: true } | { ok: false; reason: string };
}

export const defaultRuntimeEnvironment: RuntimeEnvironment = {
  canExecute: () => ({ ok: true }),
};
