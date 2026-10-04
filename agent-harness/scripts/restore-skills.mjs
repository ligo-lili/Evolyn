#!/usr/bin/env node
// Restore promoted-skill SKILL.md files whose on-disk copy was lost, using the
// skills_fts projection (which stores the full description + body) as the
// source. 加固期实战: an agent deleted .harness/ under --yolo; the skills rows
// and FTS survived inside the SQLite authority, so the files re-derive.
//
// Usage: node scripts/restore-skills.mjs [--db <path>] [--promoted <dir>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = pathToFileURL(path.join(here, "..", "dist", "index.js")).href;
const harness = await import(dist);
const format = await import(pathToFileURL(path.join(here, "..", "dist", "skills", "format.js")).href);

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const dbPath = arg("--db", path.join(process.cwd(), ".harness", "harness.db"));
const promotedRoot = arg("--promoted", path.join(process.cwd(), ".harness", "skills", "promoted"));

const db = harness.openDatabase(dbPath);
try {
  const rows = db
    .prepare("SELECT s.name, s.dir_path, f.description, f.body FROM skills s JOIN skills_fts f ON f.skill_id = s.id")
    .all();
  let restored = 0;
  let present = 0;
  for (const row of rows) {
    const dirPath = path.join(promotedRoot, row.name);
    const file = path.join(dirPath, "SKILL.md");
    if (fs.existsSync(file)) {
      present++;
      continue;
    }
    fs.mkdirSync(dirPath, { recursive: true });
    // The FTS body is the distilled text; promote-time validation re-parses it.
    const raw = format.serializeSkillMd({ name: row.name, description: row.description, body: row.body });
    fs.writeFileSync(file, raw, "utf8");
    restored++;
    console.log(`restored ${row.name} from the FTS projection`);
  }
  console.log(`promoted files: ${present} present, ${restored} restored`);
} finally {
  db.close();
}
