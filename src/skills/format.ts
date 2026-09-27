import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Pi-compatible SKILL.md format (阶段 10): YAML frontmatter with `name` and
 * `description`, markdown body with the actual instructions. The same file
 * layout a pi skill loader expects, so a promoted skill directory can be
 * pointed at any pi-compatible consumer later (阶段 12 validates with pi's
 * loadSkillsFromDir).
 */

/** pi skill rule: lowercase slug, digits and dashes, at most 64 chars. */
export const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;

export interface SkillDocument {
  name: string;
  description: string;
  body: string;
}

/** Validate a skill name against the pi format rules; throws with the reason. */
export function validateSkillName(name: string, source = "skill"): string {
  if (!name) throw new Error(`${source}: name is required`);
  if (name.length > SKILL_NAME_MAX) throw new Error(`${source}: name exceeds ${SKILL_NAME_MAX} chars`);
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`${source}: name "${name}" must match ${SKILL_NAME_PATTERN}`);
  return name;
}

/** Validate the description (required, <=1024); throws with the reason. */
export function validateSkillDescription(description: string, source = "skill"): string {
  const trimmed = description.trim();
  if (!trimmed) throw new Error(`${source}: description is required`);
  if (trimmed.length > SKILL_DESCRIPTION_MAX) throw new Error(`${source}: description exceeds ${SKILL_DESCRIPTION_MAX} chars`);
  return trimmed;
}

export function serializeSkillMd(doc: SkillDocument): string {
  const name = validateSkillName(doc.name);
  const description = validateSkillDescription(doc.description);
  const frontmatter = stringifyYaml({ name, description });
  return `---\n${frontmatter}---\n${doc.body.trim()}\n`;
}

/** Strict parse: throws on missing frontmatter, missing fields, or format violations. */
export function parseSkillMd(raw: string, source: string): SkillDocument {
  if (!raw.startsWith("---")) throw new Error(`${source}: missing frontmatter`);
  const end = raw.indexOf("\n---", 3);
  if (end === -1) throw new Error(`${source}: unterminated frontmatter`);
  const meta = (parseYaml(raw.slice(3, end)) ?? {}) as Record<string, unknown>;
  const name = validateSkillName(String(meta.name ?? ""), source);
  const description = validateSkillDescription(String(meta.description ?? ""), source);
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1).trim();
  if (!body) throw new Error(`${source}: body is empty`);
  return { name, description, body };
}
