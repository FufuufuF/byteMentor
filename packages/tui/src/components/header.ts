import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ByteMentorTheme } from "../theme.js";

export class HeaderComponent implements Component {
  private readonly text: Text;

  // Builds the product header with Byte Mentor branding and compact startup guidance.
  constructor(theme: ByteMentorTheme) {
    this.text = new Text(
      `${theme.foreground.accent("Byte Mentor")} ${theme.foreground.muted("interactive learning assistant")}`,
      1,
      1,
    );
  }

  // Renders the header within the current terminal width.
  render(width: number): string[] {
    return this.text.render(width);
  }

  // Invalidates delegated text rendering when the terminal requests a full redraw.
  invalidate(): void {
    this.text.invalidate();
  }
}
