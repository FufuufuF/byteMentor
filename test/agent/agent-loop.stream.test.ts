import { describe, expectTypeOf, it } from "vitest";
import type { RuntimeEvent } from "@byte-mentor/core";
import type { AgentLoop, AgentRunnerInput, ProviderStreamEvent } from "@byte-mentor/agent";

describe("AgentLoop streaming contract", () => {
  // 验证 AgentLoop 对外暴露的 runTurn API 能接收流式回调选项。
  // 这里不关心 AgentLoop 的构造细节，只锁住调用方需要依赖的公共契约。
  it("accepts an optional stream event callback when running a turn", () => {
    type RunTurnOptions = Parameters<AgentLoop["runTurn"]>[1];

    expectTypeOf<RunTurnOptions>().toEqualTypeOf<
      | {
          onStreamEvent?: (event: ProviderStreamEvent) => void;
          onRuntimeEvent?: (event: RuntimeEvent) => void;
        }
      | undefined
    >();
  });

  // 验证 AgentLoop 传给 AgentRunner 的 input 也能携带同一类流式回调，
  // 这样 callback 可以一路传到 provider stream 消费位置。
  it("allows AgentRunner input to carry a stream event callback", () => {
    type StreamCallback = NonNullable<AgentRunnerInput["onStreamEvent"]>;

    expectTypeOf<Parameters<StreamCallback>[0]>().toEqualTypeOf<ProviderStreamEvent>();
  });

  // Verifies runtime lifecycle events can be observed through the same public turn and runner boundaries.
  it("accepts an optional runtime event callback throughout the agent stack", () => {
    type RunTurnOptions = NonNullable<Parameters<AgentLoop["runTurn"]>[1]>;
    type TurnCallback = NonNullable<RunTurnOptions["onRuntimeEvent"]>;
    type RunnerCallback = NonNullable<AgentRunnerInput["onRuntimeEvent"]>;

    expectTypeOf<Parameters<TurnCallback>[0]>().toEqualTypeOf<RuntimeEvent>();
    expectTypeOf<Parameters<RunnerCallback>[0]>().toEqualTypeOf<RuntimeEvent>();
  });
});
