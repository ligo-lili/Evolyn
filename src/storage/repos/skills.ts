import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

export interface SkillRow {
  id: string;
  name: string;
  version: number;
  /** Absolute path of the promoted skill directory (contains SKILL.md). */
  dirPath: string;
  sourceCandidateId?: string;
  status: string;
  promotedAt: string;
}

function rowToSkill(r: Row): SkillRow {
  return {
    id: String(r.id),
    name: String(r.name),
    version: Number(r.version),
    dirPath: String(r.dir_path),
    sourceCandidateId: r.source_candidate_id == null ? undefined : String(r.source_candidate_id),
    status: String(r.status),
    promotedAt: String(r.promoted_at),
  };
}

/**
 * Registry of promoted skills (阶段 10). The SKILL.md files on disk are the
 * authority; this table (plus skills_fts, see skills/retrieve.ts) is the
 * derived, rebuildable index.
 */
export class SkillRegistry {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert or bump a skill. Re-promoting an existing name raises its version. */
  upsert(input: { name: string; dirPath: string; sourceCandidateId?: string }): SkillRow {
    const existing = this.getByName(input.name);
    const row: SkillRow = {
      id: existing?.id ?? randomUUID(),
      name: input.name,
      version: (existing?.version ?? 0) + 1,
      dirPath: input.dirPath,
      sourceCandidateId: input.sourceCandidateId ?? existing?.sourceCandidateId,
      status: "active",
      promotedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO skills (id, name, version, dir_path, source_candidate_id, status, promoted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.name, row.version, row.dirPath, row.sourceCandidateId ?? null, row.status, row.promotedAt);
    return row;
  }

  replaceAll(rows: readonly SkillRow[]): void {
    this.db.exec("DELETE FROM skills");
    const insert = this.db.prepare(
      "INSERT INTO skills (id, name, version, dir_path, source_candidate_id, status, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) insert.run(r.id, r.name, r.version, r.dirPath, r.sourceCandidateId ?? null, r.status, r.promotedAt);
  }

  getByName(name: string): SkillRow | undefined {
    const row = this.db.prepare("SELECT * FROM skills WHERE name = ?").get(name) as Row | undefined;
    return row ? rowToSkill(row) : undefined;
  }

  list(): SkillRow[] {
    const rows = this.db.prepare("SELECT * FROM skills ORDER BY promoted_at DESC").all() as Row[];
    return rows.map(rowToSkill);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM skills").get() as Row;
    return Number(row.n);
  }
}
