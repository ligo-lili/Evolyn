import type { DatabaseSync } from "node:sqlite";
import type { MemoryRecord } from "./model.js";
import type { MemoryStore } from "./store.js";

type Row = Record<string, unknown>;

function rowToRecord(r: Row): MemoryRecord {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    taskType: String(r.task_type),
    outcome: String(r.outcome) as MemoryRecord["outcome"],
    summaryEn: String(r.summary_en),
    summaryZh: String(r.summary_zh),
    approach: String(r.approach),
    pitfalls: String(r.pitfalls),
    keywordsEn: String(r.keywords_en).split(/\s+/).filter(Boolean),
    confirmations: Number(r.confirmations ?? 0),
    model: r.model == null ? undefined : String(r.model),
    created: String(r.created_at),
    updated: r.updated == null ? String(r.created_at) : String(r.updated),
  };
}

/**
 * Derived, rebuildable search index over the authoritative Markdown memory
 * files (阶段 9.5). FTS5 today; hybrid vector + RRF lands in 9.6 as another
 * rebuildable projection. If the index is lost or stale, `memory rebuild`
 * repopulates it from the files.
 */
export class MemorySearchIndex {
  constructor(private readonly db: DatabaseSync) {}

  /** Upsert one record's index rows (call after every MemoryStore.save). */
  syncRecord(record: MemoryRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO experiences
         (id, run_id, task_type, summary_en, summary_zh, approach, pitfalls, outcome, keywords_en, model, created_at, confirmations, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.keywordsEn.join(" "),
        record.model ?? null,
        record.created,
        record.confirmations,
        record.updated,
      );
    this.db.prepare("DELETE FROM experiences_fts WHERE exp_id = ?").run(record.id);
    this.db
      .prepare("INSERT INTO experiences_fts (exp_id, summary_en, approach, pitfalls, keywords_en) VALUES (?, ?, ?, ?, ?)")
      .run(record.id, record.summaryEn, record.approach, record.pitfalls, record.keywordsEn.join(" "));
  }

  reset(): void {
    this.db.exec("DELETE FROM experiences_fts");
    this.db.exec("DELETE FROM experiences");
  }

  /** Wipe and repopulate the index from the Markdown store. Returns record count. */
  rebuild(store: MemoryStore): number {
    this.reset();
    const records = store.list();
    for (const record of records) this.syncRecord(record);
    return records.length;
  }

  /**
   * FTS5 MATCH with quoted OR terms (recall-first: a partial keyword match
   * still surfaces the record; bm25 ranks fuller matches higher) + bm25
   * ordering; empty queries match nothing.
   */
  searchFts(query: string, limit = 3): MemoryRecord[] {
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
      .all(terms.join(" OR "), limit) as Row[];
    return rows.map(rowToRecord);
  }

  listRecent(limit = 20): MemoryRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM experiences ORDER BY COALESCE(updated, created_at) DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(rowToRecord);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM experiences").get() as Row;
    return Number(row.n);
  }
}
