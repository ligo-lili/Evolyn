import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { DatabaseSync } from "node:sqlite";
import { HarnessError } from "../errors.js";
import { harnessDataDir } from "../runtime/paths.js";
import type { RunRecord } from "../runtime/run-manager.js";
import type { AnyAgentTool } from "../runtime/tools/index.js";
import { CheckpointRepo, type CheckpointRow } from "../storage/repos/checkpoints.js";
import { ContextWatermarkRepo } from "../storage/repos/context-watermarks.js";
import { RunRepo } from "../storage/repos/runs.js";
import { TraceEventRepo } from "../storage/repos/trace-events.js";
import type { CheckpointState, TrackedToolCall } from "./checkpoint.js";

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
  /** Latest checkpoint row — the lagging, independent copy of the state machine. */
  checkpoint?: CheckpointRow;
  /**
   * 加固期第二轮: findings where the durable record contradicts itself (the
   * lagging checkpoint saw state the trace no longer holds, or a pending call
   * it recorded vanished). Surfaced to stderr by resume — never auto-repaired:
   * the trace stays the authority, and a silent "fix" would hide real loss.
   */
  degradations: string[];
}

/**
 * Rebuilds the exact state a crashed run was in, from the durable record only:
 * trace events (source of truth) cross-checked against the latest checkpoint —
 * the checkpoint's message count, seq horizon and pending tool-call set must
 * all be consistent with the rebuilt trace; every disagreement becomes a
 * degradation note (加固期第二轮; before that the checkpoint was written but
 * never read).
 * A tool call is unresolved when its toolResult message never made it to the
 * log — classified by what the log does and doesn't contain:
 *   planned            assistant asked for it, tool_execution_start never written
 *   executing          started, no end recorded — outcome unknown
 *   executed-no-result tool_execution_end recorded, toolResult message missing
 */
export function loadCrashedRun(
  db: DatabaseSync,
  runId: string,
  tools: readonly AnyAgentTool[],
  opts: { traceFile?: string } = {},
): CrashedRun {
  const record = new RunRepo(db).get(runId);
  if (!record) throw new HarnessError(`run "${runId}" not found`);
  if (record.status !== "running") throw new HarnessError(`run "${runId}" is ${record.status}, not resumable`);

  const events = new TraceEventRepo(db).getByRun(runId);
  const first = events[0];
  const last = events.at(-1);
  if (!first) {
    // 加固期第二轮/第五轮: a run killed in the window between the runs-row
    // insert and its FIRST trace event (run_start) used to be a permanently
    // stuck row ("no trace to recover"). The restart is only provable when a
    // trace sink actually ran: the between-sinks remnant was just cleared by
    // reconcile, which leaves the trace FILE behind (empty) — while a
    // trace-less run (`trace: false`) never creates it, and with no recorder
    // a crashed trace-less run can have executed tools with zero durable
    // events. So: restart requires the trace file's existence, and refuses on
    // any counter-proof — a checkpoint, a watermark (even a corrupt one), or
    // evidence files all mean the ledger was partially LOST, and a restart
    // could duplicate side effects. The evidence read itself fails CLOSED: an
    // unreadable directory is "cannot prove", not "no evidence".
    const checkpoint = new CheckpointRepo(db).latest(runId);
    const watermarkRepo = new ContextWatermarkRepo(db);
    if (checkpoint || watermarkRepo.exists(runId)) {
      const proof = checkpoint ? `checkpoint seq ${checkpoint.seq} exists` : "a persisted context watermark exists";
      throw new HarnessError(
        `run "${runId}" has an empty trace but ${proof} — the ledger was ` +
          `partially lost; refusing to restart (re-running could duplicate side effects) — repair or clear the record by hand`,
      );
    }
    const evidenceDir = path.join(harnessDataDir(process.cwd()), "evidence", runId);
    let evidence: string[] = [];
    try {
      evidence = fs.readdirSync(evidenceDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new HarnessError(
          `run "${runId}" has an empty trace and the evidence directory ${evidenceDir} cannot be read ` +
            `(${err instanceof Error ? err.message : err}) — cannot prove the run never executed; refusing to restart`,
        );
      }
      evidence = [];
    }
    if (evidence.length > 0) {
      throw new HarnessError(
        `run "${runId}" has an empty trace but ${evidence.length} evidence file(s) exist under ${evidenceDir} — ` +
          `the ledger was partially lost; refusing to restart (re-running could duplicate side effects)`,
      );
    }
    if (opts.traceFile === undefined || !fs.existsSync(opts.traceFile)) {
      throw new HarnessError(
        `run "${runId}" has no trace to recover — no event was ever recorded and the trace file is missing ` +
          `(the run was trace-less, or died before its first trace append); refusing an unprovable restart`,
      );
    }
    return {
      record,
      messages: [],
      unresolved: [],
      lastSeq: 0,
      degradations: [
        "trace is empty — no event was ever recorded, nothing can have executed; restarting the task under the same run id",
      ],
    };
  }
  if (first.type !== "run_start") throw new HarnessError(`run "${runId}" has no trace to recover`);
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

  const checkpoint = new CheckpointRepo(db).latest(runId);
  const lastSeq = last?.seq ?? 0;
  return {
    record,
    messages,
    unresolved: [...unresolved.values()],
    lastSeq,
    checkpoint,
    degradations: crossCheckCheckpoint(checkpoint, messages, unresolved, lastSeq),
  };
}

/**
 * 加固期第二轮: the one-directional consistency checks that turn the lagging
 * checkpoint into a real degradation detector. Each check fires only when the
 * checkpoint saw MORE than the trace still holds — the checkpoint legitimately
 * lags (it is written after the log), so equality and shortfall are expected,
 * but excess proves event loss (a sink hole below the checkpoint's horizon, or
 * a JSONL tail the reconcile had to discard).
 */
function crossCheckCheckpoint(
  checkpoint: CheckpointRow | undefined,
  messages: readonly AgentMessage[],
  unresolved: ReadonlyMap<string, UnresolvedToolCall>,
  lastSeq: number,
): string[] {
  if (!checkpoint) return [];
  const state = checkpoint.state as Partial<CheckpointState> | null | undefined;
  if (!state || typeof state !== "object") return [];
  const notes: string[] = [];
  if (typeof state.messages === "number" && Number.isFinite(state.messages) && state.messages > messages.length) {
    notes.push(
      `checkpoint seq ${checkpoint.seq} counted ${state.messages} message(s) but the trace holds only ${messages.length} — message_end event(s) were lost below its horizon`,
    );
  }
  if (typeof state.lastSeq === "number" && Number.isFinite(state.lastSeq) && state.lastSeq > lastSeq) {
    notes.push(
      `checkpoint seq ${checkpoint.seq} claims trace seq ${state.lastSeq} but the log ends at ${lastSeq} — event(s) the checkpoint had seen are missing`,
    );
  }
  if (Array.isArray(state.toolCalls)) {
    const known = new Set<string>(unresolved.keys());
    for (const m of messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === "toolCall") known.add(b.id);
      } else if (m.role === "toolResult") {
        known.add(m.toolCallId);
      }
    }
    for (const t of state.toolCalls) {
      if (!t || typeof t !== "object") continue;
      const tracked = t as TrackedToolCall;
      if (typeof tracked.toolCallId === "string" && !known.has(tracked.toolCallId)) {
        notes.push(
          `checkpoint seq ${checkpoint.seq} records pending tool call ${tracked.toolCallId} ("${tracked.toolName}") ` +
            `that the trace no longer contains — its requesting message was lost; recovery cannot resolve it`,
        );
      }
    }
  }
  return notes;
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
