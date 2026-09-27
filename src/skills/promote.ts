import fs from "node:fs";
import path from "node:path";
import { HarnessError } from "../errors.js";
import { defaultDbPath, openDatabase } from "../storage/db.js";
import { SkillCandidateRepo } from "../storage/repos/candidates.js";
import { parseSkillMd } from "./format.js";
import { SkillIndex } from "./retrieve.js";
import { skillsDir } from "../runtime/paths.js";
import type { SkillRow } from "../storage/repos/skills.js";

/**
 * 阶段 10 promotion: a draft candidate becomes a pi-compatible skill —
 * `<skillsRoot>/promoted/<name>/SKILL.md` — and enters the retrieval index.
 * The file on disk is the authority; rows + FTS are derived projections.
 */

export interface PromoteOptions {
  database?: string;
  skillsRoot?: string;
  /** Overwrite an existing skill of the same name, bumping its version. */
  force?: boolean;
}

export interface PromoteOutcome {
  skill: SkillRow;
  skillMdPath: string;
  overwritten: boolean;
}

export function promoteCandidate(candidateId: string, options: PromoteOptions = {}): PromoteOutcome {
  const db = openDatabase(options.database ?? defaultDbPath());
  try {
    const repo = new SkillCandidateRepo(db);
    const candidate = repo.get(candidateId);
    if (!candidate) throw new HarnessError(`candidate "${candidateId}" not found — run \`skill draft <patternId>\` first`);
    if (candidate.status === "promoted") throw new HarnessError(`candidate "${candidateId}" is already promoted`);
    if (candidate.status === "rejected") throw new HarnessError(`candidate "${candidateId}" was rejected`);

    const raw = fs.readFileSync(candidate.skillMdPath, "utf8");
    // Hard format gate: promote-time parse validates the pi-compatible format
    // (name slug <=64, description required <=1024, non-empty body).
    const doc = parseSkillMd(raw, candidate.skillMdPath);

    const root = path.join(options.skillsRoot ?? skillsDir(), "promoted");
    const dirPath = path.join(root, doc.name);
    const skillMdPath = path.join(dirPath, "SKILL.md");
    const existing = new SkillIndex(db).getByName([doc.name])[0];
    if (existing && !options.force) {
      throw new HarnessError(
        `a promoted skill named "${doc.name}" already exists (v${existing.version}) — edit the draft or pass force to overwrite`,
      );
    }

    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(skillMdPath, raw, "utf8");
    const skill = new SkillIndex(db).syncSkill({
      name: doc.name,
      dirPath,
      sourceCandidateId: candidate.id,
      description: doc.description,
      body: doc.body,
    });
    repo.setStatus(candidate.id, "promoted");
    return { skill, skillMdPath, overwritten: existing !== undefined };
  } finally {
    db.close();
  }
}
