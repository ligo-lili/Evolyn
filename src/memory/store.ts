import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface ExperienceRecord {
  id: string;
  runId: string;
  taskType: string;
  summaryEn: string;
  summaryZh: string;
  approach: string;
  pitfalls: string;
  outcome: string;
  keywordsEn: string;
  model?: string;
  createdAt: string;
}

type Row = Record<string, unknown>;

function rowToExperience(r: Row): ExperienceRecord {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    taskType: String(r.task_type),
    summaryEn: String(r.summary_en),
    summaryZh: String(r.summary_zh),
    approach: String(r.approach),
    pitfalls: String(r.pitfalls),
    outcome: String(r.outcome),
    keywordsEn: String(r.keywords_en),
    model: r.model == null ? undefined : String(r.model),
    createdAt: String(r.created_at),
  };
}

/**
 * Experience memory over SQLite + FTS5. Search queries run against the English
 * fields (default tokenizer); each hit ranks by bm25 and carries the Chinese
 * summary for display.
 */
export class ExperienceRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(record: ExperienceRecord): void {
    this.db
      .prepare(
        "INSERT INTO experiences (id, run_id, task_type, summary_en, summary_zh, approach, pitfalls, outcome, keywords_en, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.runId,
        record.taskType,
        record.summaryEn,
        record.summaryZh,
        record.approach,
        record.pitfalls,
        record.outcome,
        record.keywordsEn,
        record.model ?? null,
        record.createdAt,
      );
    this.db
      .prepare("INSERT INTO experiences_fts (exp_id, summary_en, approach, pitfalls, keywords_en) VALUES (?, ?, ?, ?, ?)")
      .run(record.id, record.summaryEn, record.approach, record.pitfalls, record.keywordsEn);
  }

  /** FTS5 MATCH with quoted terms; empty queries return nothing rather than everything. */
  search(query: string, limit = 3): ExperienceRecord[] {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, "")}"`);
    if (terms.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT e.* FROM experiences_fts f JOIN experiences e ON e.id = f.exp_id
         WHERE experiences_fts MATCH ? ORDER BY bm25(experiences_fts) LIMIT ?`,
      )
      .all(terms.join(" "), limit) as Row[];
    return rows.map(rowToExperience);
  }

  get(id: string): ExperienceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToExperience(row) : undefined;
  }

  listRecent(limit = 20): ExperienceRecord[] {
    const rows = this.db.prepare("SELECT * FROM experiences ORDER BY created_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(rowToExperience);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM experiences").get() as Row;
    return Number(row.n);
  }
}

export function newExperienceId(): string {
  return randomUUID();
}
