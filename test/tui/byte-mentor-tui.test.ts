import { describe, expect, test } from "vitest";
import { ByteMentorTui } from "@byte-mentor/tui";
import { VirtualTerminal } from "./virtual-terminal.js";

function createView(
  terminal: VirtualTerminal,
  submitted: string[] = [],
  exits: string[] = [],
): ByteMentorTui {
  return new ByteMentorTui({
    model: "gpt-test",
    workspaceRoot: "/workspace/byte-mentor",
    terminal,
    onSubmit(text) {
      submitted.push(text);
    },
    onExit() {
      exits.push("exit");
    },
  });
}

function sendText(terminal: VirtualTerminal, text: string): void {
  for (const character of text) terminal.sendInput(character);
}

describe("ByteMentorTui", () => {
  // Starts and stops terminal ownership exactly once even when cleanup is requested repeatedly.
  test("keeps start and stop idempotent", async () => {
    const terminal = new VirtualTerminal();
    const view = createView(terminal);

    view.start();
    view.start();
    await terminal.waitForRender();
    expect(terminal.startCount).toBe(1);
    expect(terminal.getScrollBuffer().join("\n")).toContain("Byte Mentor");

    view.stop();
    view.stop();
    await terminal.waitForRender();
    expect(terminal.stopCount).toBe(1);
    expect(terminal.cursorVisible).toBe(true);
    expect(terminal.bracketedPaste).toBe(false);
  });

  // Trims non-empty Editor input, clears it after Enter, and ignores an all-whitespace submission.
  test("submits only trimmed non-empty editor input", async () => {
    const terminal = new VirtualTerminal();
    const submitted: string[] = [];
    const view = createView(terminal, submitted);
    view.start();

    sendText(terminal, "  hello  ");
    terminal.sendInput("\r");
    sendText(terminal, "   ");
    terminal.sendInput("\r");
    await terminal.waitForRender();

    expect(submitted).toEqual(["hello"]);
    view.stop();
  });

  // Prevents a second Enter submission while a turn is busy and restores submission when idle.
  test("serializes editor submissions while busy", () => {
    const terminal = new VirtualTerminal();
    const submitted: string[] = [];
    const view = createView(terminal, submitted);
    view.start();
    view.setBusy(true);
    sendText(terminal, "blocked");
    terminal.sendInput("\r");
    view.setBusy(false);
    terminal.sendInput("\r");

    expect(submitted).toEqual(["blocked"]);
    view.stop();
  });

  // Keeps user, streamed assistant, tool, and later assistant content in chronological transcript order.
  test("renders transcript updates in occurrence order", async () => {
    const terminal = new VirtualTerminal(80, 24);
    const view = createView(terminal);
    view.start();
    view.appendUserMessage("first question");
    view.beginAssistantMessage();
    view.appendAssistantDelta("checking");
    view.completeAssistantMessage("checking tools");
    view.addToolCall({ id: "call-1", name: "read_file", args: { path: "README.md" } });
    view.startToolCall("call-1");
    view.completeToolCall("call-1", "file result");
    view.beginAssistantMessage();
    view.appendAssistantDelta("final answer");
    view.completeAssistantMessage();
    await terminal.waitForRender();

    const screen = terminal.getScrollBuffer().join("\n");
    expect(screen.indexOf("first question")).toBeLessThan(screen.indexOf("checking tools"));
    expect(screen.indexOf("checking tools")).toBeLessThan(screen.indexOf("read_file"));
    expect(screen.indexOf("read_file")).toBeLessThan(screen.indexOf("final answer"));
    view.stop();
  });

  // Routes idle Ctrl+C and empty Ctrl+D to exit while busy Ctrl+C remains a deferred-exit request.
  test("handles idle and busy exit keys without forcing process exit", () => {
    const terminal = new VirtualTerminal();
    const exits: string[] = [];
    const view = createView(terminal, [], exits);
    view.start();

    terminal.sendInput("\x03");
    terminal.sendInput("\x04");
    view.setBusy(true);
    terminal.sendInput("\x03");
    view.setExitAfterTurn(true);

    expect(exits).toHaveLength(3);
    expect(terminal.stopCount).toBe(0);
    view.stop();
  });

  // Re-renders the complete layout at narrow and wide sizes without crashing or terminal overflow.
  test.each([
    [40, 12],
    [80, 24],
    [120, 30],
  ])("supports a %sx%s viewport", async (columns, rows) => {
    const terminal = new VirtualTerminal(80, 24);
    const view = createView(terminal);
    view.start();
    view.appendUserMessage("中文问题 🚀 with a long line that should wrap safely");
    terminal.resize(columns, rows);
    await terminal.waitForRender();

    expect(terminal.getScrollBuffer().every((line) => [...line].length <= columns)).toBe(true);
    view.stop();
  });
});
