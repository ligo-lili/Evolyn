import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RunStatus } from "../runtime/run-manager.js";

/**
 * Trace schema: a run's full execution log. Envelope fields ride on every
 * event; the payload is either a lifecycle event or a verbatim pi AgentEvent,
 * so event names stay aligned with the runtime we wrap.
 * Bump TRACE_SCHEMA_VERSION on any breaking payload change.
 */
export const TRACE_SCHEMA_VERSION = 1;

export interface TraceEnvelope {
  v: number;
  /** 1-based, strictly increasing, per run; gaps mean the log was tampered with. */
  seq: number;
  /** ISO timestamp of when the event was recorded. */
  ts: string;
  runId: string;
}

export type RunLifecycleEvent =
  | { type: "run_start"; task: string; modelSpec: string; fault?: string }
  | { type: "run_end"; status: RunStatus; error?: string; durationMs: number };

/**
 * Harness-originated audit events (not pi AgentEvents): decisions and actions
 * the harness itself takes around the agent loop.
 */
export type HarnessAuditEvent =
  | { type: "approval"; toolName: string; decision: "allow" | "deny"; reason?: string }
  | { type: "recovery_action"; toolCallId: string; toolName: string; action: "reexecute" | "rebuild_result" | "synthesize_error"; error?: string }
  | { type: "compaction"; trigger: "threshold" | "rolling"; tokensBefore: number; summaryChars: number; cutIndex: number };

export type TraceEventPayload = AgentEvent | RunLifecycleEvent | HarnessAuditEvent;

export type TraceEvent = TraceEnvelope & TraceEventPayload;
