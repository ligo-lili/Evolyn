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
 *
 * 加固期复核: with sink failures no longer killing the run (the recorder
 * isolates a failing sink), a MID-LOG hole in SQLite became possible — the
 * JSONL event exists but recovery (SQLite-authoritative) would silently miss
 * it, e.g. a toolResult whose tool call then re-executes on resume. Since the
 * seq is shared, a JSONL event strictly BELOW SQLite's max that SQLite lacks
 * is exactly the event the SQLite sink failed to persist → backfill it. The
 * TAIL (seq > max) stays truncated: that is the kill-between-sinks window
 * whose unresolved calls recovery must re-derive (Demo 1 semantics).
 */

export interface ReconcileResult {
  /** Extra JSONL tail events dropped (the kill-between-sinks window). */
  truncated: number;
  /** True when the JSONL was missing events and was rebuilt from SQLite. */
  rebuilt: boolean;
  /** JSONL events backfilled INTO SQLite (mid-log holes, 加固期复核). */
  backfilled: number;
}

export function reconcileJsonlTrace(
  jsonlPath: string,
  sqliteEvents: readonly TraceEvent[],
  backfill?: (event: TraceEvent) => void,
): ReconcileResult {
  const writeAll = (events: readonly TraceEvent[]): void => {
    fs.writeFileSync(jsonlPath, events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""), "utf8");
  };

  const maxSqliteSeq = sqliteEvents.at(-1)?.seq ?? 0;

  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    if (sqliteEvents.length === 0) return { truncated: 0, rebuilt: false, backfilled: 0 };
    writeAll(sqliteEvents);
    return { truncated: 0, rebuilt: true, backfilled: 0 };
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
      return { truncated: events.length, rebuilt: true, backfilled: 0 };
    }
  }

  // Mid-log holes: JSONL events below SQLite's max that SQLite lacks — the
  // SQLite sink failed on exactly those; the JSONL copy is authoritative.
  let backfilled = 0;
  if (backfill) {
    const known = new Set(sqliteEvents.map((e) => e.seq));
    for (const event of events) {
      if (typeof event.seq === "number" && event.seq < maxSqliteSeq && !known.has(event.seq)) {
        backfill(event);
        known.add(event.seq);
        backfilled++;
      }
    }
  }

  const keep = events.filter((e) => typeof e.seq === "number" && e.seq <= maxSqliteSeq);
  if (keep.length === events.length && keep.length >= sqliteEvents.length) {
    return { truncated: 0, rebuilt: false, backfilled }; // JSONL aligned or ahead-and-continuous
  }
  if (keep.length < events.length) {
    // Extra tail (or mid-file seq drift) — drop everything past SQLite's seq.
    writeAll(keep);
    return { truncated: events.length - keep.length, rebuilt: false, backfilled };
  }
  // JSONL is short (its own sink failed) — rebuild it from SQLite (which now
  // includes any backfilled events).
  writeAll(sqliteEvents);
  return { truncated: 0, rebuilt: true, backfilled };
}
