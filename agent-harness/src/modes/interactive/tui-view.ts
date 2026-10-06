import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Loader, Markdown, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ChatView } from "./view.js";
import { ToolCard } from "./tool-card.js";
import { markdownTheme, t } from "./theme.js";

/**
 * pi-tui implementation of ChatView: owns the transcript container (messages,
 * tool cards) and the status container (working loader). All mutations end in
 * a requestRender so the reporter can stay render-agnostic.
 */
export class TuiChatView implements ChatView {
  /** Fired after a user message actually landed in the transcript (used to retire steering chips). */
  onUserMessageRendered?: (text: string) => void;

  private assistantText: Markdown | undefined;
  private assistantTextValue = "";
  private thinking: Markdown | undefined;
  private thinkingValue = "";
  private readonly tools = new Map<string, ToolCard>();
  private loader: Loader | undefined;

  constructor(
    private readonly transcript: Container,
    private readonly status: Container,
    private readonly tui: TUI,
  ) {}

  private requestRender(): void {
    this.tui.requestRender();
  }

  private addEntry(component: Parameters<Container["addChild"]>[0]): void {
    this.transcript.addChild(component);
    this.transcript.addChild(new Spacer(1));
  }

  addUserMessage(text: string): void {
    this.addEntry(new Text(text, 1, 0, t.userBg));
    this.onUserMessageRendered?.(text);
    this.requestRender();
  }

  beginAssistant(): void {
    this.assistantText = undefined;
    this.assistantTextValue = "";
    this.thinking = undefined;
    this.thinkingValue = "";
  }

  private ensureThinking(): Markdown {
    if (!this.thinking) {
      this.thinking = new Markdown("", 0, 0, markdownTheme, { color: t.dim });
      this.transcript.addChild(this.thinking);
    }
    return this.thinking;
  }

  private ensureText(): Markdown {
    if (!this.assistantText) {
      this.assistantText = new Markdown("", 0, 0, markdownTheme);
      this.transcript.addChild(this.assistantText);
    }
    return this.assistantText;
  }

  appendAssistantText(delta: string): void {
    this.assistantTextValue += delta;
    this.ensureText().setText(this.assistantTextValue);
    this.requestRender();
  }

  appendAssistantThinking(delta: string): void {
    this.thinkingValue += delta;
    this.ensureThinking().setText(this.thinkingValue);
    this.requestRender();
  }

  endAssistantMessage(message: AssistantMessage): void {
    // Rebuild from the settled message — deltas are a preview, content is truth.
    const text = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text.length > 0) {
      this.assistantTextValue = text;
      this.ensureText().setText(text);
    } else if (this.assistantText) {
      this.transcript.removeChild(this.assistantText);
      this.assistantText = undefined;
    }
    if (this.thinking && this.thinkingValue.length === 0) {
      this.transcript.removeChild(this.thinking);
      this.thinking = undefined;
    }
    this.transcript.addChild(new Spacer(1));
    this.requestRender();
  }

  addAssistantMessage(text: string): void {
    this.addEntry(new Markdown(text, 0, 0, markdownTheme));
    this.requestRender();
  }

  beginTool(toolCallId: string, toolName: string, args: unknown): void {
    const card = new ToolCard(toolCallId, toolName, args);
    this.tools.set(toolCallId, card);
    this.transcript.addChild(card);
    this.transcript.addChild(new Spacer(1));
    this.requestRender();
  }

  updateTool(toolCallId: string, partialResult: unknown): void {
    this.tools.get(toolCallId)?.update(partialResult);
    this.requestRender();
  }

  endTool(toolCallId: string, result: unknown, isError: boolean): void {
    this.tools.get(toolCallId)?.finish(result, isError);
    this.requestRender();
  }

  showWorking(label: string): void {
    if (this.loader) {
      this.loader.stop();
      this.status.removeChild(this.loader);
    }
    this.loader = new Loader(this.tui, t.accent, t.dim, label);
    this.status.addChild(this.loader);
    this.loader.start();
    this.requestRender();
  }

  hideWorking(): void {
    if (this.loader) {
      this.loader.stop();
      this.status.removeChild(this.loader);
      this.loader = undefined;
      this.requestRender();
    }
  }

  info(text: string): void {
    this.addEntry(new Text(t.dim(text)));
    this.requestRender();
  }

  error(text: string): void {
    this.addEntry(new Text(t.error(text)));
    this.requestRender();
  }
}
