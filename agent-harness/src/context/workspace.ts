import fs from "node:fs";
import path from "node:path";

/**
 * 阶段 13: deterministic workspace tree for the coding system prompt's
 * <workspace> block. The model needs an orientation map of the repo it is
 * editing; this is generated from the filesystem on every run (same inputs →
 * byte-identical output, like the rest of the assembler).
 *
 * v1 rules (dumbest useful): depth ≤2, skip VCS/deps/build dirs and hidden
 * entries, cap the entry count. Files before directories, both sorted.
 */

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".harness",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
]);

const MAX_ENTRIES = 60;

export function buildWorkspaceTree(root: string = process.cwd(), maxDepth = 2, maxEntries = MAX_ENTRIES): string {
  const lines: string[] = [];
  const visit = (dir: string, prefix: string, depth: number): void => {
    if (lines.length >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const visible = entries
      .filter((e) => !e.name.startsWith(".") && !(e.isDirectory() && SKIP_DIRECTORIES.has(e.name)))
      // 加固期修复: localeCompare varies with the system's ICU/locale — the
      // same workspace sorted differently across machines would byte-drift the
      // system prompt and silently void the prompt cache. Plain codepoint
      // compare is machine-independent (and ties break by file/dir order,
      // which the sort key above already handles deterministically).
      .sort((a, b) => Number(b.isFile()) - Number(a.isFile()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of visible) {
      if (lines.length >= maxEntries) {
        lines.push(`${prefix}…`);
        return;
      }
      if (entry.isFile()) lines.push(`${prefix}${entry.name}`);
      else if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        if (depth + 1 < maxDepth) visit(path.join(dir, entry.name), `${prefix}  `, depth + 1);
      }
    }
  };
  visit(root, "", 0);
  return lines.join("\n");
}
