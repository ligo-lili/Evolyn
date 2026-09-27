import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

/**
 * 阶段 12 completion gate: a promoted skill must load through PI'S OWN skill
 * loader, not just our parser. loadSkillsFromDir is the consumer-side contract
 * (agentskills.io layout); if it reports error diagnostics for our promoted
 * root, the skill is not actually pi-compatible regardless of what our format
 * check thinks.
 */

export interface SkillVerification {
  ok: boolean;
  /** Names of skills the pi loader accepted from the directory. */
  skills: Array<{ name: string; filePath: string; description: string }>;
  /** Loader diagnostics (warning | error | collision), verbatim. */
  diagnostics: Array<{ type: string; message: string; path?: string }>;
}

export function verifyPromotedSkills(promotedRoot: string, source = "harness-promoted"): SkillVerification {
  const result = loadSkillsFromDir({ dir: promotedRoot, source });
  const diagnostics = (result.diagnostics ?? []).map((d) => ({
    type: String(d.type),
    message: String(d.message),
    path: d.path == null ? undefined : String(d.path),
  }));
  const errors = diagnostics.filter((d) => d.type === "error");
  return {
    ok: errors.length === 0 && result.skills.length > 0,
    skills: result.skills.map((s) => ({ name: s.name, filePath: s.filePath, description: s.description })),
    diagnostics,
  };
}
