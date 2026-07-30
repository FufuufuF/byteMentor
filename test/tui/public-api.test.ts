import { describe, expect, test } from "vitest";
import { ByteMentorTui } from "@byte-mentor/tui";
import type { ByteMentorTuiOptions, ToolCallView } from "@byte-mentor/tui";

describe("@byte-mentor/tui public API", () => {
  // Verifies the package exposes its terminal-independent view contracts and a constructible TUI entry point.
  test("exports the initial interactive view contract", () => {
    const options = {
      model: "test-model",
      workspaceRoot: "/workspace",
      terminal: undefined,
      onSubmit: (_text: string) => undefined,
      onExit: () => undefined,
    } satisfies ByteMentorTuiOptions;
    const toolCall = {
      id: "tool-call-1",
      name: "read_file",
      args: { path: "README.md" },
    } satisfies ToolCallView;

    expect(ByteMentorTui).toBeTypeOf("function");
    expect(options).not.toHaveProperty("agentLoop");
    expect(options).not.toHaveProperty("sessionStore");
    expect(toolCall.name).toBe("read_file");
  });
});
