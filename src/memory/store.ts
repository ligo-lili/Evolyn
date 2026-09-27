import fs from "node:fs";
import path from "node:path";
import { HarnessError } from "../errors.js";
import { parseMemory, serializeMemory, type MemoryRecord } from "./model.js";

/**
 * Markdown-authoritative memory storage (阶段 9.5).
 * Layout under the memory dir:
 *   core.md               — Core Memory, always injected into the system prompt
 *   ordinary/<id>.md      — Ordinary Memory, one experience per file
 * Every derived index (FTS5, later vectors) can be rebuilt from these files.
 */
export class MemoryStore {
  constructor(readonly dir: string) {}

  get corePath(): string {
    return path.join(this.dir, "core.md");
  }

  get ordinaryDir(): string {
    return path.join(this.dir, "ordinary");
  }

  /** Core Memory body (frontmatter stripped), or undefined when absent. */
  readCore(): string | undefined {
    try {
      const raw = fs.readFileSync(this.corePath, "utf8");
      if (raw.startsWith("---")) {
        const end = raw.indexOf("\n---", 3);
        return end === -1 ? raw : raw.slice(raw.indexOf("\n", end + 1) + 1).trim();
      }
      return raw.trim();
    } catch {
      return undefined;
    }
  }

  writeCore(body: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.corePath, body.trim() + "\n", "utf8");
  }

  pathOf(id: string): string {
    // 阶段 13 (P1-1): single choke point — every id → path conversion goes
    // through the fence, so a hostile id (distiller updateOf, frontmatter id)
    // cannot escape the memory dir.
    const file = path.join(this.ordinaryDir, `${id}.md`);
    const rel = path.relative(this.ordinaryDir, file);
    if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      throw new HarnessError(`invalid memory id: ${id}`);
    }
    return file;
  }

  save(record: MemoryRecord): string {
    fs.mkdirSync(this.ordinaryDir, { recursive: true });
    const file = this.pathOf(record.id);
    fs.writeFileSync(file, serializeMemory(record), "utf8");
    return file;
  }

  get(id: string): MemoryRecord | undefined {
    try {
      return parseMemory(fs.readFileSync(this.pathOf(id), "utf8"), this.pathOf(id));
    } catch {
      return undefined;
    }
  }

  list(): MemoryRecord[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.ordinaryDir).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
    const records: MemoryRecord[] = [];
    for (const f of files) {
      const file = path.join(this.ordinaryDir, f);
      try {
        records.push(parseMemory(fs.readFileSync(file, "utf8"), file));
      } catch (err) {
        process.stderr.write(`[memory] skipping unreadable ${file}: ${err instanceof Error ? err.message : err}\n`);
      }
    }
    return records.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** Alias kept for the 阶段 9.5 name — same fence as pathOf. */
  safePath(id: string): string {
    return this.pathOf(id);
  }
}
