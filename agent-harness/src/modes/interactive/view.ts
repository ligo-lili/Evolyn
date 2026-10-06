import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * The rendering surface the agent-event reporter drives. Deliberately
 * UI-agnostic: the TUI view implements it with pi-tui components; tests
 * implement it with a recorder, so the event→UI mapping is verifiable
 * without a terminal.
 */
export interface ChatView {
  /** A user turn landed in the transcript (submit or injected steering message). */
  addUserMessage(text: string): void;
  /** The assistant started streaming (message_start). */
  beginAssistant(): void;
  /** Streaming text delta. */
  appendAssistantText(delta: string): void;
  /** Streaming thinking delta (rendered dim while it streams). */
  appendAssistantThinking(delta: string): void;
  /** The assistant message settled — rebuild the final rendering from the message. */
  endAssistantMessage(message: AssistantMessage): void;
  /** A settled assistant message rendered directly (transcript replay on resume). */
  addAssistantMessage(text: string): void;
  /** A tool call started executing. */
  beginTool(toolCallId: string, toolName: string, args: unknown): void;
  /** Partial tool output (streaming tools). */
  updateTool(toolCallId: string, partialResult: unknown): void;
  /** The tool settled. */
  endTool(toolCallId: string, result: unknown, isError: boolean): void;
  /** Working indicator on/off (agent_start / agent_end). */
  showWorking(label: string): void;
  hideWorking(): void;
  /** One-off informational line in the transcript. */
  info(text: string): void;
  /** One-off error line in the transcript. */
  error(text: string): void;
}
