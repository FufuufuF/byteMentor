import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import type { Terminal } from "@byte-mentor/tui";

const XtermTerminal = xterm.Terminal;

export class VirtualTerminal implements Terminal {
  private readonly xterm: XtermTerminalType;
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private columnCount: number;
  private rowCount: number;
  startCount = 0;
  stopCount = 0;
  cursorVisible = true;
  bracketedPaste = false;

  // Creates a headless terminal that interprets the same ANSI output as a real viewport.
  constructor(columns = 80, rows = 24) {
    this.columnCount = columns;
    this.rowCount = rows;
    this.xterm = new XtermTerminal({
      cols: columns,
      rows,
      disableStdin: true,
      allowProposedApi: true,
    });
  }

  // Registers input and resize callbacks while tracking raw terminal lifecycle behavior.
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.startCount += 1;
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.bracketedPaste = true;
    this.write("\x1b[?2004h");
  }

  // Clears callbacks and records bracketed-paste restoration.
  stop(): void {
    this.stopCount += 1;
    this.bracketedPaste = false;
    this.write("\x1b[?2004l");
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }

  // Requires no draining because input is supplied synchronously by tests.
  async drainInput(): Promise<void> {}

  // Feeds ANSI output into xterm's headless parser.
  write(data: string): void {
    this.xterm.write(data);
  }

  get columns(): number {
    return this.columnCount;
  }

  get rows(): number {
    return this.rowCount;
  }

  get kittyProtocolActive(): boolean {
    return true;
  }

  // Moves xterm's cursor by the requested relative row count.
  moveBy(lines: number): void {
    if (lines > 0) this.write(`\x1b[${lines}B`);
    if (lines < 0) this.write(`\x1b[${-lines}A`);
  }

  // Hides the emulated hardware cursor.
  hideCursor(): void {
    this.cursorVisible = false;
    this.write("\x1b[?25l");
  }

  // Restores the emulated hardware cursor.
  showCursor(): void {
    this.cursorVisible = true;
    this.write("\x1b[?25h");
  }

  // Clears from the cursor to the end of its current line.
  clearLine(): void {
    this.write("\x1b[K");
  }

  // Clears from the cursor to the end of the viewport.
  clearFromCursor(): void {
    this.write("\x1b[J");
  }

  // Clears the complete viewport and moves the cursor home.
  clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
  }

  // Applies an OSC terminal title sequence.
  setTitle(title: string): void {
    this.write(`\x1b]0;${title}\x07`);
  }

  // Ignores shell progress metadata because viewport rendering is the behavior under test.
  setProgress(_active: boolean): void {}

  // Sends one terminal input sequence through the registered handler.
  sendInput(data: string): void {
    this.inputHandler?.(data);
  }

  // Resizes xterm and notifies the TUI render pipeline.
  resize(columns: number, rows: number): void {
    this.columnCount = columns;
    this.rowCount = rows;
    this.xterm.resize(columns, rows);
    this.resizeHandler?.();
  }

  // Waits for queued renderer and xterm parser work to settle.
  async waitForRender(): Promise<void> {
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await new Promise<void>((resolve) => this.xterm.write("", resolve));
  }

  // Returns the complete scrollback as trimmed plain terminal lines.
  getScrollBuffer(): string[] {
    const lines: string[] = [];
    const buffer = this.xterm.buffer.active;
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return lines;
  }
}
