import type { DatabaseSync } from "node:sqlite";
import type { PersistedWatermark } from "../../context/reducers/conversation.js";

type Row = Record<string, unknown>;

/**
 * 加固期第四轮: durable summary watermarks (migration 014). The transformer's
 * in-memory watermark dies with the process; its serializable core is saved on
 * every advance and restored by resume — refs / tool-call ids / cut index are
 * rebuilt from the transcript (identity does not survive a process). Rows of
 * finished runs are reclaimed by prune, like checkpoints; interrupted runs
 * keep theirs (they are the resume input).
 */
export class ContextWatermarkRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(runId: string, watermark: PersistedWatermark): void {
    this.db
      .prepare(
        `INSERT INTO context_watermarks (run_id, watermark_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET watermark_json = excluded.watermark_json, updated_at = excluded.updated_at`,
      )
      .run(runId, JSON.stringify(watermark), new Date().toISOString());
  }

  /** undefined on missing row, malformed JSON, or a shape that cannot be a
   * watermark — the caller then starts a fresh watermark (never throws). */
  get(runId: string): PersistedWatermark | undefined {
    const row = this.db.prepare("SELECT watermark_json FROM context_watermarks WHERE run_id = ?").get(runId) as
      Row | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(String(row.watermark_json)) as Partial<PersistedWatermark>;
      if (typeof parsed.coveredCount !== "number" || typeof parsed.summary !== "object" || parsed.summary === null) {
        return undefined;
      }
      return { coveredCount: parsed.coveredCount, summary: parsed.summary as PersistedWatermark["summary"] };
    } catch {
      return undefined;
    }
  }
}
