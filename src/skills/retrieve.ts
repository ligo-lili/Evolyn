import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseSkillMd } from "./format.js";
import { verifyPromotedSkills } from "./verify.js";
import type { SkillEntry } from "../context/assembler.js";
import { SkillCandidateRepo } from "../storage/repos/candidates.js";
import { SkillRegistry, type SkillRow } from "../storage/repos/skills.js";

type Row = Record<string, unknown>;

export interface SkillHit extends SkillRow {
  description: string;
  body: string;
}

function rowToHit(r: Row): SkillHit {
  return {
    id: String(r.id),
    name: String(r.name),
    version: Number(r.version),
    dirPath: String(r.dir_path),
    sourceCandidateId: r.source_candidate_id == null ? undefined : String(r.source_candidate_id),
    status: String(r.status),
    promotedAt: String(r.promoted_at),
    description: String(r.description),
    body: String(r.body),
  };
}

/**
 * Retrieval index over promoted skills (阶段 10): the promoted SKILL.md files
 * are the authority; the skills rows and this FTS index are derived and
 * rebuildable (`skill rebuild` rescans the promoted directory). Injection
 * mirrors pi's <available_skills> mechanism — the model sees name +
 * description + file location and reads the body on demand via read_file.
 */
export class SkillIndex {
  private readonly registry: SkillRegistry;

  constructor(private readonly db: DatabaseSync) {
    this.registry = new SkillRegistry(db);
  }

  /** Upsert the row and the FTS entry for one promoted skill. */
  syncSkill(input: {
    name: string;
    dirPath: string;
    sourceCandidateId?: string;
    description: string;
    body: string;
  }): SkillRow {
    const row = this.registry.upsert({
      name: input.name,
      dirPath: input.dirPath,
      sourceCandidateId: input.sourceCandidateId,
    });
    this.db.prepare("DELETE FROM skills_fts WHERE skill_id = ?").run(row.id);
    this.db
      .prepare("INSERT INTO skills_fts (skill_id, name, description, body) VALUES (?, ?, ?, ?)")
      .run(row.id, row.name, input.description, input.body);
    return row;
  }

  private fetchByIds(ids: readonly string[]): SkillHit[] {
    const hits: SkillHit[] = [];
    for (const id of ids) {
      const row = this.db
        .prepare(
          "SELECT s.*, f.description AS description, f.body AS body FROM skills s JOIN skills_fts f ON f.skill_id = s.id WHERE s.id = ?",
        )
        .get(id) as Row | undefined;
      if (row) hits.push(rowToHit(row));
    }
    return hits;
  }

  /** FTS recall with OR semantics (bm25 ranking) — same policy as memory. */
  search(query: string, limit = 2): SkillHit[] {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, "")}"`);
    if (terms.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT f.skill_id FROM skills_fts f JOIN skills s ON s.id = f.skill_id
         WHERE skills_fts MATCH ? ORDER BY bm25(skills_fts) LIMIT ?`,
      )
      .all(terms.join(" OR "), limit) as Row[];
    return this.fetchByIds(rows.map((r) => String(r.skill_id)));
  }

  /** Skills by exact name, in the order given — eval A/B and demo forcing. */
  getByName(names: readonly string[]): SkillHit[] {
    return this.fetchByIds(
      names.map((n) => this.registry.getByName(n)?.id).filter((id): id is string => id !== undefined),
    );
  }

  list(): SkillHit[] {
    const rows = this.db
      .prepare(
        "SELECT s.*, f.description AS description, f.body AS body FROM skills s JOIN skills_fts f ON f.skill_id = s.id ORDER BY s.name",
      )
      .all() as Row[];
    return rows.map(rowToHit);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM skills").get() as Row;
    return Number(row.n);
  }

  /**
   * Wipe and repopulate rows + FTS from the promoted directory (one subdir per
   * skill, each containing SKILL.md). Lossless where it matters: versions are
   * carried over and provenance is re-matched from the promoted candidate
   * (candidates store their DRAFT path, so match by name + status).
   */
  rebuild(promotedRoot: string): number {
    const previousVersions = new Map(this.registry.list().map((r) => [r.name, r.version]));
    this.db.exec("DELETE FROM skills_fts");
    this.db.exec("DELETE FROM skills");
    const promotedCandidates = new SkillCandidateRepo(this.db).list().filter((c) => c.status === "promoted");
    let count = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(promotedRoot, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(promotedRoot, entry.name);
      const file = path.join(dirPath, "SKILL.md");
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let doc;
      try {
        doc = parseSkillMd(raw, file);
      } catch (err) {
        process.stderr.write(`[skills] skipping unreadable ${file}: ${err instanceof Error ? err.message : err}\n`);
        continue;
      }
      // 加固期 (P2): the local parser is necessary but not sufficient — a hand
      // dropped directory must pass PI'S OWN loader before it can be indexed
      // and injected into runs (same gate as promote).
      const verification = verifyPromotedSkills(dirPath);
      if (!verification.ok) {
        const errors = verification.diagnostics
          .filter((d) => d.type === "error")
          .map((d) => d.message)
          .join("; ");
        process.stderr.write(`[skills] rebuild: pi loader rejects ${dirPath} — skipping (${errors})\n`);
        continue;
      }
      const source = promotedCandidates.find((c) => c.name === doc.name);
      this.syncSkill({
        name: doc.name,
        dirPath,
        sourceCandidateId: source?.id,
        description: doc.description,
        body: doc.body,
      });
      const previousVersion = previousVersions.get(doc.name);
      if (previousVersion !== undefined && previousVersion > 1) {
        this.db.prepare("UPDATE skills SET version = ? WHERE name = ?").run(previousVersion, doc.name);
      }
      count++;
    }
    return count;
  }
}

/** Convert hits to the assembler's <available_skills> entries (workspace-relative location). */
export function toAssemblerEntries(hits: readonly SkillHit[], cwd: string): SkillEntry[] {
  return hits.map((h) => ({
    name: h.name,
    description: h.description,
    location: path.relative(path.resolve(cwd), path.join(h.dirPath, "SKILL.md")),
  }));
}
