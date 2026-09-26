import type { DatabaseSync } from "node:sqlite";
import type { RunRecord, RunStatus } from "../../runtime/run-manager.js";

type Row = Record<string, unknown>;

function rowToRun(r: Row): RunRecord {
  return {
    id: String(r.id),
    task: String(r.task),
    modelSpec: String(r.model_spec),
    status: String(r.status) as RunStatus,
    startedAt: String(r.started_at),
    finishedAt: r.finished_at == null ? undefined : String(r.finished_at),
    error: r.error == null ? undefined : String(r.error),
    systemPrompt: r.system_prompt == null ? undefined : String(r.system_prompt),
  };
}

/** Run lifecycle rows — the system of record for 阶段 5's recovery scan. */
export class RunRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(record: RunRecord): void {
    this.db
      .prepare("INSERT INTO runs (id, task, model_spec, status, started_at, system_prompt, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, record.task, record.modelSpec, record.status, record.startedAt, record.systemPrompt ?? null, new Date().toISOString());
  }

  /** Full status sync from the in-memory record (status/finished_at/error). */
  updateStatus(record: RunRecord): void {
    this.db
      .prepare("UPDATE runs SET status = ?, finished_at = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(record.status, record.finishedAt ?? null, record.error ?? null, new Date().toISOString(), record.id);
  }

  get(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToRun(row) : undefined;
  }

  getByStatus(status: RunStatus): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE status = ? ORDER BY started_at").all(status) as Row[];
    return rows.map(rowToRun);
  }

  list(limit = 50): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(rowToRun);
  }
}
