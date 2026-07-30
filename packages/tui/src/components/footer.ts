import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ByteMentorTheme } from "../theme.js";
import type { StatusState } from "./status.js";

export interface FooterData {
  workspaceRoot: string;
  model: string;
  sessionId?: string;
  status: StatusState;
}

export class FooterComponent implements Component {
  private data: FooterData;
  private readonly text = new Text("", 1, 0);

  // Stores display-only metadata for responsive single-line rendering.
  constructor(
    data: FooterData,
    private readonly theme: ByteMentorTheme,
  ) {
    this.data = { ...data };
  }

  // Applies current model, workspace, session, or status data without replacing the component.
  setData(data: Partial<FooterData>): void {
    this.data = { ...this.data, ...data };
  }

  // Renders metadata by dropping hints, session, and workspace as the terminal narrows.
  render(width: number): string[] {
    const status = statusLabel(this.data.status);
    const fields =
      width >= 100
        ? [this.data.workspaceRoot, this.data.model, this.data.sessionId, status, "Ctrl+C exit"]
        : width >= 70
          ? [this.data.workspaceRoot, this.data.model, this.data.sessionId, status]
          : width >= 50
            ? [this.data.model, this.data.sessionId, status]
            : [this.data.model, status];
    const content = fields.filter((field): field is string => Boolean(field)).join(" | ");
    this.text.setText(
      this.theme.foreground.muted(truncateToWidth(content, Math.max(1, width - 2))),
    );
    return this.text.render(width);
  }

  // Invalidates the delegated footer text cache after resize or forced redraw.
  invalidate(): void {
    this.text.invalidate();
  }
}

// Converts internal status values into compact footer labels.
function statusLabel(status: StatusState): string {
  if (status === "working") return "working";
  if (status === "error") return "error";
  if (status === "exit_pending") return "exit pending";
  return "ready";
}
