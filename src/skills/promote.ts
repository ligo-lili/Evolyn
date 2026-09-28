import fs from "node:fs";
import path from "node:path";
import { HarnessError } from "../errors.js";
import { defaultDbPath, openDatabase } from "../storage/db.js";
import { SkillCandidateRepo } from "../storage/repos/candidates.js";
import { SkillEvalRepo } from "../storage/repos/evals.js";
import { parseSkillMd } from "./format.js";
import { verifyPromotedSkills } from "./verify.js";
import { SkillIndex } from "./retrieve.js";
import { skillsDir } from "../runtime/paths.js";
import type { SkillRow } from "../storage/repos/skills.js";

/**
 * 阶段 10/12 promotion: a draft candidate becomes a pi-compatible skill —
 * `<skillsRoot>/promoted/<name>/SKILL.md` — and enters the retrieval index.
 * The file on disk is the authority; rows + FTS are derived projections.
 *
 * 阶段 12 hardening adds two gates:
 * - eval gate: the skill ledger's latest VALID report for this name must not
 *   say baseline-wins (a skill that measured WORSE than no-skill is refused;
 *   --force overrides). Promoting without any eval evidence warns.
 * - pi-loader gate: the promoted directory must load through pi's own
 *   loadSkillsFromDir — our parser agreeing is not the consumer's contract.
 */

export interface PromoteOptions {
  database?: string;
  skillsRoot?: string;
  /** Overwrite an existing skill of the same name, bumping its version. */
  force?: boolean;
  /** Skip the eval-ledger gate (verification always runs). */
  skipGate?: boolean;
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
    if (!candidate)
      throw new HarnessError(`candidate "${candidateId}" not found — run \`skill draft <patternId>\` first`);
    if (candidate.status === "promoted") throw new HarnessError(`candidate "${candidateId}" is already promoted`);
    if (candidate.status === "rejected") throw new HarnessError(`candidate "${candidateId}" was rejected`);

    const raw = fs.readFileSync(candidate.skillMdPath, "utf8");
    // Hard format gate: promote-time parse validates the pi-compatible format
    // (name slug <=64, description required <=1024, non-empty body).
    const doc = parseSkillMd(raw, candidate.skillMdPath);

    // Eval-ledger gate (阶段 12): refuse skills whose latest valid measurement lost to the baseline.
    if (!options.skipGate) {
      const latestValid = new SkillEvalRepo(db)
        .list(50)
        .find((r) => r.skillName === doc.name && r.report.valid !== false);
      if (latestValid) {
        if (latestValid.verdict === "baseline-wins" && !options.force) {
          throw new HarnessError(
            `eval gate: "${doc.name}" last measured baseline-wins ` +
              `(${Math.round(latestValid.baselinePass * 100)}% vs ${Math.round(latestValid.candidatePass * 100)}% at ${latestValid.decidedAt}) — promotion refused; fix the skill or pass --force`,
          );
        }
      } else {
        process.stderr.write(
          `[skills] warning: no valid eval report for "${doc.name}" — promoting without eval evidence\n`,
        );
      }
    }

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
    // 阶段 13 (P1-4): on a failed pi-loader check the written file must not
    // linger (rebuild would index a rejected skill) — restore the previous
    // version when overwriting, remove the directory otherwise.
    const previousRaw = existing && fs.existsSync(skillMdPath) ? fs.readFileSync(skillMdPath, "utf8") : undefined;
    fs.writeFileSync(skillMdPath, raw, "utf8");

    // pi-loader gate: the consumer contract, not just our parser.
    const verification = verifyPromotedSkills(root);
    const ownPath = (p?: string) => !p || p.replace(/\\/g, "/").includes(doc.name);
    const ownErrors = verification.diagnostics.filter((d) => d.type === "error" && ownPath(d.path));
    if (ownErrors.length > 0 || !verification.skills.some((s) => s.name === doc.name)) {
      const detail =
        ownErrors.map((d) => `${d.type}: ${d.message}`).join("; ") || "skill not discovered by loadSkillsFromDir";
      try {
        if (previousRaw !== undefined) fs.writeFileSync(skillMdPath, previousRaw, "utf8");
        else fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {
        process.stderr.write(`[skills] warning: failed to clean up after rejected promotion of "${doc.name}"\n`);
      }
      throw new HarnessError(`promoted skill failed pi loadSkillsFromDir: ${detail}`);
    }

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
