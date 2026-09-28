import type { DatabaseSync } from "node:sqlite";
import type { PatternDraft, ReplaySafety } from "../../learning/miner.js";

type Row = Record<string, unknown>;

export interface PatternRow {
  id: string;
  kind: PatternDraft["kind"];
  signature: string;
  support: number;
  traceRefs: string[];
  replaySafety: ReplaySafety;
  createdAt: string;
}

function rowToPattern(r: Row): PatternRow {
  return {
    id: String(r.id),
    kind: String(r.kind) as PatternRow["kind"],
    signature: String(r.signature),
    support: Number(r.support),
    traceRefs: JSON.parse(String(r.trace_refs_json)) as string[],
    replaySafety: (r.replay_safety == null ? "unknown" : String(r.replay_safety)) as PatternRow["replaySafety"],
    createdAt: String(r.created_at),
  };
}

/**
 * Mined patterns (阶段 10) — a DERIVED projection of trace_events: `skill
 * mine` wipes and repopulates the whole table from the current traces. Pattern
 * ids are deterministic (signature hash), so candidate provenance survives
 * re-mining as long as a signature still clears the support threshold.
 */
export class PatternRepo {
  constructor(private readonly db: DatabaseSync) {}

  replaceAll(drafts: readonly PatternDraft[]): number {
    this.db.exec("DELETE FROM patterns");
    const insert = this.db.prepare(
      "INSERT INTO patterns (id, kind, signature, support, trace_refs_json, replay_safety, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const now = new Date().toISOString();
    for (const d of drafts)
      insert.run(d.id, d.kind, d.signature, d.support, JSON.stringify(d.traceRefs), d.replaySafety ?? "unknown", now);
    return drafts.length;
  }

  get(id: string): PatternRow | undefined {
    const row = this.db.prepare("SELECT * FROM patterns WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToPattern(row) : undefined;
  }

  list(): PatternRow[] {
    const rows = this.db.prepare("SELECT * FROM patterns ORDER BY support DESC, signature").all() as Row[];
    return rows.map(rowToPattern);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM patterns").get() as Row;
    return Number(row.n);
  }
}
