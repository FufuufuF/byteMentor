import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ByteMentorTheme } from "../theme.js";

export type StatusState = "idle" | "working" | "error" | "exit_pending";

export class StatusComponent implements Component {
  private readonly text = new Text("", 1, 0);

  // Creates an initially idle status line using the shared view palette.
  constructor(private readonly theme: ByteMentorTheme) {}

  // Maps application status into concise terminal text and optional failure detail.
  setState(state: StatusState, detail?: string): void {
    const content =
      state === "working"
        ? this.theme.foreground.accent("⠋ Working…")
        : state === "error"
          ? this.theme.foreground.error(`Error: ${detail ?? "Turn failed"}`)
          : state === "exit_pending"
            ? this.theme.foreground.warning("Exiting after this turn…")
            : "";
    this.text.setText(content);
  }

  // Renders the current status without adding transcript content while idle.
  render(width: number): string[] {
    return this.text.render(width);
  }

  // Invalidates the delegated status text cache.
  invalidate(): void {
    this.text.invalidate();
  }
}
