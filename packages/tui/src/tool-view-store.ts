import type { Component } from "@earendil-works/pi-tui";
import type { ToolCallView } from "./byte-mentor-tui.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import type { ByteMentorTheme } from "./theme.js";

export class ToolViewStore implements Component {
  private readonly ordered: ToolExecutionComponent[] = [];
  private readonly byId = new Map<string, ToolExecutionComponent>();

  // Creates an ordered tool-card registry scoped to one transcript view.
  constructor(private readonly theme: ByteMentorTheme) {}

  // Adds one tool card once and preserves the model's original call order.
  add(toolCall: ToolCallView): ToolExecutionComponent {
    const existing = this.byId.get(toolCall.id);
    if (existing !== undefined) return existing;
    const card = new ToolExecutionComponent(toolCall, this.theme);
    this.byId.set(toolCall.id, card);
    this.ordered.push(card);
    return card;
  }

  // Marks a known tool active or creates a non-throwing fallback card for an unknown ID.
  start(id: string): void {
    this.getOrCreate(id).setRunning();
  }

  // Applies preview or reconciled output without changing card order.
  complete(id: string, output: string): void {
    this.getOrCreate(id).complete(output);
  }

  // Applies a terminal failure without changing card order.
  fail(id: string, message: string): void {
    this.getOrCreate(id).fail(message);
  }

  // Converges a cancelled tool call into a terminal cancelled card without changing card order.
  cancel(id: string, message: string): void {
    this.getOrCreate(id).cancel(message);
  }

  // Renders cards in assistant tool-call order regardless of completion order.
  render(width: number): string[] {
    return this.ordered.flatMap((card) => card.render(width));
  }

  // Invalidates all existing cards for resize or forced redraw.
  invalidate(): void {
    for (const card of this.ordered) card.invalidate();
  }

  // Returns an existing card or appends a degraded unknown-tool card for a missing ID.
  private getOrCreate(id: string): ToolExecutionComponent {
    return this.byId.get(id) ?? this.add({ id, name: "unknown tool", args: undefined });
  }
}
