import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * 加固期 (P2) data retention. The durable record grows without bound:
 * checkpoints, per-run evidence directories and per-run JSONL traces
 * accumulate forever. The retention decision:
 *   - CHECKPOINTS for FINISHED runs are dead weight — recovery only ever
 *     scans status=running rows — so they are pruned for every finished run.
 *     Interrupted runs keep theirs (they are the resume input).
 *   - TRACES (JSONL) and EVIDENCE are the audit/story record — kept for the
 *     newest `keepRuns` runs, pruned for older finished ones.
 *   - trace_events ROWS are the queryable ledger: kept unless `deep: true`,
 *     which also frees the file space via VACUUM.
 * Runs rows themselves are never pruned — they are the index of what happened.
 */

export interface PrunePlan {
  keepRuns: number;
  /** Finished runs beyond the keep window — trace/evidence candidates. */
  beyond: Array<{ runId: string; status: string }>;
  /** Checkpoint rows that would be deleted (all finished runs). */
  checkpointRows: number;
  checkpointRuns: number;
  /** 加固期第四轮: context watermark rows of finished runs (same lifecycle as checkpoints). */
  watermarkRows: number;
  deep: boolean;
}

export function planPrune(db: DatabaseSync, options: { keepRuns?: number; deep?: boolean } = {}): PrunePlan {
  // Library-side guard, layered under the CLI's --keep-runs validation: NaN
  // would poison slice() below (slice(NaN) keeps nothing) and delete the
  // traces of EVERY finished run — fall back to the default window instead.
  const raw = options.keepRuns ?? 20;
  const keepRuns = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 20;
  const rows = db.prepare("SELECT id, status FROM runs ORDER BY started_at DESC, rowid DESC").all() as Array<{
    id: string;
    status: string;
  }>;
  const finished = rows.filter((r) => r.status !== "running");
  const beyond = finished.slice(keepRuns).map((r) => ({ runId: r.id, status: r.status }));
  const checkpointRow = db
    .prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE run_id IN (SELECT id FROM runs WHERE status != 'running')")
    .get() as { n: number };
  const watermarkRow = db
    .prepare(
      "SELECT COUNT(*) AS n FROM context_watermarks WHERE run_id IN (SELECT id FROM runs WHERE status != 'running')",
    )
    .get() as { n: number };
  return {
    keepRuns,
    beyond,
    checkpointRows: Number(checkpointRow.n),
    checkpointRuns: finished.length,
    watermarkRows: Number(watermarkRow.n),
    deep: options.deep ?? false,
  };
}

export interface PruneResult {
  checkpointsDeleted: number;
  watermarksDeleted: number;
  tracesDeleted: number;
  evidenceDeleted: number;
  eventRowsDeleted: number;
  bytesFreed: number;
}

function diskUsage(p: string): number {
  try {
    const stat = fs.statSync(p);
    if (stat.isFile()) return stat.size;
    let total = 0;
    for (const entry of fs.readdirSync(p)) total += diskUsage(path.join(p, entry));
    return total;
  } catch {
    return 0;
  }
}

function rmrf(p: string): number {
  const bytes = diskUsage(p);
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return bytes;
  } catch {
    return 0;
  }
}

/** Execute a prune plan against the database and the on-disk trace/evidence trees. */
export function applyPrune(
  db: DatabaseSync,
  plan: PrunePlan,
  dirs: { tracesDir: string; evidenceDir: string },
): PruneResult {
  let bytesFreed = 0;
  let tracesDeleted = 0;
  let evidenceDeleted = 0;

  // 1. checkpoints of finished runs — dead weight by definition.
  const cpResult = db
    .prepare("DELETE FROM checkpoints WHERE run_id IN (SELECT id FROM runs WHERE status != 'running')")
    .run();
  const checkpointsDeleted = Number(cpResult.changes);
  // 1b. 加固期第四轮: context watermarks — same lifecycle (resume only reads
  // interrupted runs' records; a finished run never resumes again).
  const wmResult = db
    .prepare("DELETE FROM context_watermarks WHERE run_id IN (SELECT id FROM runs WHERE status != 'running')")
    .run();
  const watermarksDeleted = Number(wmResult.changes);

  // 2. traces + evidence beyond the keep window.
  for (const run of plan.beyond) {
    const tracePath = path.join(dirs.tracesDir, `${run.runId}.jsonl`);
    if (fs.existsSync(tracePath)) {
      bytesFreed += rmrf(tracePath);
      tracesDeleted++;
    }
    const evidencePath = path.join(dirs.evidenceDir, run.runId);
    if (fs.existsSync(evidencePath)) {
      bytesFreed += rmrf(evidencePath);
      evidenceDeleted++;
    }
  }

  // 3. deep: also drop the trace_events ledger rows for pruned runs, then
  //    give the space back to the filesystem.
  let eventRowsDeleted = 0;
  if (plan.deep && plan.beyond.length > 0) {
    const ids = plan.beyond.map((r) => r.runId);
    const result = db.prepare(`DELETE FROM trace_events WHERE run_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    eventRowsDeleted = Number(result.changes);
    db.exec("VACUUM");
  }

  return { checkpointsDeleted, watermarksDeleted, tracesDeleted, evidenceDeleted, eventRowsDeleted, bytesFreed };
}
