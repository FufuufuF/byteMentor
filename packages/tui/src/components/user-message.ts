import { Box, Markdown } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ByteMentorTheme } from "../theme.js";

export class UserMessageComponent implements Component {
  private readonly box: Box;

  // Composes one user Markdown message inside the palette's full-width background card.
  constructor(text: string, theme: ByteMentorTheme) {
    this.box = new Box(1, 1, theme.background.userMessage);
    this.box.addChild(
      new Markdown(
        text,
        0,
        0,
        theme.markdown,
        { color: theme.foreground.text },
        {
          preserveOrderedListMarkers: true,
          preserveBackslashEscapes: true,
        },
      ),
    );
  }

  // Renders the message card using pi-tui's ANSI-safe Markdown wrapping.
  render(width: number): string[] {
    return this.box.render(width);
  }

  // Invalidates the card and nested Markdown render caches.
  invalidate(): void {
    this.box.invalidate();
  }
}
