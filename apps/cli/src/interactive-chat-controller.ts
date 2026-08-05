import type {
  HeadlessTurnOptions,
  HeadlessTurnResult,
  ProviderStreamEvent,
} from "@byte-mentor/agent";
import type { Message, RuntimeEvent, SessionId } from "@byte-mentor/core";

export interface InteractiveChatView {
  start(): void;
  stop(): void;
  appendUserMessage(text: string): void;
  beginAssistantMessage(): void;
  appendAssistantDelta(text: string): void;
  completeAssistantMessage(content?: string): void;
  addToolCall(toolCall: { id: string; name: string; args: unknown }): void;
  startToolCall(id: string): void;
  completeToolCall(id: string, output: string): void;
  failToolCall(id: string, message: string): void;
  cancelToolCall(id: string, message: string): void;
  showError(message: string): void;
  setBusy(busy: boolean): void;
  setSessionId(sessionId: string): void;
  setExitAfterTurn(pending: boolean): void;
}

interface InteractiveChatState {
  sessionId?: SessionId;
  busy: boolean;
  exitAfterTurn: boolean;
  stopped: boolean;
}

export interface InteractiveChatControllerInput {
  loop: {
    runTurn(
      input: { userMessage: string; sessionId?: SessionId },
      options?: HeadlessTurnOptions,
    ): Promise<HeadlessTurnResult>;
  };
  view: InteractiveChatView;
  close(): Promise<void>;
}

export class InteractiveChatController {
  private readonly state: InteractiveChatState = {
    busy: false,
    exitAfterTurn: false,
    stopped: false,
  };
  private readonly exitPromise: Promise<number>;
  private resolveExit!: (code: number) => void;
  private cleanupPromise?: Promise<void>;
  private fatalViewError?: unknown;
  private turnController?: AbortController;
  private readonly cancelledToolCallIds = new Set<string>();

