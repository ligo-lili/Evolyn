import { DEFAULT_SYSTEM_PROMPT } from "../config.js";

export interface PromptSections {
  base?: string;
  skills?: string;
  experiences?: string;
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
    .map((s) => `  <skill><name>${s.name}</name><description>${s.description}</description><location>${s.location}</location></skill>`)
    .join("\n");
  return `<available_skills>\n${rows}\n</available_skills>\nWhen a task matches a skill above, read its SKILL.md (path in <location>) and follow it.`;
}

export interface ExperienceEntry {
  summaryZh: string;
  approach: string;
  pitfalls: string;
}

export function renderExperienceBlock(items: readonly ExperienceEntry[]): string {
  if (items.length === 0) return "";
  const rows = items.map((e) => `- ${e.summaryZh}｜approach: ${e.approach}｜pitfalls: ${e.pitfalls}`).join("\n");
  return `<relevant_experience>\n${rows}\n</relevant_experience>`;
}

/** Deterministic system prompt assembly: same inputs → byte-identical output. */
export function assembleSystemPrompt(sections: PromptSections = {}): string {
  const parts: string[] = [];
  parts.push((sections.base ?? DEFAULT_SYSTEM_PROMPT).trim());
  if (sections.skills?.trim()) parts.push(sections.skills.trim());
  if (sections.experiences?.trim()) parts.push(sections.experiences.trim());
  return parts.join("\n\n");
}
