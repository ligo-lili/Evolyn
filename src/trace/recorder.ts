import { appendFileSync } from "node:fs";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RunStatus } from "../runtime/run-manager.js";
import {
  TRACE_SCHEMA_VERSION,
  type RunLifecycleEvent,
  type TraceEnvelope,
  type TraceEvent,
  type TraceEventPayload,
} from "./schema.js";

/** A destination for finalized trace events (envelope already attached). */
export interface TraceSink {
  append(event: TraceEvent): void;
}

/**
 * Append-only JSONL, one line per event. appendFileSync means no write
 * buffering: an externally killed process can only ever lose events that were
 * never emitted — the durability property checkpoint/recovery (阶段 4/5) rely on.
 */
export class JsonlTraceSink implements TraceSink {
  constructor(readonly filePath: string) {}

  append(event: TraceEvent): void {
    appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }
}

/**
 * Assigns the per-run envelope (versioned seq + ts) once and fans the event
 * out to every sink, so all stores share identical seq numbering.
 *
 * 加固期 (P0): a FAILING sink no longer kills the run — it simply lacks that
 * event (a hole), which resume-time reconciliation and the gap-tolerant reader
 * handle; the checkpoint only lags further, which is always the safe direction.
 * An optional onSinkBoundary hook fires after the FIRST sink and before the
 * rest (the between_sinks fault point).
 */
export class TraceRecorder {
  private seq: number;

  constructor(
    readonly runId: string,
    private readonly sinks: TraceSink[],
    options: { startSeq?: number; onSinkBoundary?: (event: TraceEvent) => void } = {},
  ) {
    this.seq = options.startSeq ?? 0;
    this.onSinkBoundary = options.onSinkBoundary;
  }

  private readonly onSinkBoundary?: (event: TraceEvent) => void;

  runStart(task: string, modelSpec: string, fault?: string, capabilities?: readonly string[]): void {
    this.append({ type: "run_start", task, modelSpec, fault, capabilities });
  }

  onEvent = (event: AgentEvent): void => {
    this.append(event);
  };

  /** Harness-internal audit events (approval decisions, recovery actions, …). */
  record(payload: TraceEventPayload): void {
    this.append(payload);
  }

  /** seq of the last recorded event — checkpoint writers must lag this. */
  get lastSeq(): number {
    return this.seq;
  }

  runEnd(status: RunStatus, error: string | undefined, durationMs: number): void {
    const payload: RunLifecycleEvent =
      error === undefined ? { type: "run_end", status, durationMs } : { type: "run_end", status, error, durationMs };
    this.append(payload);
  }

  private append(payload: TraceEventPayload): void {
    const envelope: TraceEnvelope = {
      v: TRACE_SCHEMA_VERSION,
      seq: ++this.seq,
      ts: new Date().toISOString(),
      runId: this.runId,
    };
    // Envelope LAST: a payload field must never override the harness-owned
    // envelope (v/seq/ts/runId are the log's spine).
    const event = { ...payload, ...envelope } as TraceEvent;
    this.sinks.forEach((sink, index) => {
      if (index === 1 && this.onSinkBoundary) {
        try {
          this.onSinkBoundary(event);
        } catch (err) {
          process.stderr.write(`[trace] sink-boundary hook failed: ${err instanceof Error ? err.message : err}\n`);
        }
      }
      try {
        sink.append(event);
      } catch (err) {
        process.stderr.write(
          `[trace] sink ${sink.constructor.name} failed to persist seq ${event.seq}: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    });
  }
}
