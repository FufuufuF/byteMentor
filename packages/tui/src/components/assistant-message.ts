import { Markdown } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ByteMentorTheme } from "../theme.js";

export class AssistantMessageComponent implements Component {
  private content = "";
  private readonly markdown: Markdown;

  // Creates one mutable Markdown surface that remains stable throughout a streamed assistant response.
  constructor(theme: ByteMentorTheme) {
    this.markdown = new Markdown("", 1, 0, theme.markdown, {
      color: theme.foreground.text,
    });
  }

  // Appends one provider delta to the current assistant response.
  appendDelta(text: string): void {
    this.content += text;
    this.markdown.setText(this.content);
  }

  // Completes the response, replacing accumulated deltas when final content is available.
  complete(content?: string): void {
    if (content !== undefined) {
      this.content = content;
      this.markdown.setText(content);
    }
  }

  // Renders the current assistant Markdown without a message background.
  render(width: number): string[] {
    return this.markdown.render(width);
  }

  // Invalidates the Markdown cache for terminal resize or forced redraw.
  invalidate(): void {
    this.markdown.invalidate();
  }
}
