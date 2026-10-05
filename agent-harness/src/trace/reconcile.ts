import fs from "node:fs";
import { HarnessError } from "../errors.js";
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
 *
 * 加固期修复 (P1): a parse failure (partial final line, real line damage) used
 * to short-circuit into a full rebuild from SQLite BEFORE the backfill ran —
 * the compound failure "SQLite has a hole AND the process died mid JSONL
 * append" then destroyed the hole's event from both stores forever (worst
 * case: an assistant toolCall's message_end vanishes while its
 * tool_execution_start survives, and the in-flight call silently evaporates
 * on recovery). Parse failures now only drop the damaged lines; every
 * parseable event still reaches the backfill. And when SQLite is empty while
 * the JSONL holds complete events, reconcile refuses outright — the ledger
 * may be partially lost and truncating would destroy the only audit copy.
 */

export interface ReconcileResult {
  /** Extra JSONL tail events dropped (the kill-between-sinks window), plus damaged lines. */
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
  // Parse every line we can; a failure is a kill-mid-append (partial final
  // line) or real line damage. Either way the PARSEABLE events survive into
  // the backfill below — only the damaged lines themselves are dropped.
  const events: TraceEvent[] = [];
  let droppedLines = 0;
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      droppedLines++;
    }
  }

  // SQLite empty + JSONL holding complete events = the ledger was partially
  // lost (the runs row survived, trace_events did not). Refuse: reconciling
  // here would irreversibly destroy the only audit copy before recovery even
  // starts. (A lone unparseable line with SQLite empty is the
  // crash-before-first-sink case — nothing parseable to lose, truncation below.)
  if (sqliteEvents.length === 0 && events.length > 0) {
    throw new HarnessError(
      `refusing to reconcile ${jsonlPath}: SQLite holds no events for this run but the JSONL has ` +
        `${events.length} complete event(s) — the ledger may be partially lost; recover it manually before resuming ` +
        `(if you are certain this was a crash before the first event reached SQLite, clearing the JSONL by hand unblocks the resume)`,
    );
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
  const truncated = events.length - keep.length + droppedLines;
  if (truncated === 0 && keep.length >= sqliteEvents.length) {
    return { truncated: 0, rebuilt: false, backfilled }; // JSONL aligned or ahead-and-continuous
  }
  // Rewrite as the seq-ordered UNION of both stores: SQLite is authoritative
  // for the seqs it holds (JSONL never overrides them), JSONL supplies any
  // holes, and everything past SQLite's max is dropped (the kill-between-sinks
  // tail whose unresolved calls recovery re-derives).
  const merged = new Map<number, TraceEvent>();
  for (const e of sqliteEvents) merged.set(e.seq, e);
  for (const e of keep) {
    if (typeof e.seq === "number" && !merged.has(e.seq)) merged.set(e.seq, e);
  }
  writeAll([...merged.values()].sort((a, b) => a.seq - b.seq));
  return { truncated, rebuilt: truncated === 0, backfilled };
}
