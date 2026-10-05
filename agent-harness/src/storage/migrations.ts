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
  {
    // Experience memory (阶段 9). English fields feed the FTS5 index (default
    // tokenizer); summary_zh is the display-facing rendering (bilingual policy).
    // Since 阶段 9.5 these tables are a DERIVED, rebuildable index of the
    // authoritative Markdown files under .harness/memory/.
    id: 3,
    name: "experience-memory",
    sql: `
      CREATE TABLE experiences (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_type TEXT NOT NULL,
        summary_en TEXT NOT NULL,
        summary_zh TEXT NOT NULL,
        approach TEXT NOT NULL,
        pitfalls TEXT NOT NULL,
        outcome TEXT NOT NULL,
        keywords_en TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE experiences_fts USING fts5(
        exp_id UNINDEXED,
        summary_en,
        approach,
        pitfalls,
        keywords_en
      );
    `,
  },
  {
    // Memory v2 (阶段 9.5): SQLite rows are a DERIVED, rebuildable index of the
    // authoritative Markdown files under .harness/memory/. `memory rebuild`
    // repopulates everything from the .md files.
    id: 4,
    name: "memory-index-v2",
    sql: `
      ALTER TABLE experiences ADD COLUMN confirmations INTEGER DEFAULT 0;
      ALTER TABLE experiences ADD COLUMN updated TEXT;
    `,
  },
  {
    // 阶段 9.6: vector recall as another rebuildable projection. Float32 blobs;
    // populated by `memory rebuild --vector` with the local embedding model.
    id: 5,
    name: "memory-vectors",
    sql: `
      CREATE TABLE memory_vectors (
        exp_id TEXT PRIMARY KEY REFERENCES experiences(id),
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL
      );
    `,
  },
  {
    // 阶段 10 Skill 闭环 v1. patterns are a DERIVED projection of trace_events
    // (`skill mine` recomputes them; ids are deterministic signatures so
    // candidate provenance survives re-mining). skill_candidates and skills
    // hold the draft→promoted pipeline; skills_fts is the retrieval index over
    // promoted SKILL.md files (rebuildable via `skill rebuild`).
    id: 6,
    name: "skill-learning-v1",
    sql: `
      CREATE TABLE patterns (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('tool-sequence', 'error-repair')),
        signature TEXT NOT NULL,
        support INTEGER NOT NULL,
        trace_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_patterns_kind_sig ON patterns(kind, signature);

      CREATE TABLE skill_candidates (
        id TEXT PRIMARY KEY,
        pattern_id TEXT NOT NULL REFERENCES patterns(id),
        status TEXT NOT NULL CHECK (status IN ('draft', 'promoted', 'rejected')),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        skill_md_path TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_candidates_pattern ON skill_candidates(pattern_id);

      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL DEFAULT 1,
        dir_path TEXT NOT NULL,
        source_candidate_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        promoted_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE skills_fts USING fts5(
        skill_id UNINDEXED,
        name,
        description,
        body
      );
    `,
  },
  {
    // 阶段 11: eval framework formalization. skill_evals persists every A/B
    // report (verdict included) so skill iterations can be compared over time;
    // eval_baselines stores no-skill reference arms per (eval set, model) so a
    // regression check can run against a recorded baseline instead of re-running it.
    id: 7,
    name: "eval-persistence",
    sql: `
      CREATE TABLE skill_evals (
        id TEXT PRIMARY KEY,
        skill_name TEXT NOT NULL,
        source_candidate_id TEXT,
        eval_set TEXT NOT NULL,
        repeats INTEGER NOT NULL,
        baseline_pass REAL NOT NULL,
        candidate_pass REAL NOT NULL,
        cost_json TEXT NOT NULL,
        report_json TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('candidate-wins', 'baseline-wins', 'tie')),
        decided_at TEXT NOT NULL
      );
      CREATE INDEX idx_skill_evals_set ON skill_evals(eval_set);

      CREATE TABLE eval_baselines (
        id TEXT PRIMARY KEY,
        eval_set TEXT NOT NULL,
        model_spec TEXT NOT NULL,
        repeats INTEGER NOT NULL,
        arm_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX idx_eval_baselines_set_model ON eval_baselines(eval_set, model_spec);
    `,
  },
  {
    // 阶段 12: pattern-aware tool idempotency — whether a pattern's tool
    // sequence contains replay:"never" tools (auto-retry/re-execution hazards).
    // "unknown" when mined without a tool replay map.
    id: 8,
    name: "patterns-replay-safety",
    sql: `ALTER TABLE patterns ADD COLUMN replay_safety TEXT;`,
  },
  {
    // 阶段 12 lesson: skill_candidates.pattern_id carried an FK into the
    // patterns table, but patterns is a REBUILDABLE projection — re-mining
    // (DELETE FROM patterns) fails once any candidate references it. The
    // candidate's provenance_json already snapshots the full pattern, so the
    // FK is over-constrained; rebuild the table without it.
    id: 9,
    name: "candidates-drop-pattern-fk",
    sql: `
      CREATE TABLE skill_candidates_new (
        id TEXT PRIMARY KEY,
        pattern_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'promoted', 'rejected')),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        skill_md_path TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO skill_candidates_new (id, pattern_id, status, name, description, skill_md_path, provenance_json, created_at)
        SELECT id, pattern_id, status, name, description, skill_md_path, provenance_json, created_at FROM skill_candidates;
      DROP TABLE skill_candidates;
      ALTER TABLE skill_candidates_new RENAME TO skill_candidates;
      CREATE INDEX idx_candidates_pattern ON skill_candidates(pattern_id);
    `,
  },
  {
    // 阶段 14: the toolset is part of the eval protocol — a demo-toolset
    // baseline and a coding-toolset eval are different protocols and must not
    // be compared.
    id: 10,
    name: "baselines-toolset",
    sql: `ALTER TABLE eval_baselines ADD COLUMN toolset TEXT;`,
  },
  {
    // 阶段 14: the pinned protocol sha (protocol.json) — baselines are only
    // comparable to evals sharing the same sha.
    id: 11,
    name: "baselines-protocol-sha",
    sql: `ALTER TABLE eval_baselines ADD COLUMN protocol_sha256 TEXT;`,
  },
  {
    // The toolset is part of a run's identity: resume must rebuild the SAME
    // toolset, or every unresolved coding-tool call degrades to "not registered
    // in this session" and the run limps on with mismatched tools. Nullable —
    // runs seeded with explicit tool arrays cannot be persisted; NULL falls
    // back to the demo default on resume.
    id: 12,
    name: "runs-toolset",
    sql: `ALTER TABLE runs ADD COLUMN toolset TEXT;`,
  },
  {
    // Memory search v3: chunk-level index with content
    // identity (text_sha256) + revision + embedding provenance, a search_meta
    // registry (schema version + FTS tokenizer; structural mismatch drops and
    // rebuilds the projections), and memory_access — the audit trail backing
    // the UPDATE authorization whitelist (only ids the model actually READ
    // this run may be updated by the reflector). The v1/v2 experiences
    // projections are superseded and dropped — they were rebuildable by
    // design, and the .harness/memory Markdown files remain the authority.
    // memory_fts is created with the default tokenizer; the search layer
    // probes trigram support at runtime and recreates it when available.
    id: 13,
    name: "memory-search-v3",
    sql: `
      DROP TABLE IF EXISTS memory_vectors;
      DROP TABLE IF EXISTS experiences_fts;
      DROP TABLE IF EXISTS experiences;

      CREATE TABLE memory_chunks (
        memory_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        text_sha256 TEXT NOT NULL,
        revision INTEGER NOT NULL,
        embedding_model TEXT,
        embedding_dim INTEGER,
        vec BLOB,
        PRIMARY KEY (memory_id, chunk_index)
      );
      CREATE INDEX idx_chunks_memory ON memory_chunks(memory_id);

      CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, chunk_index UNINDEXED, text);

      CREATE TABLE search_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE memory_access (
        run_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        PRIMARY KEY (run_id, memory_id)
      );
    `,
  },
  {
    // 加固期第四轮: the summary watermark's serializable core, so a resumed
    // run continues its rolling summary instead of re-summarizing the
    // pre-crash prefix (cost) and re-rendering a different summary message
    // (prefix bytes → prompt cache). One row per run; reclaimed by prune for
    // finished runs, like checkpoints.
    id: 14,
    name: "context-watermarks",
    sql: `
      CREATE TABLE context_watermarks (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        watermark_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
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
