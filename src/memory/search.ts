import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, rrfCombine, type PassageEmbedder } from "./embedding.js";
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

/** The text a memory is embedded from — bilingual, all retrievable fields. */
export function passageText(record: MemoryRecord): string {
  return [record.summaryEn, record.summaryZh, record.approach, record.pitfalls, record.keywordsEn.join(" ")]
    .filter(Boolean)
    .join("\n");
}

/**
 * Derived, rebuildable search index over the authoritative Markdown memory
 * files (阶段 9.5). Two projections: FTS5 (lexical) and memory_vectors
 * (embeddings, 阶段 9.6) — both rebuilt from the .md files. searchHybrid fuses
 * the two rankings with Reciprocal Rank Fusion.
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
      .prepare(
        "INSERT INTO experiences_fts (exp_id, summary_en, approach, pitfalls, keywords_en) VALUES (?, ?, ?, ?, ?)",
      )
      .run(record.id, record.summaryEn, record.approach, record.pitfalls, record.keywordsEn.join(" "));
  }

  reset(): void {
    // 加固期 (P1) delete order: memory_vectors references experiences (FK),
    // so the vectors must go BEFORE the experience rows or the reset fails
    // with a foreign-key violation once vectors exist.
    this.db.exec("DELETE FROM experiences_fts");
    this.db.exec("DELETE FROM memory_vectors");
    this.db.exec("DELETE FROM experiences");
  }

  /** Wipe and repopulate the FTS index from the Markdown store. Returns record count. */
  rebuild(store: MemoryStore): number {
    this.reset();
    const records = store.list();
    for (const record of records) this.syncRecord(record);
    return records.length;
  }

  /** Wipe and re-embed every memory. Downloads the model on first use. */
  async rebuildVectors(store: MemoryStore, embedder: PassageEmbedder): Promise<number> {
    this.db.exec("DELETE FROM memory_vectors");
    const records = store.list();
    if (records.length === 0) return 0;
    const vectors = await embedder.embedPassages(records.map(passageText));
    const insert = this.db.prepare("INSERT OR REPLACE INTO memory_vectors (exp_id, dim, vec) VALUES (?, ?, ?)");
    records.forEach((record, i) => {
      const vec = vectors[i];
      if (!vec) return;
      insert.run(record.id, vec.length, Buffer.from(Float32Array.from(vec).buffer));
    });
    return records.length;
  }

  vectorCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM memory_vectors").get() as Row;
    return Number(row.n);
  }

  private ftsRanked(query: string, limit: number): Array<{ id: string; rank: number }> {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, "")}"`);
    if (terms.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT e.id FROM experiences_fts f JOIN experiences e ON e.id = f.exp_id
         WHERE experiences_fts MATCH ? ORDER BY bm25(experiences_fts) LIMIT ?`,
      )
      .all(terms.join(" OR "), limit) as Row[];
    return rows.map((r, i) => ({ id: String(r.id), rank: i + 1 }));
  }

  /** FTS5-only recall (OR semantics, bm25 ranking). */
  searchFts(query: string, limit = 3): MemoryRecord[] {
    const ids = this.ftsRanked(query, limit);
    return ids
      .map(({ id }) => {
        const row = this.db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as Row | undefined;
        return row ? rowToRecord(row) : undefined;
      })
      .filter((r): r is MemoryRecord => r !== undefined);
  }

  /**
   * 阶段 9.6 hybrid recall: FTS ranking fused with embedding cosine ranking
   * via RRF. Degrades gracefully to FTS-only when no vectors are built or the
   * embedder is omitted.
   */
  async searchHybrid(
    query: string,
    limit: number,
    embedder?: PassageEmbedder,
    opts: { pool?: number } = {},
  ): Promise<MemoryRecord[]> {
    const pool = opts.pool ?? Math.max(limit * 5, 25);
    const fts = this.ftsRanked(query, pool);
    let vectorRanking: Array<{ id: string; rank: number }> = [];
    if (embedder && this.vectorCount() > 0 && query.trim()) {
      const queryVector = await embedder.embedQuery(query);
      const rows = this.db.prepare("SELECT exp_id, vec, dim FROM memory_vectors").all() as Row[];
      const scored = rows
        .map((r) => {
          const dim = Number(r.dim);
          const blob = r.vec as Buffer;
          // Copy the byte range into a fresh, 4-byte-aligned ArrayBuffer.
          const aligned = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
          const vec = Array.from(new Float32Array(aligned)).slice(0, dim);
          return { id: String(r.exp_id), score: cosineSimilarity(queryVector, vec) };
        })
        .sort((a, b) => b.score - a.score);
      vectorRanking = scored.map((s, i) => ({ id: s.id, rank: i + 1 }));
    }
    const fused = vectorRanking.length > 0 ? rrfCombine([fts, vectorRanking]) : fts;
    return fused
      .slice(0, limit)
      .map(({ id }) => {
        const row = this.db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as Row | undefined;
        return row ? rowToRecord(row) : undefined;
      })
      .filter((r): r is MemoryRecord => r !== undefined);
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