  // Stores the runtime and view ports and prepares a completion promise that resolves only after cleanup.
  constructor(private readonly input: InteractiveChatControllerInput) {
    this.exitPromise = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  // Starts the view once and optionally completes an initial turn without closing interactive mode.
  async start(initialMessage?: string): Promise<void> {
    try {
      this.mutateView(() => this.input.view.start());
    } catch (error) {
      await this.cleanup(1);
      throw error;
    }
    if (initialMessage !== undefined) await this.submit(initialMessage);
  }

  // Runs one serialized turn, maps live events, reconciles results, and restores idle state.
  async submit(text: string): Promise<void> {
    const userMessage = text.trim();
    if (userMessage.length === 0 || this.state.busy || this.state.stopped) return;
    this.state.busy = true;
    let streamingAssistant = false;
    const turnController = new AbortController();
    this.turnController = turnController;
    this.cancelledToolCallIds.clear();

    try {
      this.mutateView(() => this.input.view.appendUserMessage(userMessage));
      this.mutateView(() => this.input.view.setBusy(true));
      const result = await this.input.loop.runTurn(
        {
          userMessage,
          ...(this.state.sessionId !== undefined ? { sessionId: this.state.sessionId } : {}),
        },
        {
          signal: turnController.signal,
          onStreamEvent: (event) => {
            streamingAssistant = this.handleStreamEvent(event, streamingAssistant);
          },
          onRuntimeEvent: (event) => this.handleRuntimeEvent(event),
        },
      );
      this.state.sessionId = result.sessionId;
      this.mutateView(() => this.input.view.setSessionId(result.sessionId));
      this.reconcileToolMessages(result.newMessages);
      if (result.status === "cancelled") {
        if (streamingAssistant) {
          this.mutateView(() => this.input.view.completeAssistantMessage());
          streamingAssistant = false;
        }
      } else if (result.status !== "completed") {
        if (streamingAssistant) {
          this.mutateView(() => this.input.view.completeAssistantMessage());
          streamingAssistant = false;
        }
        this.mutateView(() => this.input.view.showError(result.error.message));
      }
    } catch (error) {
      if (this.fatalViewError !== undefined) {
        await this.cleanup(1);
      } else {
        try {
          if (streamingAssistant) {
            this.mutateView(() => this.input.view.completeAssistantMessage());
            streamingAssistant = false;
          }
          this.mutateView(() => this.input.view.showError(errorMessage(error)));
        } catch {
          await this.cleanup(1);
        }
      }
    } finally {
      this.turnController = undefined;
      this.state.busy = false;
      if (!this.state.stopped) {
        try {
          this.mutateView(() => this.input.view.setBusy(false));
        } catch {
          await this.cleanup(1);
        }
      }
      if (this.state.exitAfterTurn) await this.cleanup(0);
    }
  }

  // Requests immediate idle exit or aborts a busy turn and waits for it to converge before cleanup.
  requestExit(): void {
    if (this.state.stopped) return;
    if (this.state.busy) {
      this.state.exitAfterTurn = true;
      this.turnController?.abort();
      try {
        this.mutateView(() => this.input.view.setExitAfterTurn(true));
      } catch {
        void this.cleanup(1);
      }
      return;
    }
    void this.cleanup(0);
  }

  // Resolves with the final process code only after both view and runtime cleanup finish.
  waitForExit(): Promise<number> {
    return this.exitPromise;
  }

  // Applies one provider event and returns whether an assistant component remains active.
  private handleStreamEvent(event: ProviderStreamEvent, streaming: boolean): boolean {
    if (event.type === "content_delta") {
      if (!streaming) this.mutateView(() => this.input.view.beginAssistantMessage());
      this.mutateView(() => this.input.view.appendAssistantDelta(event.text));
      return true;
    }

    const content = event.message.content;
    if (streaming) {
      this.mutateView(() => this.input.view.completeAssistantMessage(content));
    } else if (content !== undefined) {
      this.mutateView(() => this.input.view.beginAssistantMessage());
      this.mutateView(() => this.input.view.completeAssistantMessage(content));
    }
    for (const toolCall of event.message.toolCalls ?? []) {
      this.mutateView(() => this.input.view.addToolCall(toolCall));
    }
    return false;
  }

  // Maps tool lifecycle RuntimeEvents into stable tool-card mutations.
  private handleRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === "tool.started") {
      this.mutateView(() => this.input.view.startToolCall(event.toolCallId));
    } else if (event.type === "tool.completed") {
      this.mutateView(() =>
        this.input.view.completeToolCall(event.toolCallId, event.resultPreview),
      );
    } else if (event.type === "tool.failed") {
      this.mutateView(() => this.input.view.failToolCall(event.toolCallId, event.message));
    } else if (event.type === "tool.cancelled") {
      this.cancelledToolCallIds.add(event.toolCallId);
      this.mutateView(() => this.input.view.cancelToolCall(event.toolCallId, event.message));
    }
  }

  // Replaces runtime previews with complete persisted ToolMessage content after the turn returns;
  // cancelled tool calls stay in the cancelled terminal state with their full cancellation message.
  private reconcileToolMessages(messages: Message[]): void {
    for (const message of messages) {
      if (message.role === "tool") {
        if (this.cancelledToolCallIds.has(message.toolCallId)) {
          this.mutateView(() =>
            this.input.view.cancelToolCall(message.toolCallId, message.content),
          );
        } else {
          this.mutateView(() =>
            this.input.view.completeToolCall(message.toolCallId, message.content),
          );
        }
      }
    }
  }

  // Executes a synchronous view mutation while preserving its failure for fatal cleanup classification.
  private mutateView(mutation: () => void): void {
    try {
      mutation();
    } catch (error) {
      this.fatalViewError = error;
      throw error;
    }
  }

  // Stops the view and closes the runtime at most once, resolving the controller's exit promise afterward.
  private cleanup(requestedCode: number): Promise<void> {
    if (this.cleanupPromise !== undefined) return this.cleanupPromise;
    this.state.stopped = true;
    this.cleanupPromise = (async () => {
      let exitCode = requestedCode;
      try {
        this.input.view.stop();
      } catch {
        exitCode = 1;
      }
      try {
        await this.input.close();
      } catch {
        exitCode = 1;
      }
      this.resolveExit(exitCode);
    })();
    return this.cleanupPromise;
  }
}

// Converts unknown turn failures into display-safe text without exposing extra object structure.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
