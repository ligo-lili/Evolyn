import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

export type CandidateStatus = "draft" | "promoted" | "rejected";

/** Where the draft came from: the pattern plus every run that supports it. */
export interface CandidateProvenance {
  patternId: string;
  patternKind: string;
  patternSignature: string;
  support: number;
  runIds: string[];
  model: string;
  /** "llm" (structured distillation) or "fallback" (mechanical draft). */
  method: "llm" | "fallback";
  distilledAt: string;
}

export interface SkillCandidateRow {
  id: string;
  patternId: string;
  status: CandidateStatus;
  name: string;
  description: string;
  /** Absolute path of the draft SKILL.md on disk. */
  skillMdPath: string;
  provenance: CandidateProvenance;
  createdAt: string;
}

function rowToCandidate(r: Row): SkillCandidateRow {
  return {
    id: String(r.id),
    patternId: String(r.pattern_id),
    status: String(r.status) as CandidateStatus,
    name: String(r.name),
    description: String(r.description),
    skillMdPath: String(r.skill_md_path),
    provenance: JSON.parse(String(r.provenance_json)) as CandidateProvenance,
    createdAt: String(r.created_at),
  };
}

/** Draft skills distilled from patterns (阶段 10). A candidate is promoted at
 * most once; the promoted skill links back via source_candidate_id. */
export class SkillCandidateRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: SkillCandidateRow): void {
    this.db
      .prepare(
        "INSERT INTO skill_candidates (id, pattern_id, status, name, description, skill_md_path, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        row.patternId,
        row.status,
        row.name,
        row.description,
        row.skillMdPath,
        JSON.stringify(row.provenance),
        row.createdAt,
      );
  }

  get(id: string): SkillCandidateRow | undefined {
    const row = this.db.prepare("SELECT * FROM skill_candidates WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToCandidate(row) : undefined;
  }

  list(): SkillCandidateRow[] {
    const rows = this.db.prepare("SELECT * FROM skill_candidates ORDER BY created_at DESC").all() as Row[];
    return rows.map(rowToCandidate);
  }

  setStatus(id: string, status: CandidateStatus): void {
    this.db.prepare("UPDATE skill_candidates SET status = ? WHERE id = ?").run(status, id);
  }
}
