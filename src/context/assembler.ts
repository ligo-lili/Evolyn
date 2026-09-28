import { DEFAULT_SYSTEM_PROMPT } from "../config.js";

export interface PromptSections {
  base?: string;
  /** Core Memory — always resident (阶段 9.5). */
  core?: string;
  skills?: string;
  /** Ordinary Memory pointers — the model reads the full text on demand. */
  experiences?: string;
  /** 阶段 13: workspace orientation map for the coding toolset. */
  workspace?: string;
}

export function renderWorkspaceBlock(tree: string): string {
  if (!tree.trim()) return "";
  return `<workspace>\n${tree.trim()}\n</workspace>`;
}

export interface SkillEntry {
  name: string;
  description: string;
  /** Absolute path of the skill's SKILL.md — matches pi's <available_skills> style. */
  location: string;
}

export function renderSkillBlock(skills: readonly SkillEntry[]): string {
  if (skills.length === 0) return "";
  const rows = skills
    .map(
      (s) =>
        `  <skill><name>${s.name}</name><description>${s.description}</description><location>${s.location}</location></skill>`,
    )
    .join("\n");
  return `<available_skills>\n${rows}\n</available_skills>\nWhen a task matches a skill above, read its SKILL.md (path in <location>) and follow it.`;
}

/** Pointer entry for Ordinary Memory: the model follows `path` to read the full memory file. */
export interface ExperienceEntry {
  summaryZh: string;
  /** Workspace-relative path of the memory markdown file. */
  path: string;
}

export function renderExperienceBlock(items: readonly ExperienceEntry[]): string {
  if (items.length === 0) return "";
  const rows = items.map((e) => `- ${e.summaryZh}（read the full memory file at: ${e.path}）`).join("\n");
  return `<relevant_experience>\n${rows}\n</relevant_experience>\nIf a memory above matches the current task, read its file first and apply its approach while avoiding its pitfalls.`;
}

/** Deterministic system prompt assembly: same inputs → byte-identical output. */
export function assembleSystemPrompt(sections: PromptSections = {}): string {
  const parts: string[] = [];
  parts.push((sections.base ?? DEFAULT_SYSTEM_PROMPT).trim());
  if (sections.core?.trim()) parts.push(sections.core.trim());
  if (sections.workspace?.trim()) parts.push(sections.workspace.trim());
  if (sections.skills?.trim()) parts.push(sections.skills.trim());
  if (sections.experiences?.trim()) parts.push(sections.experiences.trim());
  return parts.join("\n\n");
}
