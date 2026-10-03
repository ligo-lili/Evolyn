import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { CheckpointRepo } from "../storage/repos/checkpoints.js";

export type ToolCallState = "planned" | "executing" | "executed";

export interface TrackedToolCall {
  toolCallId: string;
  toolName: string;
  state: ToolCallState;
}

export interface CheckpointState {
  lastSeq: number;
  messages: number;
  toolCalls: TrackedToolCall[];
}

/**
 * Writes a durable checkpoint at every message boundary: the run's position
 * (last trace seq), transcript length, and the tool-call state machine
 * (planned → executing → executed).
 *
 * Ordering invariant: the dispatcher calls this AFTER the trace recorder, so a
 * checkpoint never claims state the log doesn't yet contain — the checkpoint
 * always lags the log, and recovery reconciles by replaying trace events past
 * the checkpoint (the safe direction, like a WAL).
 */
export class CheckpointWriter {
  private messages: number;
  private readonly toolCalls: Map<string, TrackedToolCall>;

  constructor(
    private readonly repo: CheckpointRepo,
    private readonly runId: string,
    private readonly lastSeq: () => number,
    initial?: { messages?: number; toolCalls?: TrackedToolCall[] },
  ) {
    this.messages = initial?.messages ?? 0;
    this.toolCalls = new Map((initial?.toolCalls ?? []).map((t) => [t.toolCallId, { ...t }]));
  }

  onEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_end": {
        this.messages++;
        const m = event.message;
        if (m.role === "assistant") {
          for (const block of m.content) {
            if (block.type === "toolCall" && !this.toolCalls.has(block.id)) {
              this.toolCalls.set(block.id, { toolCallId: block.id, toolName: block.name, state: "planned" });
            }
          }
        } else if (m.role === "toolResult") {
          this.toolCalls.delete(m.toolCallId);
        }
        this.write("message_boundary");
        break;
      }
      case "tool_execution_start": {
        const tracked = this.toolCalls.get(event.toolCallId);
        if (tracked) tracked.state = "executing"; // log carries it; checkpoint stays at the last boundary
        break;
      }
      case "tool_execution_end": {
        const tracked = this.toolCalls.get(event.toolCallId);
        if (tracked) tracked.state = "executed";
        break;
      }
      default:
        break;
    }
  }

  private write(kind: string): void {
    const state: CheckpointState = {
      lastSeq: this.lastSeq(),
      messages: this.messages,
      toolCalls: [...this.toolCalls.values()],
    };
    this.repo.append(this.runId, kind, state);
  }
}
