import type { DatabaseSync } from "node:sqlite";

interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Forward-only migrations. 001 = core runtime tables; learning/memory tables
 * (experiences, patterns, skills, …) get their own migrations when those
 * stages land, per incremental migration discipline.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "core-runtime-tables",
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        model_spec TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_runs_status ON runs(status);

      CREATE TABLE trace_events (
        run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        tool_name TEXT,
        is_error INTEGER,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX idx_trace_events_tool ON trace_events(tool_name);
      CREATE INDEX idx_trace_events_error ON trace_events(is_error) WHERE is_error = 1;

      CREATE TABLE checkpoints (
        run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
    `,
  },
  {
    // The agent loop never emits an event for the synthesized system message,
    // so recovery cannot rebuild it from the trace — persist it on the run row.
    id: 2,
    name: "runs-system-prompt",
    sql: `ALTER TABLE runs ADD COLUMN system_prompt TEXT;`,
  },
];

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: unknown }>;
  const applied = new Set(appliedRows.map((r) => Number(r.id)));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
