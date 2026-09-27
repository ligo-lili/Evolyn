import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/db.js";
import { RunRepo } from "../src/storage/repos/runs.js";
import { MemorySearchIndex, passageText } from "../src/memory/search.js";
import { MemoryStore } from "../src/memory/store.js";
import { cosineSimilarity, rrfCombine, type PassageEmbedder } from "../src/memory/embedding.js";
import type { MemoryRecord } from "../src/memory/model.js";
import { makeTempCwd } from "./helpers.js";

const tmp = makeTempCwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

function mkRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2, 10),
    runId: "seed",
    taskType: "file-organization",
    outcome: "success",
    summaryEn: "Organized reports; dedupe csv rows before merging.",
    summaryZh: "整理报告，合并前 csv 去重。",
    approach: "Read, dedupe, then merge.",
    pitfalls: "Do not merge before dedupe.",
    keywordsEn: ["csv", "dedupe", "reports"],
    confirmations: 0,
    model: "test/fake-model",
    created: now,
    updated: now,
    ...overrides,
  };
}

/** Deterministic 3-dim embedder keyed by exact text match (tests only). */
function exactEmbedder(mapping: Readonly<Record<string, number[]>>): PassageEmbedder {
  const pick = (text: string) => mapping[text] ?? [0, 0, 0];
  return {
    embedPassages: async (texts) => texts.map(pick),
    embedQuery: async (text) => pick(text),
  };
}

describe("RRF + cosine (阶段 9.6)", () => {
  it("fuses rankings with 1/(k+rank) and breaks ties deterministically", () => {
    const fused = rrfCombine([
      [{ id: "A" }, { id: "B" }, { id: "C" }],
      [{ id: "C" }, { id: "A" }],
    ]);
    // A: 1/61 + 1/62 ; C: 1/63 + 1/61 ; B: 1/62
    expect(fused.map((f) => f.id)).toEqual(["A", "C", "B"]);
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
  });

  it("cosineSimilarity: parallel=1, orthogonal=0, zero-vector=0", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("hybrid memory recall (阶段 9.6)", () => {
  it("searchHybrid === RRF(fts, vectors), vector recall covers lexical blind spots, and survives reopen", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "hybrid", "harness.db");

    // phase 1: seed + build vectors
    {
      const db = openDatabase(dbPath);
      try {
        new RunRepo(db).insert({ id: "seed", task: "seed", modelSpec: "test/fake-model", status: "completed", startedAt: new Date().toISOString() });
        const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
        const index = new MemorySearchIndex(db);

        // "diamond" lives only in C's approach — lexically findable; the fake
        // embedder instead keys on exact passage text, so vectors are arbitrary
        // w.r.t. the words (worst case for lexical, fully controlled for us).
        const a = mkRecord({ id: "apple-mem", summaryEn: "apple zebra notes", keywordsEn: ["apple", "zebra"], approach: "apple handling" });
        const b = mkRecord({ id: "banana-mem", summaryEn: "banana zebra notes", keywordsEn: ["banana", "zebra"], approach: "banana handling" });
        const c = mkRecord({ id: "cherry-mem", summaryEn: "citrus zebra notes", keywordsEn: ["citrus", "zebra"], approach: "polish the diamond" });
        for (const r of [a, b, c]) {
          store.save(r);
          index.syncRecord(r);
        }

        const embedder = exactEmbedder({
          [passageText(a)]: [1, 0, 0],
          [passageText(b)]: [0, 1, 0],
          [passageText(c)]: [0, 0, 1],
          "gem query": [0, 0, 1],
        });
        expect(await index.rebuildVectors(store, embedder)).toBe(3);
        expect(index.vectorCount()).toBe(3);
      } finally {
        db.close();
      }
    }

    // phase 2: fresh connection — the blob round-trip must survive reopen
    {
      const db2 = openDatabase(dbPath);
      try {
        const index2 = new MemorySearchIndex(db2);
        expect(index2.vectorCount()).toBe(3);

        // 1) lexical query: hybrid must equal RRF of both channels
        const lexical = "apple zebra";
        const ftsIds = index2.searchFts(lexical, 25).map((r) => r.id);
        const vecRanked = ["apple-mem", "banana-mem", "cherry-mem"]; // zero query vector → stable insertion order
        const expected = rrfCombine([ftsIds.map((id, i) => ({ id, rank: i + 1 })), vecRanked.map((id, i) => ({ id, rank: i + 1 }))])
          .slice(0, 3)
          .map((f) => f.id);
        const embedder = exactEmbedder({ "gem query": [0, 0, 1] });
        const hybrid = await index2.searchHybrid(lexical, 3, embedder);
        expect(hybrid.map((r) => r.id)).toEqual(expected);

        // 2) semantic query with ZERO lexical overlap: FTS finds nothing, the
        //    vector channel still surfaces the right memory.
        expect(index2.searchFts("gem query", 5)).toEqual([]);
        const semantic = await index2.searchHybrid("gem query", 3, embedder);
        expect(semantic[0]?.id).toBe("cherry-mem");
      } finally {
        db2.close();
      }
    }
    tmp.leave();
  });

  it("degrades to FTS-only when no vectors exist or no embedder is given", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "fallback", "harness.db");
    const db = openDatabase(dbPath);
    try {
      new RunRepo(db).insert({ id: "seed", task: "seed", modelSpec: "test/fake-model", status: "completed", startedAt: new Date().toISOString() });
      const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
      const index = new MemorySearchIndex(db);
      const a = mkRecord({ id: "only-mem" });
      store.save(a);
      index.syncRecord(a);

      const fts = index.searchFts("csv dedupe", 3);
      const hybrid = await index.searchHybrid("csv dedupe", 3);
      expect(hybrid.map((r) => r.id)).toEqual(fts.map((r) => r.id));
      expect(index.vectorCount()).toBe(0);
    } finally {
      db.close();
    }
    tmp.leave();
  });
});
