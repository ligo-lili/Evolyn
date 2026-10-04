#!/usr/bin/env node
// Rebuild the per-run JSONL trace files from the SQLite authority.
//
// 加固期实战 (dogfood): an agent running with --yolo deleted .harness/ — the
// JSONL mirror and the skills/evidence trees went with it, but SQLite (the
// recovery authority) holds every event. This script re-derives the JSONL
// projection, exactly the "append-only authority + rebuildable projections"
// invariant: any projection can be wiped and rebuilt from its authority.
//
// Usage: node scripts/export-traces.mjs [--db <path>] [--traces-dir <path>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = pathToFileURL(path.join(here, "..", "dist", "index.js")).href;
const harness = await import(dist);

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const dbPath = arg("--db", path.join(process.cwd(), ".harness", "harness.db"));
const tracesDir = arg("--traces-dir", path.join(process.cwd(), ".harness", "traces"));

const db = harness.openDatabase(dbPath);
try {
  const runs = new harness.RunRepo(db).list(10_000);
  let files = 0;
  let events = 0;
  let incomplete = 0;
  for (const run of runs) {
    try {
      const eventsForRun = new harness.TraceEventRepo(db).getByRun(run.id);
      if (eventsForRun.length === 0) continue;
      fs.mkdirSync(tracesDir, { recursive: true });
      const file = path.join(tracesDir, `${run.id}.jsonl`);
      fs.writeFileSync(file, eventsForRun.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      // 加固期复核: interrupted runs (status=running, no run_end) are EXPECTED
      // in a crash-recovery repo — the full bracket check would abort the
      // export on exactly the runs this tool exists to recover. Validate seq
      // monotonicity inline and let the bracket check apply only to complete
      // traces.
      const last = eventsForRun.at(-1);
      if (last?.type === "run_end") {
        harness.readTraceFile(file);
      } else {
        incomplete++;
        for (let s = 1; s < eventsForRun.length; s++) {
          if (eventsForRun[s].seq <= eventsForRun[s - 1].seq) {
            throw new Error(`seq ${eventsForRun[s].seq} follows ${eventsForRun[s - 1].seq} (reorder or duplicate)`);
          }
        }
      }
      files++;
      events += eventsForRun.length;
    } catch (err) {
      // One damaged run must not abort the whole projection rebuild.
      console.warn(`[export] skipped run ${run.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(
    `exported ${files} trace file(s), ${events} event(s) from ${dbPath}` +
      (incomplete ? ` (${incomplete} interrupted run(s) exported without bracket validation)` : ""),
  );
} finally {
  db.close();
}
