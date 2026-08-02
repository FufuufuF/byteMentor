import { Editor } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

export class ChatEditor extends Editor {
  private busy = false;

  // Creates the multiline editor and forwards only trimmed, non-empty input while idle.
  constructor(tui: TUI, theme: EditorTheme, onSubmit: (text: string) => void) {
    super(tui, theme, { paddingX: 1 });
    this.onSubmit = (text) => {
      const trimmed = text.trim();
      if (!this.busy && trimmed.length > 0) onSubmit(trimmed);
    };
  }

  // Enables or disables Enter submission while leaving the editor visible and editable.
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.disableSubmit = busy;
  }
}
