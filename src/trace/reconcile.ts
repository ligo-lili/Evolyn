import fs from "node:fs";
import type { TraceEvent } from "./schema.js";

/**
 * 阶段 13 (P1-2): the two trace sinks append per event — JSONL first, SQLite
 * second. A kill between the two appends leaves JSONL with a tail SQLite
 * never saw; resume trusts SQLite and continues its seq, so appending to the
 * un-truncated JSONL would duplicate seqs and permanently fail readTraceFile.
 * Reconcile BEFORE resuming: SQLite (the recovery authority) defines the
 * truth, the JSONL is truncated or rebuilt to match, and every adjustment is
 * reported to the caller for a stderr warning.
 */

export interface ReconcileResult {
  /** Extra JSONL tail events dropped (the kill-between-sinks window). */
  truncated: number;
  /** True when the JSONL was missing events and was rebuilt from SQLite. */
  rebuilt: boolean;
}

export function reconcileJsonlTrace(jsonlPath: string, sqliteEvents: readonly TraceEvent[]): ReconcileResult {
  const writeAll = (events: readonly TraceEvent[]): void => {
    fs.writeFileSync(jsonlPath, events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""), "utf8");
  };

  const maxSqliteSeq = sqliteEvents.at(-1)?.seq ?? 0;

  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    if (sqliteEvents.length === 0) return { truncated: 0, rebuilt: false };
    writeAll(sqliteEvents);
    return { truncated: 0, rebuilt: true };
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const events: TraceEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // A partial final line means the process died mid-write — the file is
      // damaged beyond line-level surgery; rebuild from the authority.
      writeAll(sqliteEvents);
      return { truncated: events.length, rebuilt: true };
    }
  }

  const keep = events.filter((e) => typeof e.seq === "number" && e.seq <= maxSqliteSeq);
  if (keep.length === events.length && keep.length >= sqliteEvents.length) {
    return { truncated: 0, rebuilt: false }; // JSONL aligned or ahead-and-continuous — nothing to do
  }
  if (keep.length < events.length) {
    // Extra tail (or mid-file seq drift) — drop everything past SQLite's seq.
    writeAll(keep);
    return { truncated: events.length - keep.length, rebuilt: false };
  }
  // JSONL is short (defensive: SQLite must never be behind) — rebuild it.
  writeAll(sqliteEvents);
  return { truncated: 0, rebuilt: true };
}
