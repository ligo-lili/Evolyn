import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/db.js";
import { MemorySearchIndex } from "../src/memory/search.js";
import { MemoryStore } from "../src/memory/store.js";
import { cosineSimilarity, rrfCombine, type PassageEmbedder } from "../src/memory/embedding.js";
import { chunkMemory } from "../src/memory/model.js";
import { makeTempCwd } from "./helpers.js";

const tmp = makeTempCwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

/** Deterministic 2-dim embedder keyed by exact text match (tests only). */
function exactEmbedder(mapping: Readonly<Record<string, number[]>>): PassageEmbedder {
  const pick = (text: string) => mapping[text] ?? [0, 0];
  return {
    embedPassages: async (texts) => texts.map(pick),
    embedQuery: async (text) => pick(text),
  };
}

describe("RRF + cosine primitives", () => {
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

describe("hybrid memory recall (chunk-level vectors, memory-level RRF)", () => {
  it("vector recall covers lexical blind spots, fusion ranks by memory, and survives reopen", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "hybrid", "harness.db");
    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));

    const a = await store.create({
      title: "apple",
      summary: "apples",
      content: "apple handling notes",
      keywords: ["apple"],
    });
    const b = await store.create({
      title: "banana",
      summary: "bananas",
      content: "banana handling notes",
      keywords: ["banana"],
    });
    const c = await store.create({
      title: "cherry",
      summary: "cherries",
      content: "polish the diamond",
      keywords: ["gem"],
    });

    const db = openDatabase(dbPath);
    try {
      const index = new MemorySearchIndex(db);
      index.reconcile(store);

      // "diamond" lives only in cherry's content — lexically findable too; the
      // fake embedder keys on exact chunk text, fully controlled for us.
      const [chunkA, chunkB, chunkC] = [a, b, c].map((r) => chunkMemory(r)[0]!);
      const embedder = exactEmbedder({
        [chunkA.text]: [1, 0],
        [chunkB.text]: [0, 1],
        [chunkC.text]: [0, 1],
        "gem diamond": [0, 1],
      });
      for (const record of store.list("active")) await index.embedRecord(record, embedder, "fake-e5");
      expect(index.vectorCount()).toBe(3);

      // 1) semantic query with ZERO lexical overlap for cherry's competitors:
      //    only cherry is similar; both paths fire → mode=hybrid, cherry first.
      const semantic = await index.search(store, "gem diamond", { limit: 3, embedder });
      expect(semantic[0]!.record.id).toBe(c.id);
      expect(semantic[0]!.mode).toBe("hybrid");

      // 2) blob round-trip survives a reopen (fresh connection, same DB file)
      const db2 = openDatabase(dbPath);
      try {
        const index2 = new MemorySearchIndex(db2);
        expect(index2.vectorCount()).toBe(3);
        const again = await index2.search(store, "gem diamond", { limit: 3, embedder });
        expect(again[0]!.record.id).toBe(c.id);
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
    tmp.leave();
  });

  it("degrades to FTS-only when no vectors exist; weak vector hits are filtered by min similarity", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "fallback", "harness.db");
    const db = openDatabase(dbPath);
    try {
      const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
      const a = await store.create({ title: "only", summary: "s", content: "dedupe csv rows", keywords: [] });
      const index = new MemorySearchIndex(db);
      index.reconcile(store);

      const ftsOnly = await index.search(store, "csv dedupe", { limit: 3 });
      expect(ftsOnly[0]!.mode).toBe("fts");
      expect(ftsOnly[0]!.record.id).toBe(a.id);

      // vectors built, but the query is orthogonal → below the 0.12 floor →
      // the vector path contributes nothing and the mode stays fts.
      const chunk = chunkMemory(a)[0]!;
      const orthogonal = exactEmbedder({ [chunk.text]: [1, 0], "unrelated query": [0, 1] });
      await index.embedRecord(a, orthogonal, "fake-e5");
      const noVectorHit = await index.search(store, "unrelated query", { limit: 3, embedder: orthogonal });
      expect(noVectorHit).toEqual([]);
    } finally {
      db.close();
    }
    tmp.leave();
  });
});
