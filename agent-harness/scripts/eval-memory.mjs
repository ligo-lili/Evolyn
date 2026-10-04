/**
 * Retrieval-quality eval for the memory search index (scripts consume dist/).
 *
 *   node scripts/eval-memory.mjs [--fixture <path>] [--hybrid] [--min-recall <n>]
 *
 * - FTS mode (default): fully offline, runs in CI behind two gates —
 *     (a) recall@5 ≥ --min-recall (default 0.7)
 *     (b) NO blind spots: every query must surface ≥1 expected id in the top-5
 *   A load-bearing keyword going missing turns (b) red immediately; broad
 *   degradation trips (a).
 * - --hybrid: adds the vector path (local embedding model, ~30MB first
 *   download) — not for CI; results go to the .harness/evals ledger.
 *
 * Exit codes: 0 = gates green; 1 = gates red (quality finding, "low scores
 * are data"); 2 = infrastructure failure (contaminated run, never gates).
 * The report lands in .harness/evals/memory-retrieval-<ts>.json, sharing the
 * protocol/ledger vocabulary with the skill A/B evals.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { openDatabase } from "../dist/index.js";
import { MemoryStore, MemorySearchIndex, MAX_ACTIVE_MEMORIES } from "../dist/index.js";
import { sharedEmbedder, EMBEDDING_MODEL_ID } from "../dist/index.js";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
const fixturePath = flag("--fixture") ?? path.join(process.cwd(), "evals", "memory-retrieval.json");
const hybrid = args.includes("--hybrid");
const minRecall = Number(flag("--min-recall") ?? 0.7);
const limit = 5;

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
if (!Array.isArray(fixture.memories) || fixture.memories.length < 10) {
  throw new Error(`fixture needs >=10 memories, got ${fixture.memories?.length ?? 0}`);
}
if (!Array.isArray(fixture.queries) || fixture.queries.length < 15) {
  throw new Error(`fixture needs >=15 queries, got ${fixture.queries?.length ?? 0}`);
}
if (fixture.memories.length > MAX_ACTIVE_MEMORIES) {
  throw new Error(`fixture has more memories than the active capacity (${MAX_ACTIVE_MEMORIES})`);
}

// ---- build the index from the fixture (memory Markdown = the authority) ----
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "eval-memory-"));
const dbPath = path.join(ws, "harness.db");
const db = openDatabase(dbPath);
const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
const index = new MemorySearchIndex(db);
try {
  for (const m of fixture.memories) {
    const record = await store.create({
      title: m.title,
      summary: m.summary,
      content: m.content,
      keywords: m.keywords ?? [],
    });
    if (m.id && record.id !== m.id) {
      throw new Error(`fixture id drift: expected ${m.id}, allocated ${record.id} (keep fixture ids in order)`);
    }
  }
  index.reconcile(store);
  if (hybrid) {
    const embedder = sharedEmbedder();
    for (const record of store.list("active")) await index.embedRecord(record, embedder, EMBEDDING_MODEL_ID);
  }
} catch (err) {
  db.close();
  console.error(`[eval:memory] INFRASTRUCTURE FAILURE — report marked INVALID, nothing gated: ${err?.message ?? err}`);
  process.exit(2);
}

// ---- run the queries --------------------------------------------------------
const perQuery = [];
for (const q of fixture.queries) {
  const hits = await index.search(store, q.query, { limit, embedder: hybrid ? sharedEmbedder() : undefined });
  const retrieved = hits.map((h) => h.record.id);
  const expected = q.expected;
  const hitSet = new Set(retrieved.slice(0, limit));
  const relevantInTop = expected.filter((id) => hitSet.has(id)).length;
  const recall = expected.length > 0 ? relevantInTop / expected.length : 1;
  const firstRank = retrieved.findIndex((id) => expected.includes(id));
  const mrr = firstRank === -1 ? 0 : 1 / (firstRank + 1);
  perQuery.push({
    query: q.query,
    expected,
    retrieved,
    recall,
    reciprocalRank: mrr,
    mode: hits[0]?.mode ?? "unavailable",
    degradeReason: hits[0]?.degradeReason,
  });
}
db.close();
fs.rmSync(ws, { recursive: true, force: true });

// ---- metrics + gates --------------------------------------------------------
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const recallAt5 = mean(perQuery.map((r) => r.recall));
const mrr = mean(perQuery.map((r) => r.reciprocalRank));
const blindSpots = perQuery.filter((r) => r.reciprocalRank === 0);

console.log(`eval:memory — fixture=${path.basename(fixturePath)} mode=${hybrid ? "hybrid" : "fts"}`);
console.log(
  `recall@${limit}: ${recallAt5.toFixed(3)} (gate ≥ ${minRecall}) | MRR: ${mrr.toFixed(3)} | blind spots: ${blindSpots.length}/${perQuery.length}`,
);
for (const r of perQuery) {
  const mark = r.reciprocalRank === 0 ? "MISS" : r.recall < 1 ? "part" : "ok  ";
  console.log(
    `  [${mark}] recall=${r.recall.toFixed(2)} rr=${r.reciprocalRank.toFixed(2)} ${JSON.stringify(r.query)} → ${r.retrieved.join(",") || "(none)"} (want ${r.expected.join(",")})`,
  );
}

const gatesGreen = recallAt5 >= minRecall && blindSpots.length === 0;
const verdict = gatesGreen ? "pass" : "fail";

// ---- ledger (.harness/evals/, protocol-aligned vocabulary) -------------------
const ledgerDir = path.join(process.cwd(), ".harness", "evals");
fs.mkdirSync(ledgerDir, { recursive: true });
const protocolSha = createHash("sha256")
  .update(
    JSON.stringify({ name: fixture.name, memories: fixture.memories, queries: fixture.queries, limit, minRecall }),
  )
  .digest("hex");
const report = {
  name: "memory-retrieval",
  mode: hybrid ? "hybrid" : "fts",
  embeddingModel: hybrid ? EMBEDDING_MODEL_ID : null,
  protocol: {
    taskSet: fixture.name,
    queries: fixture.queries.length,
    memories: fixture.memories.length,
    limit,
    minRecall,
  },
  protocolSha256: protocolSha,
  metrics: { recallAt5, mrr, blindSpots: blindSpots.length },
  gates: { minRecall: recallAt5 >= minRecall, noBlindSpots: blindSpots.length === 0 },
  queries: perQuery,
  verdict,
  timestamp: new Date().toISOString(),
};
const ledgerPath = path.join(ledgerDir, `memory-retrieval-${Date.now()}.json`);
fs.writeFileSync(ledgerPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(`ledger: ${ledgerPath} (verdict: ${verdict})`);

if (!gatesGreen) {
  console.error(
    `[eval:memory] GATE RED — recall@5 ${recallAt5.toFixed(3)} < ${minRecall} or ${blindSpots.length} blind spot(s)`,
  );
  process.exit(1);
}
