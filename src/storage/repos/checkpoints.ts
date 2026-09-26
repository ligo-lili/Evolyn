import type { DatabaseSync } from "node:sqlite";

export interface CheckpointRow {
  runId: string;
  seq: number;
  kind: string;
  state: unknown;
  createdAt: string;
}

type Row = Record<string, unknown>;

/**
 * Durable checkpoint slots (written by 阶段 5). seq is per-run, assigned from
 * MAX(seq)+1 — safe under the single-writer contract.
 */
export class CheckpointRepo {
  constructor(private readonly db: DatabaseSync) {}

  append(runId: string, kind: string, state: unknown): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (run_id, seq, kind, state_json, created_at)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM checkpoints WHERE run_id = ?), ?, ?, ?)`,
      )
      .run(runId, runId, kind, JSON.stringify(state), new Date().toISOString());
  }

  latest(runId: string): CheckpointRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY seq DESC LIMIT 1")
      .get(runId) as Row | undefined;
    return row ? rowToCheckpoint(row) : undefined;
  }

  list(runId: string): CheckpointRow[] {
    const rows = this.db
      .prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY seq")
      .all(runId) as Row[];
    return rows.map(rowToCheckpoint);
  }
}

function rowToCheckpoint(r: Row): CheckpointRow {
  return {
    runId: String(r.run_id),
    seq: Number(r.seq),
    kind: String(r.kind),
    state: JSON.parse(String(r.state_json)),
    createdAt: String(r.created_at),
  };
}
