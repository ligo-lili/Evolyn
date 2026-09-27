import { appendFileSync } from "node:fs";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RunStatus } from "../runtime/run-manager.js";
import { TRACE_SCHEMA_VERSION, type RunLifecycleEvent, type TraceEnvelope, type TraceEvent, type TraceEventPayload } from "./schema.js";

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
 */
export class TraceRecorder {
  private seq: number;

  constructor(
    readonly runId: string,
    private readonly sinks: TraceSink[],
    options: { startSeq?: number } = {},
  ) {
    this.seq = options.startSeq ?? 0;
  }

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
  };

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
    const event = { ...envelope, ...payload } as TraceEvent;
    for (const sink of this.sinks) sink.append(event);
  }
}
