import { stripVTControlCharacters } from "node:util";
import { describe, expect, test } from "vitest";
import { createTheme, ToolExecutionComponent, ToolViewStore, visibleWidth } from "@byte-mentor/tui";

const theme = createTheme("dark");

function plain(lines: string[]): string {
  return stripVTControlCharacters(lines.join("\n"));
}

describe("tool execution cards", () => {
  // Shows the original tool identity and serializable arguments before execution starts.
  test("renders a pending tool call", () => {
    const card = new ToolExecutionComponent(
      { id: "call-1", name: "read_file", args: { path: "README.md" } },
      theme,
    );

    const rendered = plain(card.render(80));
    expect(rendered).toContain("read_file");
    expect(rendered).toContain("README.md");
    expect(rendered).toContain("pending");
  });

  // Moves one stable card through active execution to a successful terminal result.
  test("renders running and successful states", () => {
    const card = new ToolExecutionComponent(
      { id: "call-1", name: "search_text", args: { query: "mentor" } },
      theme,
    );

    card.setRunning();
    expect(plain(card.render(80))).toContain("running");
    card.complete("2 matches");
    expect(plain(card.render(80))).toContain("2 matches");
    expect(plain(card.render(80))).toContain("success");
  });

  // Replaces an early event preview with the complete ToolMessage content during reconciliation.
  test("overwrites preview output with the complete result", () => {
    const card = new ToolExecutionComponent({ id: "call-1", name: "read_file", args: {} }, theme);
    card.complete("early preview");
    card.complete("complete file contents");

    const rendered = plain(card.render(80));
    expect(rendered).toContain("complete file contents");
    expect(rendered).not.toContain("early preview");
  });

  // A cancelled tool call converges into a distinct terminal state that is not an error.
  test("renders a terminal cancelled state", () => {
    const card = new ToolExecutionComponent({ id: "call-1", name: "edit_file", args: {} }, theme);
    card.setRunning();
    card.cancel("cancelled before start");

    const rendered = plain(card.render(80));
    expect(rendered).toContain("cancelled");
    expect(rendered).toContain("cancelled before start");
  });

  // ToolViewStore routes cancelled calls to the terminal cancelled card without throwing for missing IDs.
  test("store cancels a known tool card", () => {
    const store = new ToolViewStore(theme);
    store.add({ id: "call-1", name: "edit_file", args: {} });
    store.cancel("call-1", "cancelled before start");

    const rendered = plain(store.render(80));
    expect(rendered).toContain("cancelled");
    expect(rendered).toContain("cancelled before start");
  });

  // Preserves assistant tool-call order even when later calls finish before earlier calls.
  test("keeps concurrent cards in insertion order", () => {
    const store = new ToolViewStore(theme);
    store.add({ id: "first", name: "read_file", args: { path: "first" } });
    store.add({ id: "second", name: "read_file", args: { path: "second" } });
    store.complete("second", "second done");
    store.complete("first", "first done");

    const rendered = plain(store.render(80));
    expect(rendered.indexOf("first")).toBeLessThan(rendered.indexOf("second"));
  });

  // Creates a safe fallback card for unknown IDs and never throws while formatting circular arguments.
  test("handles unknown IDs and unserializable arguments", () => {
    const store = new ToolViewStore(theme);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    store.add({ id: "circular", name: "custom", args: circular });
    store.fail("missing", "tool disappeared");

    const rendered = plain(store.render(80));
    expect(rendered).toContain("[unserializable arguments]");
    expect(rendered).toContain("unknown tool");
    expect(rendered).toContain("tool disappeared");
  });

  // Bounds multiline CJK output and keeps every rendered line safe at forty columns.
  test("truncates long output without terminal overflow", () => {
    const card = new ToolExecutionComponent(
      { id: "call-1", name: "read_file", args: { path: "中文/很长的路径.txt" } },
      theme,
    );
    card.complete(Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行 🚀`).join("\n"));
    const lines = card.render(40);

    expect(plain(lines)).toContain("output truncated");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });
});
