import path from "node:path";

/**
 * Resolve a tool-supplied path against the workspace root and refuse escapes.
 * Absolute paths are allowed only when they already live inside the root.
 */
export function resolveWorkspacePath(root: string, p: string): string {
  const resolved = path.isAbsolute(p) ? path.normalize(p) : path.resolve(path.resolve(root), p);
  const rel = path.relative(path.resolve(root), resolved);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace root: ${p}`);
  }
  return resolved;
}

/** Directory for harness runtime data (traces, logs, later the SQLite db). */
export function harnessDataDir(root: string): string {
  return path.join(path.resolve(root), ".harness");
}

/** Directory holding one JSONL trace per run. */
export function tracesDir(root: string = process.cwd()): string {
  return path.join(harnessDataDir(root), "traces");
}

/** Root for skill drafts and promoted skills (阶段 10). */
export function skillsDir(root: string = process.cwd()): string {
  return path.join(harnessDataDir(root), "skills");
}

/** Promoted skills, one directory per skill containing SKILL.md — the layout
 * a pi skill loader scans. */
export function promotedSkillsDir(root: string = process.cwd()): string {
  return path.join(skillsDir(root), "promoted");
}
