import { Container, matchesKey, ProcessTerminal, Text, TUI } from "@earendil-works/pi-tui";
import type { Terminal } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { ChatEditor } from "./components/chat-editor.js";
import { FooterComponent } from "./components/footer.js";
import { HeaderComponent } from "./components/header.js";
import { StatusComponent } from "./components/status.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { UserMessageComponent } from "./components/user-message.js";
import { createTheme } from "./theme.js";
import type { ByteMentorTheme } from "./theme.js";

export interface ByteMentorTuiOptions {
  model: string;
  workspaceRoot: string;
  terminal?: Terminal;
  onSubmit(text: string): void;
  onExit(): void;
}

export interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
}

export class ByteMentorTui {
  private readonly tui: TUI;
  private readonly theme: ByteMentorTheme;
  private readonly transcript = new Container();
  private readonly status: StatusComponent;
  private readonly editor: ChatEditor;
  private readonly footer: FooterComponent;
  private readonly toolCards = new Map<string, ToolExecutionComponent>();
  private currentAssistant?: AssistantMessageComponent;
  private started = false;
  private busy = false;
  private exitAfterTurn = false;

  // Composes the fixed chat layout without starting terminal raw mode during construction.
  constructor(private readonly options: ByteMentorTuiOptions) {
    const background = Number(process.env.COLORFGBG?.split(";").at(-1));
    this.theme = createTheme(Number.isFinite(background) && background >= 7 ? "light" : "dark");
    this.tui = new TUI(options.terminal ?? new ProcessTerminal(), true);
    this.status = new StatusComponent(this.theme);
    this.editor = new ChatEditor(this.tui, this.theme.editor, options.onSubmit);
    this.footer = new FooterComponent(
      {
        model: options.model,
        workspaceRoot: options.workspaceRoot,
        status: "idle",
      },
      this.theme,
    );
    this.tui.addChild(new HeaderComponent(this.theme));
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.status);
    this.tui.addChild(this.editor);
    this.tui.addChild(this.footer);
    this.tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        this.options.onExit();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+d") && this.editor.getText().trim().length === 0) {
        this.options.onExit();
        return { consume: true };
      }
      return undefined;
    });
  }

  // Starts terminal input, focuses the editor, and renders the layout exactly once.
  start(): void {
    if (this.started) {
      this.tui.requestRender();
      return;
    }
    this.started = true;
    this.tui.setFocus(this.editor);
    this.tui.terminal.setTitle("Byte Mentor");
    this.tui.start();
  }

  // Stops rendering and restores terminal state exactly once after startup.
  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.tui.terminal.setProgress(false);
    this.tui.stop();
  }

  // Sends an optional startup prompt through the same submit callback as Editor input.
  submitInitialMessage(text: string): void {
    const trimmed = text.trim();
    if (!this.busy && trimmed.length > 0) this.options.onSubmit(trimmed);
    this.tui.requestRender();
  }

  // Appends a user Markdown card to the transcript.
  appendUserMessage(text: string): void {
    this.transcript.addChild(new UserMessageComponent(text, this.theme));
    this.tui.requestRender();
  }

  // Begins one stable assistant Markdown component unless a stream is already active.
  beginAssistantMessage(): void {
    if (this.currentAssistant === undefined) {
      this.currentAssistant = new AssistantMessageComponent(this.theme);
      this.transcript.addChild(this.currentAssistant);
    }
    this.tui.requestRender();
  }

  // Appends a provider delta to the active assistant component, creating it defensively if absent.
  appendAssistantDelta(text: string): void {
    this.beginAssistantMessage();
    this.currentAssistant?.appendDelta(text);
    this.tui.requestRender();
  }

  // Completes the active assistant and clears its streaming reference for the next iteration.
  completeAssistantMessage(content?: string): void {
    if (this.currentAssistant === undefined && content !== undefined) {
      this.beginAssistantMessage();
    }
    this.currentAssistant?.complete(content);
    this.currentAssistant = undefined;
    this.tui.requestRender();
  }

  // Appends a tool card once in model call order.
  addToolCall(toolCall: ToolCallView): void {
    if (!this.toolCards.has(toolCall.id)) {
      const card = new ToolExecutionComponent(toolCall, this.theme);
      this.toolCards.set(toolCall.id, card);
      this.transcript.addChild(card);
    }
    this.tui.requestRender();
  }

  // Marks a known tool active or creates a degraded card for an unknown call ID.
  startToolCall(id: string): void {
    this.getOrCreateToolCard(id).setRunning();
    this.tui.requestRender();
  }

  // Applies preview or reconciled output to one tool card.
  completeToolCall(id: string, output: string): void {
    this.getOrCreateToolCard(id).complete(output);
    this.tui.requestRender();
  }

  // Applies a terminal tool failure without allowing a missing ID to crash the view.
  failToolCall(id: string, message: string): void {
    this.getOrCreateToolCard(id).fail(message);
    this.tui.requestRender();
  }

  // Converges a cancelled tool call into a terminal cancelled card without allowing a missing ID to crash the view.
  cancelToolCall(id: string, message: string): void {
    this.getOrCreateToolCard(id).cancel(message);
    this.tui.requestRender();
  }

  // Appends a transcript error and switches status metadata to the error state.
  showError(message: string): void {
    this.transcript.addChild(new Text(this.theme.foreground.error(`Error: ${message}`), 1, 1));
    this.status.setState("error", message);
    this.footer.setData({ status: "error" });
    this.tui.requestRender();
  }

  // Toggles single-turn input serialization and updates working display state.
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.editor.setBusy(busy);
    const state = this.exitAfterTurn ? "exit_pending" : busy ? "working" : "idle";
    this.status.setState(state);
    this.footer.setData({ status: state });
    this.tui.terminal.setProgress(busy);
    if (!busy) this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  // Updates the footer with the current process-local session identifier.
  setSessionId(sessionId: string): void {
    this.footer.setData({ sessionId });
    this.tui.requestRender();
  }

  // Shows or clears the deferred-exit state while preserving the current busy flag.
  setExitAfterTurn(pending: boolean): void {
    this.exitAfterTurn = pending;
    const state = pending ? "exit_pending" : this.busy ? "working" : "idle";
    this.status.setState(state);
    this.footer.setData({ status: state });
    this.tui.requestRender();
  }

  // Returns a known card or appends a fallback card at the first observation of an unknown ID.
  private getOrCreateToolCard(id: string): ToolExecutionComponent {
    const existing = this.toolCards.get(id);
    if (existing !== undefined) return existing;
    const fallback = new ToolExecutionComponent(
      { id, name: "unknown tool", args: undefined },
      this.theme,
    );
    this.toolCards.set(id, fallback);
    this.transcript.addChild(fallback);
    return fallback;
  }
}
