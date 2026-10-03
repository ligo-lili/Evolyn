import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { DatabaseSync } from "node:sqlite";
import { HarnessError } from "../errors.js";
import type { RunRecord } from "../runtime/run-manager.js";
import type { AnyAgentTool } from "../runtime/tools/index.js";
import { CheckpointRepo, type CheckpointRow } from "../storage/repos/checkpoints.js";
import { RunRepo } from "../storage/repos/runs.js";
import { TraceEventRepo } from "../storage/repos/trace-events.js";

export type UnresolvedState = "planned" | "executing" | "executed-no-result";

export interface UnresolvedToolCall {
  toolCallId: string;
  toolName: string;
  state: UnresolvedState;
  args: unknown;
  tool?: AnyAgentTool;
  /** Present when tool_execution_end was recorded but the toolResult message was not. */
  recordedResult?: { content: (TextContent | ImageContent)[]; isError: boolean };
}

export interface CrashedRun {
  record: RunRecord;
  /**
   * Transcript rebuilt from recorded message_end events. pi never emits an
   * event for the synthesized system message (it is created in the Agent
   * constructor), so the rebuild starts at the user message — the system
   * prompt is restored from the runs row (migration 002) by the resume path.
   */
  messages: AgentMessage[];
  unresolved: UnresolvedToolCall[];
  /** seq of the last recorded trace event — resume continues numbering from here. */
  lastSeq: number;
  checkpoint?: CheckpointRow;
}

/**
 * Rebuilds the exact state a crashed run was in, from the durable record only:
 * trace events (source of truth) reconciled against the latest checkpoint.
 * A tool call is unresolved when its toolResult message never made it to the
 * log — classified by what the log does and doesn't contain:
 *   planned            assistant asked for it, tool_execution_start never written
 *   executing          started, no end recorded — outcome unknown
 *   executed-no-result tool_execution_end recorded, toolResult message missing
 */
export function loadCrashedRun(db: DatabaseSync, runId: string, tools: readonly AnyAgentTool[]): CrashedRun {
  const record = new RunRepo(db).get(runId);
  if (!record) throw new HarnessError(`run "${runId}" not found`);
  if (record.status !== "running") throw new HarnessError(`run "${runId}" is ${record.status}, not resumable`);

  const events = new TraceEventRepo(db).getByRun(runId);
  const first = events[0];
  const last = events.at(-1);
  if (!first || first.type !== "run_start") throw new HarnessError(`run "${runId}" has no trace to recover`);
  if (last && last.type === "run_end") {
    throw new HarnessError(`run "${runId}" already recorded run_end — nothing to recover`);
  }

  const messages: AgentMessage[] = [];
  const unresolved = new Map<string, UnresolvedToolCall>();
  for (const event of events) {
    if (event.type === "message_end") {
      const m = event.message;
      messages.push(m);
      if (m.role === "assistant") {
        for (const block of m.content) {
          if (block.type === "toolCall" && !unresolved.has(block.id)) {
            unresolved.set(block.id, {
              toolCallId: block.id,
              toolName: block.name,
              state: "planned",
              args: block.arguments,
              tool: tools.find((t) => t.name === block.name),
            });
          }
        }
      } else if (m.role === "toolResult") {
        unresolved.delete(m.toolCallId);
      }
    } else if (event.type === "tool_execution_start") {
      const tracked = unresolved.get(event.toolCallId);
      if (tracked) tracked.state = "executing";
    } else if (event.type === "tool_execution_end") {
      const tracked = unresolved.get(event.toolCallId);
      if (tracked) {
        tracked.state = "executed-no-result";
        tracked.recordedResult = { content: event.result.content, isError: event.isError };
      }
    }
  }

  return {
    record,
    messages,
    unresolved: [...unresolved.values()],
    lastSeq: last?.seq ?? 0,
    checkpoint: new CheckpointRepo(db).latest(runId),
  };
}

export type RecoveryAction =
  { kind: "rebuild_result" } | { kind: "reexecute" } | { kind: "synthesize_error"; reason: string };

/**
 * Recovery decision per unresolved call:
 *  - executed-no-result → rebuild the toolResult from the recorded execution
 *    result (no side effect, no model call).
 *  - executing → replay-safe tools re-execute; everything else synthesizes an
 *    error result so the model sees "outcome unknown" instead of a hallucinated
 *    success (this is what protects non-idempotent tools like send_notification).
 *  - planned → execute now: pi emits tool_execution_start BEFORE tool.execute,
 *    and our log is unbuffered, so a missing start proves the call never began;
 *    completing the durable intent once is safe regardless of the replay flag.
 */
export function planRecovery(u: UnresolvedToolCall): RecoveryAction {
  if (u.state === "executed-no-result" && u.recordedResult) return { kind: "rebuild_result" };
  if (u.state === "executing") {
    return u.tool?.replay === "safe"
      ? { kind: "reexecute" }
      : {
          kind: "synthesize_error",
          reason: `tool "${u.toolName}" was interrupted by a crash mid-execution; its outcome is unknown`,
        };
  }
  return { kind: "reexecute" };
}

export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: (TextContent | ImageContent)[],
  isError: boolean,
  details?: unknown,
): AgentMessage {
  const message = {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    isError,
    ...(details !== undefined ? { details } : {}),
    timestamp: Date.now(),
  };
  return message as AgentMessage;
}
