import type { DatabaseSync } from "node:sqlite";
import type { TraceEvent } from "../../trace/schema.js";
import type { TraceSink } from "../../trace/recorder.js";

type Row = Record<string, unknown>;

/** Pull the queryable columns (tool name / error) out of an event payload. */
function extractToolInfo(event: TraceEvent): { toolName: string | null; isError: number | null } {
  if (event.type === "tool_execution_start") return { toolName: event.toolName, isError: null };
  if (event.type === "tool_execution_end") return { toolName: event.toolName, isError: event.isError ? 1 : 0 };
  if (event.type === "message_end") {
    const m = event.message;
    if (m.role === "toolResult") return { toolName: m.toolName, isError: m.isError ? 1 : 0 };
    return { toolName: null, isError: null };
  }
  return { toolName: null, isError: null };
}

/**
 * SQLite mirror of the JSONL trace. The full event JSON is stored verbatim
 * (envelope included) so a run's event log can be reconstructed exactly;
 * tool_name/is_error are extracted columns for indexed queries.
 */
export class TraceEventRepo implements TraceSink {
  constructor(private readonly db: DatabaseSync) {}

  append(event: TraceEvent): void {
    const { toolName, isError } = extractToolInfo(event);
    this.db
      .prepare(
        "INSERT INTO trace_events (run_id, seq, ts, type, schema_version, tool_name, is_error, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(event.runId, event.seq, event.ts, event.type, event.v, toolName, isError, JSON.stringify(event));
  }

  getByRun(runId: string): TraceEvent[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM trace_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Row[];
    return rows.map((r) => JSON.parse(String(r.payload_json)) as TraceEvent);
  }

  queryToolCalls(toolName: string, runId?: string): TraceEvent[] {
    const rows =
      runId === undefined
        ? (this.db
            .prepare("SELECT payload_json FROM trace_events WHERE tool_name = ? ORDER BY run_id, seq")
            .all(toolName) as Row[])
        : (this.db
            .prepare("SELECT payload_json FROM trace_events WHERE tool_name = ? AND run_id = ? ORDER BY seq")
            .all(toolName, runId) as Row[]);
    return rows.map((r) => JSON.parse(String(r.payload_json)) as TraceEvent);
  }

  queryErrors(runId?: string): TraceEvent[] {
    const rows =
      runId === undefined
        ? (this.db
            .prepare("SELECT payload_json FROM trace_events WHERE is_error = 1 ORDER BY run_id, seq")
            .all() as Row[])
        : (this.db
            .prepare("SELECT payload_json FROM trace_events WHERE is_error = 1 AND run_id = ? ORDER BY seq")
            .all(runId) as Row[]);
    return rows.map((r) => JSON.parse(String(r.payload_json)) as TraceEvent);
  }

  countByRun(runId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM trace_events WHERE run_id = ?").get(runId) as Row;
    return Number(row.n);
  }
}
