import { describe, expect, it } from "vitest";

type TurnState =
  | "RESTORE"
  | "COMPACT"
  | "COMMAND"
  | "BUILD"
  | "RUN"
  | "SAVE"
  | "RESPOND"
  | "DONE";
type TurnStateEvent = "ok" | "dispatch" | "shortcut";
type NextTurnState = (state: TurnState, event: TurnStateEvent) => TurnState;

async function loadNextTurnState(): Promise<NextTurnState | undefined> {
  const modulePath = "../../packages/agent/src/turn-state.ts";
  try {
    const turnState = (await import(/* @vite-ignore */ modulePath)) as {
      nextTurnState?: NextTurnState;
    };
    return turnState.nextTurnState;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Cannot find module")) {
      return undefined;
    }
    throw error;
  }
}

describe("nextTurnState", () => {
  it("resolves every declared transition", async () => {
    const nextTurnState = await loadNextTurnState();
    expect(nextTurnState).toBeTypeOf("function");
    if (nextTurnState === undefined) {
      return;
    }
    const transitions: Array<[TurnState, TurnStateEvent, TurnState]> = [
      ["RESTORE", "ok", "COMPACT"],
      ["COMPACT", "ok", "COMMAND"],
      ["COMMAND", "dispatch", "BUILD"],
      ["COMMAND", "shortcut", "DONE"],
      ["BUILD", "ok", "RUN"],
      ["RUN", "ok", "SAVE"],
      ["SAVE", "ok", "RESPOND"],
      ["RESPOND", "ok", "DONE"],
    ];

    for (const [state, event, expected] of transitions) {
      expect(nextTurnState(state, event)).toBe(expected);
    }
  });

  it("throws a clear error when a transition is missing", async () => {
    const nextTurnState = await loadNextTurnState();
    expect(nextTurnState).toBeTypeOf("function");
    if (nextTurnState === undefined) {
      return;
    }

    expect(() => nextTurnState("RUN", "dispatch")).toThrow(
      'No transition from RUN on event "dispatch"',
    );
  });
});
