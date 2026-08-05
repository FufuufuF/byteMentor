import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ToolCallView } from "../byte-mentor-tui.js";
import type { ByteMentorTheme } from "../theme.js";

export type ToolExecutionState = "pending" | "running" | "success" | "error" | "cancelled";

const MAX_RENDERED_LINES = 10;

export class ToolExecutionComponent implements Component {
  private state: ToolExecutionState = "pending";
  private output?: string;
  private readonly text: Text;

  // Creates one stable card for a tool call and safely summarizes its untrusted arguments.
  constructor(
    private readonly toolCall: ToolCallView,
    private readonly theme: ByteMentorTheme,
  ) {
    this.text = new Text("", 1, 1, this.background());
    this.updateText();
  }

  // Marks the card active without changing its position in the transcript.
  setRunning(): void {
    this.state = "running";
    this.updateText();
  }

  // Replaces any earlier preview with the latest successful tool output.
  complete(output: string): void {
    this.state = "success";
    this.output = output;
    this.updateText();
  }

  // Replaces any earlier output with a terminal error message.
  fail(message: string): void {
    this.state = "error";
    this.output = message;
    this.updateText();
  }

  // Converges a cancelled tool call into a distinct terminal state without treating it as an error.
  cancel(message: string): void {
    this.state = "cancelled";
    this.output = message;
    this.updateText();
  }

  // Renders a bounded card and adds a visible truncation marker when output exceeds its row budget.
  render(width: number): string[] {
    const lines = this.text.render(width);
    if (lines.length <= MAX_RENDERED_LINES) {
      return lines;
    }
    const notice = new Text("… output truncated", 1, 0, this.background()).render(width)[0];
    return [...lines.slice(0, MAX_RENDERED_LINES - 1), notice ?? ""];
  }

  // Invalidates the delegated text cache for resize or forced redraw.
  invalidate(): void {
    this.text.invalidate();
  }

  // Rebuilds the card's plain view text after each state or output mutation.
  private updateText(): void {
    const title = `${stateGlyph(this.state)} ${this.toolCall.name} · ${this.state}`;
    const args = safeStringify(this.toolCall.args).replace(/[\r\n]+/g, " ");
    this.text.setCustomBgFn(this.background());
    this.text.setText([title, `args: ${args}`, this.output].filter(Boolean).join("\n"));
  }

  // Selects the palette background associated with the current execution state.
  private background(): (text: string) => string {
    if (this.state === "success") return this.theme.background.toolSuccess;
    if (this.state === "error") return this.theme.background.toolError;
    if (this.state === "cancelled") return this.theme.background.toolCancelled;
    return this.theme.background.toolPending;
  }
}

// Serializes arbitrary provider arguments without allowing cycles or custom values to crash rendering.
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable arguments]";
  }
}

// Maps execution state to a compact visual glyph used in every card title.
function stateGlyph(state: ToolExecutionState): string {
  if (state === "running") return "◌";
  if (state === "success") return "✓";
  if (state === "error") return "✕";
  if (state === "cancelled") return "⊘";
  return "○";
}
