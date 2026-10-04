import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/db.js";
import { MAX_ACTIVE_MEMORIES, MemoryConflictError, MemoryStore } from "../src/memory/store.js";
import { MemorySearchIndex } from "../src/memory/search.js";
import { chunkMemory, parseMemory, serializeMemory, type MemoryRecord } from "../src/memory/model.js";
import { parseCore, renderCore, serializeCore, upsertCoreEntry, type CoreFile } from "../src/memory/core.js";
import { buildRunDigest, parseReflectionDecision, reflectRunById, shouldReflect } from "../src/memory/reflection.js";
import { EMBEDDING_MODEL_ID } from "../src/memory/embedding.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";

const tmp = makeTempCwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

function mkRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "M001",
    title: overrides.title ?? "Organize reports",
    summary: overrides.summary ?? "整理报告，合并前 csv 去重。",
    content: overrides.content ?? "Read, dedupe, then merge.\n\nDo not merge before dedupe.",
    keywords: overrides.keywords ?? ["csv", "dedupe", "reports"],
    revision: overrides.revision ?? 1,
    status: overrides.status ?? "active",
    sourceRunId: overrides.sourceRunId,
    model: overrides.model ?? "test/fake-model",
    created: overrides.created ?? now,
    updated: overrides.updated ?? now,
    lastAccessed: overrides.lastAccessed,
    accessCount: overrides.accessCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 数据模型（设计 §4.2 / §7.2）
// ---------------------------------------------------------------------------

describe("memory model v3 (§4.2)", () => {
  it("serializes to markdown with frontmatter and parses back losslessly", () => {
    const record = mkRecord();
    const raw = serializeMemory(record);
    expect(raw.startsWith("---")).toBe(true);
    expect(parseMemory(raw, "test")).toEqual(record);
  });

  it("enforces the M### id shape and rejects hostile ids", () => {
    const hostile = `---\nid: ../../../evil\ntitle: t\nsummary: s\nrevision: 1\nstatus: active\ncreated: now\nupdated: now\n---\nx`;
    expect(() => parseMemory(hostile, "test")).toThrow(/invalid id/);
    expect(parseMemory(serializeMemory(mkRecord({ id: "M012" })), "t").id).toBe("M012");
  });

  it("chunking: paragraph accumulation, semantic header, overlap, sha256, ≤16 cap", () => {
    const content = Array.from({ length: 40 }, (_, i) => `paragraph ${i} ${"x".repeat(120)}`).join("\n\n");
    const record = mkRecord({ title: "csv dedupe", summary: "去重后再合并。", content });
    const chunks = chunkMemory(record);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(16);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith("title: csv dedupe | summary: 去重后再合并。")).toBe(true);
      expect(chunk.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // 第 2 块起携带上一块尾部 ≤180 字符的重叠
    expect(chunks[1]!.text).toContain(chunks[0]!.text.slice(-180));
    // 内容身份：同文本同 sha
    expect(chunks[0]!.sha256).toBe(chunks[0]!.sha256);
  });
});

// ---------------------------------------------------------------------------
// 存储层（设计 §4.3 / §6.5 / §10）
// ---------------------------------------------------------------------------

describe("memory store v3 (markdown authority)", () => {
  it("create/list/get with sequential M### ids, INDEX.md projection, atomic writes leave no tmp", async () => {
    tmp.enter();
    const store = new MemoryStore(path.join(tmp.dir, "mem"));
    const a = await store.create({ title: "A", summary: "a 摘要", content: "a body", keywords: ["a"] });
    const b = await store.create({ title: "B", summary: "b 摘要", content: "b body", keywords: ["b"] });
    expect([a.id, b.id]).toEqual(["M001", "M002"]);
    expect(store.get("M001")?.title).toBe("A");
    expect(store.list().map((r) => r.id)).toEqual(["M001", "M002"]);
    expect(fs.existsSync(store.indexPath)).toBe(true);
    expect(fs.readFileSync(store.indexPath, "utf8")).toContain("- M001 | A | rev 1 |");
    // 原子写：目录里没有 .tmp 残留
    expect(fs.readdirSync(path.join(tmp.dir, "mem", "active")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    tmp.leave();
  });

  it("updateIfRevision: full replacement bumps revision; stale revision raises conflict", async () => {
    tmp.enter();
    const store = new MemoryStore(path.join(tmp.dir, "upd"));
    const created = await store.create({ title: "T", summary: "s", content: "old body", keywords: [] });
    const updated = await store.updateIfRevision(created.id, 1, {
      title: "T2",
      summary: "s2",
      content: "new body (complete replacement)",
      keywords: ["new"],
    });
    expect(updated.revision).toBe(2);
    expect(store.get(created.id)?.content).toBe("new body (complete replacement)");
    await expect(
      store.updateIfRevision(created.id, 1, { title: "x", summary: "x", content: "x", keywords: [] }),
    ).rejects.toThrow(MemoryConflictError);
    tmp.leave();
  });

  it("capacity hard cap: the 26th create is rejected (设计 §6.5, max_active=25)", async () => {
    tmp.enter();
    const store = new MemoryStore(path.join(tmp.dir, "cap"));
    for (let i = 1; i <= MAX_ACTIVE_MEMORIES; i++) {
      await store.create({ title: `T${i}`, summary: "s", content: "b", keywords: [] });
    }
    expect(store.activeCount()).toBe(MAX_ACTIVE_MEMORIES);
    await expect(store.create({ title: "over", summary: "s", content: "b", keywords: [] })).rejects.toThrow(
      /capacity exhausted/,
    );
    // 归档释放容量
    const first = store.get("M001")!;
    await store.archiveIfUnchanged(first.id, first.revision);
    expect(store.activeCount()).toBe(MAX_ACTIVE_MEMORIES - 1);
    expect((await store.create({ title: "fits", summary: "s", content: "b", keywords: [] })).id).toBe("M026");
    tmp.leave();
  });

  it("archive: moves out of the active set, refuses stale snapshots, keeps the file", async () => {
    tmp.enter();
    const store = new MemoryStore(path.join(tmp.dir, "arch"));
    const created = await store.create({ title: "T", summary: "s", content: "b", keywords: [] });
    await expect(store.archiveIfUnchanged(created.id, 99)).rejects.toThrow(MemoryConflictError);
    const archived = await store.archiveIfUnchanged(created.id, 1);
    expect(archived.status).toBe("archive");
    expect(fs.existsSync(store.pathOf(created.id, "archive"))).toBe(true);
    expect(fs.existsSync(store.pathOf(created.id, "active"))).toBe(false);
    tmp.leave();
  });

  it("recordAccess: 显式读取计 access_count / last_accessed_at（设计 §8）", async () => {
    tmp.enter();
    const store = new MemoryStore(path.join(tmp.dir, "acc"));
    const created = await store.create({ title: "T", summary: "s", content: "b", keywords: [] });
    await store.recordAccess(created.id);
    const after = store.get(created.id)!;
    expect(after.accessCount).toBe(1);
    expect(after.lastAccessed).toBeDefined();
    tmp.leave();
  });

  it("legacy v2 layout (ordinary/<slug>.md) is imported once into active/M### with the original kept in legacy/", async () => {
    tmp.enter();
    const dir = path.join(tmp.dir, "legacy-import");
    const legacyDir = path.join(dir, "ordinary");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "old-slug.md"),
      `---\nid: old-slug\nrunId: run-9\ntaskType: file-organization\noutcome: success\nkeywords: [csv]\nconfirmations: 0\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-02T00:00:00.000Z\n---\n# Old memory\n\n## 中文摘要\n旧记忆摘要。\n\n## Approach\ndedupe first\n\n## Pitfalls\nnever merge blind\n`,
      "utf8",
    );
    const store = new MemoryStore(dir);
    expect(store.list().map((r) => r.id)).toEqual(["M001"]);
    const imported = store.get("M001")!;
    expect(imported.title).toBe("Old memory");
    expect(imported.summary).toBe("旧记忆摘要。");
    expect(imported.sourceRunId).toBe("run-9");
    expect(fs.existsSync(path.join(dir, "legacy", "old-slug.md"))).toBe(true);
    tmp.leave();
  });
});

// ---------------------------------------------------------------------------
// Core Memory（设计 §5）
// ---------------------------------------------------------------------------

describe("core memory (structured entries, evidence-backed)", () => {
  const file = (): CoreFile => ({
    entries: [
      {
        key: "language",
        content: "Answer in Chinese.",
        reason: "user asked",
        sourceStatement: "以后都用中文",
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
    notes: "",
  });

  it("round-trips through serialize/parse", () => {
    const parsed = parseCore(serializeCore(file()), "test");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.key).toBe("language");
    expect(parsed.entries[0]!.sourceStatement).toBe("以后都用中文");
  });

  it("upsert by key never duplicates and REQUIRES reason + source_statement", () => {
    const upserted = upsertCoreEntry(file(), {
      key: "language",
      content: "Always answer in Chinese.",
      reason: "refined",
      sourceStatement: "以后都用中文回答",
    });
    expect(upserted.entries).toHaveLength(1);
    expect(upserted.entries[0]!.content).toBe("Always answer in Chinese.");
    expect(() => upsertCoreEntry(file(), { key: "k", content: "c", reason: "", sourceStatement: "evidence" })).toThrow(
      /requires "reason"/,
    );
    expect(() => upsertCoreEntry(file(), { key: "k", content: "c", reason: "why", sourceStatement: "" })).toThrow(
      /requires "sourceStatement"/,
    );
  });

  it("injection is trimmed to the token budget (oldest entries dropped first, ≥1 kept)", () => {
    const big: CoreFile = {
      entries: Array.from({ length: 30 }, (_, i) => ({
        key: `k${i}`,
        content: "z".repeat(400),
        reason: "r",
        sourceStatement: "s",
        updated: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      })),
      notes: "",
    };
    const rendered = renderCore(big, 2000 / 8); // 250 tokens ≈ 1000 chars
    const kept = rendered.split("\n").length;
    expect(rendered).toContain("k29"); // newest survives
    expect(rendered).not.toContain("k0"); // oldest dropped
    expect(kept).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(30 * 401);
  });
});

// ---------------------------------------------------------------------------
// 检索 v3（设计 §7）：chunk 投影、RRF、降级链、对账
// ---------------------------------------------------------------------------

describe("memory search v3 (chunk index + degrade chain)", () => {
  it("FTS path ranks memories, records the probed tokenizer, and snippets stay within budget", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "fts", "harness.db");
    const db = openDatabase(dbPath);
    try {
      const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
      await store.create({
        title: "csv dedupe",
        summary: "去重",
        content: "dedupe csv rows before merging",
        keywords: ["csv"],
      });
      await store.create({
        title: "notification",
        summary: "通知",
        content: "send deployment notification to ops",
        keywords: ["deploy"],
      });
      const index = new MemorySearchIndex(db);
      expect(index.reconcile(store)).toBe(2);
      const diag = index.diagnostics();
      expect(diag.fts_tokenizer).toMatch(/trigram|unicode61/);
      expect(diag.schema_version).toBe("3");

      const hits = await index.search(store, "csv dedupe", { limit: 2 });
      expect(hits[0]!.record.title).toBe("csv dedupe");
      expect(hits[0]!.mode).toBe("fts");
      expect(hits[0]!.snippet.length).toBeLessThanOrEqual(360);
    } finally {
      db.close();
    }
    tmp.leave();
  });

  it("degrade chain: no embedder → fts; embedder failure → fts with reason; both dead → empty, never throws", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "degrade", "harness.db");
    const db = openDatabase(dbPath);
    try {
      const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
      const record = await store.create({ title: "T", summary: "s", content: "dedupe csv rows", keywords: [] });
      const index = new MemorySearchIndex(db);
      index.reconcile(store);

      const ftsOnly = await index.search(store, "csv dedupe", { limit: 3 });
      expect(ftsOnly[0]!.mode).toBe("fts");

      // vectors exist (built with a working embedder)…
      const working: import("../src/memory/embedding.js").PassageEmbedder = {
        embedPassages: async (texts) => texts.map(() => [1, 0]),
        embedQuery: async () => [1, 0],
      };
      await index.embedRecord(record, working, "fake-e5");
      expect(index.vectorCount()).toBe(1);

      // …then the embedder dies at query time → the vector path degrades to
      // FTS with an explicit reason instead of failing the search.
      const failing: import("../src/memory/embedding.js").PassageEmbedder = {
        embedPassages: async () => {
          throw new Error("embedding service down");
        },
        embedQuery: async () => {
          throw new Error("embedding service down");
        },
      };
      const degraded = await index.search(store, "csv dedupe", { limit: 3, embedder: failing });
      expect(degraded[0]!.mode).toBe("fts");
      expect(degraded[0]!.degradeReason).toBe("embedding failed");

      const empty = await index.search(store, "zzz nothing here", { limit: 3, embedder: failing });
      expect(empty).toEqual([]);
    } finally {
      db.close();
    }
    tmp.leave();
  });

  it("reconcile is markdown-authoritative: archived/removed memories leave the index; revision bumps re-chunk", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "recon", "harness.db");
    const db = openDatabase(dbPath);
    try {
      const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
      const a = await store.create({ title: "A", summary: "s", content: "alpha content", keywords: [] });
      await store.create({ title: "B", summary: "s", content: "beta content", keywords: [] });
      const index = new MemorySearchIndex(db);
      expect(index.reconcile(store)).toBe(2);

      await store.archiveIfUnchanged(a.id, 1);
      index.reconcile(store);
      const hits = await index.search(store, "alpha OR beta OR content", { limit: 10 });
      expect(hits.find((h) => h.record.id === a.id)).toBeUndefined();
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    tmp.leave();
  });

  it("hybrid: RRF fuses FTS + vector paths; vector covers lexical blind spots (mode=hybrid)", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "hybrid", "harness.db");
    const db = openDatabase(dbPath);
    try {
      const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
      const a = await store.create({
        title: "apple",
        summary: "apples",
        content: "apple handling notes",
        keywords: ["apple"],
      });
      await store.create({ title: "cherry", summary: "cherries", content: "polish the diamond", keywords: ["gem"] });
      const index = new MemorySearchIndex(db);
      index.reconcile(store);

      // deterministic embedder keyed on exact chunk text
      const aChunk = chunkMemory(a)[0]!;
      const embedder = {
        embedPassages: async (texts: readonly string[]) => texts.map((t) => (t === aChunk.text ? [1, 0] : [0, 1])),
        embedQuery: async (t: string) => (t.includes("diamond") ? [0, 1] : [1, 0]),
      };
      await index.embedRecord(store.get(a.id)!, embedder, "fake-model");
      await index.embedRecord(store.get("M002")!, embedder, "fake-model");

      // semantic query with ZERO lexical overlap for "apple handling": the
      // vector channel still surfaces it; both paths fire → mode=hybrid.
      const hits = await index.search(store, "diamond gem", { limit: 2, embedder });
      expect(hits[0]!.record.title).toBe("cherry");
      expect(hits[0]!.mode).toBe("hybrid");
    } finally {
      db.close();
    }
    tmp.leave();
  });

  it("access audit: memory_read-style rows are the UPDATE whitelist, keyed per run", async () => {
    tmp.enter();
    const db = openDatabase(path.join(tmp.dir, "access", "harness.db"));
    try {
      const index = new MemorySearchIndex(db);
      index.recordAccess("run-1", "M001");
      index.recordAccess("run-1", "M002");
      index.recordAccess("run-2", "M003");
      expect(index.readIdsForRun("run-1").sort()).toEqual(["M001", "M002"]);
      expect(index.readIdsForRun("run-2")).toEqual(["M003"]);
    } finally {
      db.close();
    }
    tmp.leave();
  });
});

// ---------------------------------------------------------------------------
// 写入三道闸（设计 §6）：gate → reflector → 授权写入
// ---------------------------------------------------------------------------

describe("reflection gate (deterministic, zero-cost)", () => {
  it("skips chitchat and capability questions, reflects on persistent signals and real work", () => {
    expect(shouldReflect({ task: "记住以后都用 pnpm", toolCalls: [] }).reflect).toBe(true);
    expect(shouldReflect({ task: "以后请先跑测试再提交", toolCalls: [] }).reflect).toBe(true);
    expect(shouldReflect({ task: "what can you do?", toolCalls: [] }).reflect).toBe(false);
    expect(shouldReflect({ task: "你能做什么", toolCalls: [] }).reflect).toBe(false);
    expect(shouldReflect({ task: "帮我看看这个文件", toolCalls: [] }).reflect).toBe(false);
    expect(shouldReflect({ task: "fix the failing test", toolCalls: [{ toolName: "read" }] }).reflect).toBe(true);
    expect(shouldReflect({ task: "", toolCalls: [] }).reflect).toBe(false);
  });
});

describe("reflection decision parsing (strict)", () => {
  it("accepts a well-formed decision and rejects malformed ones", () => {
    const ok = parseReflectionDecision(JSON.stringify({ action: "none", reason: "routine work" }));
    expect(ok.action).toBe("none");
    expect(() => parseReflectionDecision("garbage")).toThrow();
    expect(() => parseReflectionDecision(JSON.stringify({ action: "delete", reason: "x" }))).toThrow(
      /invalid reflection action/,
    );
    expect(() => parseReflectionDecision(JSON.stringify({ action: "none", reason: "" }))).toThrow(/reason/);
    expect(() => parseReflectionDecision(JSON.stringify({ action: "update", id: "M001", reason: "r" }))).toThrow(
      /complete replacement content/,
    );
  });
});

describe("reflectRunById (three gates end to end)", () => {
  async function seedRun(
    prefix: string,
    task: string,
    withToolCall: boolean,
  ): Promise<{ runId: string; dbPath: string }> {
    const dbPath = path.join(tmp.dir, prefix, "harness.db");
    const manager = new RunManager();
    const steps = withToolCall
      ? [
          assistantMessage(
            [{ type: "toolCall", id: "c1", name: "read_file", arguments: { path: "a.txt" } }],
            "toolUse",
          ),
          assistantMessage([{ type: "text", text: "done" }], "stop"),
        ]
      : [assistantMessage([{ type: "text", text: "done" }], "stop")];
    const result = await manager.run({
      task,
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(steps),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: withToolCall ? undefined : [],
    });
    manager.close();
    return { runId: result.record.id, dbPath };
  }

  it("gate skips a chitchat run without any model call; --force bypasses the gate", async () => {
    const { runId, dbPath } = await seedRun("gate-skip", "what can you do?", false);
    const outcome = await reflectRunById(runId, {
      database: dbPath,
      complete: async () => {
        throw new Error("model must not be called for a gated-out run");
      },
    });
    expect(outcome.action).toBe("skipped");
    const forced = await reflectRunById(runId, {
      database: dbPath,
      force: true,
      complete: async () => JSON.stringify({ action: "none", reason: "nothing durable" }),
    });
    expect(forced.action).toBe("none");
  });

  it("create: a real-work run produces M001 with provenance; INDEX.md is rebuilt", async () => {
    const { runId, dbPath } = await seedRun("create", "organize the quarterly reports", true);
    const outcome = await reflectRunById(runId, {
      database: dbPath,
      complete: async () =>
        JSON.stringify({
          action: "create",
          title: "Report organization",
          summary: "整理季度报告。",
          content: "dedupe csv rows before merging",
          keywords: ["csv", "reports"],
          reason: "reusable workflow",
        }),
    });
    expect(outcome.action).toBe("created");
    if (outcome.action === "created") {
      expect(outcome.record.id).toBe("M001");
      expect(outcome.record.sourceRunId).toBe(runId);
      expect(fs.existsSync(outcome.file)).toBe(true);
    }
  });

  it("update authorization: without memory_read the update is REJECTED (mechanism, not prompt)", async () => {
    const { runId, dbPath } = await seedRun("whitelist", "organize reports again", true);
    const outcome = await reflectRunById(runId, {
      database: dbPath,
      complete: async (messages) => {
        const prompt = messages[0]!.content;
        expect(prompt).toContain("Capacity: active 0/25");
        return JSON.stringify({
          action: "update",
          id: "M001",
          title: "T",
          summary: "s",
          content: "complete replacement",
          reason: "attempted without read",
        });
      },
    });
    expect(outcome.action).toBe("rejected");
    expect(outcome.reason).toContain("not authorized");
  });

  it("update: after the run READ the memory, full replacement applies with a revision bump", async () => {
    const { runId, dbPath } = await seedRun("whitelist-ok", "organize reports once more", true);
    const db = openDatabase(dbPath);
    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    const created = await store.create({
      title: "Old",
      summary: "旧",
      content: "old body; cap is 10 rows",
      keywords: [],
    });
    const index = new MemorySearchIndex(db);
    // the mechanism memory_read performs: count access + arm the whitelist
    await store.recordAccess(created.id);
    index.recordAccess(runId, created.id);
    db.close();

    const outcome = await reflectRunById(runId, {
      database: dbPath,
      complete: async () =>
        JSON.stringify({
          action: "update",
          id: created.id,
          title: "Old (refined)",
          summary: "精炼后",
          content: "new complete body; cap is 10 rows; never merge blind",
          keywords: ["refined"],
          reason: "second run refined the workflow",
        }),
    });
    expect(outcome.action).toBe("updated");
    if (outcome.action === "updated") {
      expect(outcome.record.revision).toBe(2);
      expect(outcome.record.content).toContain("never merge blind");
    }
  });
});

// ---------------------------------------------------------------------------
// digest（保留自 v2 的行为）
// ---------------------------------------------------------------------------

describe("run digest", () => {
  it("captures tool calls, error flags and final text", () => {
    const messages = [
      { role: "user", content: "go", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "write_file", arguments: { path: "x" } }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "write_file",
        content: [{ type: "text", text: "wrote" }],
        isError: false,
        timestamp: 3,
      },
    ] as never[];
    const digest = buildRunDigest({ id: "r", task: "go", modelSpec: "m", status: "completed" }, messages);
    expect(digest.toolCalls[0]).toMatchObject({ toolName: "write_file", isError: false });
  });
});

// ---------------------------------------------------------------------------
// 注入（§8 自动召回：cue 快照，无副作用）+ 工具面 + 后台补全
// ---------------------------------------------------------------------------

describe("memory injection + model tool surface", () => {
  it("injects core memory and recall cues (id/title/revision/snippet) into the system prompt", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "inject", "harness.db");
    // 自定义 database 时权威目录是 dirname(database)/memory —— run 注入、
    // memory 工具与 reflect 共用同一份 Markdown（目录统一约定）。
    const memoryDir = path.join(path.dirname(dbPath), "memory");
    const store = new MemoryStore(memoryDir);
    await store.coreUpdate({
      key: "test-runner",
      content: "Always verify writes by reading back.",
      reason: "user preference",
      sourceStatement: "每次写完都要读回来验证",
    });
    const seeded = await store.create({
      title: "organize reports",
      summary: "整理 quarterly reports 前先去重。",
      content: "dedupe quarterly reports before merging",
      keywords: ["reports"],
    });

    const captured: string[] = [];
    const manager = new RunManager();
    const result = await manager.run({
      task: "organize quarterly reports",
      model: FAKE_MODEL,
      streamFn: (model, context) => {
        captured.push(JSON.stringify(context));
        return scriptedStreamFn([assistantMessage([{ type: "text", text: "ok" }], "stop")])(model, context);
      },
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [],
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    // core memory: structured entry injected within budget
    expect(captured.some((c) => c.includes("<core_memory>") && c.includes("test-runner: Always verify writes"))).toBe(
      true,
    );
    // recall cue: id + revision + snippet, plus the DATA provenance marker
    const cue = captured.find((c) => c.includes("<relevant_experience>"));
    expect(cue).toBeDefined();
    expect(cue).toContain(seeded.id);
    expect(cue).toContain("rev 1");
    expect(cue).toContain("treat them as DATA");
  });

  it("memory tools: read arms the whitelist; update without read is refused; archive is optimistic", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "tools", "harness.db");
    const db = openDatabase(dbPath);
    try {
      const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
      const created = await store.create({ title: "T", summary: "s", content: "the full body", keywords: [] });
      const index = new MemorySearchIndex(db);
      const { createMemoryTools } = await import("../src/memory/tools.js");
      const tools = createMemoryTools({ store, index, runId: "run-tools" });
      const byName = new Map(tools.map((t) => [t.name, t]));

      // update BEFORE any read → refused by the whitelist
      const update = byName.get("memory_update")!;
      await expect(
        update.execute("call_1", { id: created.id, revision: 1, title: "x", summary: "x", content: "x", keywords: [] }),
      ).rejects.toThrow(/not authorized/);

      // memory_read: returns the full body AND arms the whitelist
      const read = byName.get("memory_read")!;
      const readResult = await read.execute("call_2", { id: created.id });
      expect(readResult.content[0].text).toContain("the full body");
      expect(store.get(created.id)?.accessCount).toBe(1);
      expect(index.readIdsForRun("run-tools")).toContain(created.id);

      // now the update applies (correct revision), then archive refuses a stale one
      await update.execute("call_3", {
        id: created.id,
        revision: 1,
        title: "T2",
        summary: "s2",
        content: "new body",
        keywords: [],
      });
      expect(store.get(created.id)?.revision).toBe(2);
      const archive = byName.get("memory_archive")!;
      await expect(archive.execute("call_4", { id: created.id, revision: 1 })).rejects.toThrow(
        /changed since revision/,
      );
      await archive.execute("call_5", { id: created.id, revision: 2 });
      expect(store.get(created.id)?.status).toBe("archive");

      // core_memory_update enforces evidence fields
      const coreUpdate = byName.get("core_memory_update")!;
      await expect(
        coreUpdate.execute("call_6", { key: "k", content: "c", reason: "why", source_statement: "" }),
      ).rejects.toThrow(/sourceStatement/);
      await coreUpdate.execute("call_7", { key: "k", content: "c", reason: "why", source_statement: "user said" });
      expect(store.readCoreFile()?.entries[0]?.key).toBe("k");
    } finally {
      db.close();
    }
    tmp.leave();
  });

  it("embedding backfill: completes in the background with a status state machine", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "backfill", "harness.db");
    const db = openDatabase(dbPath);
    try {
      const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
      const created = await store.create({ title: "T", summary: "s", content: "some body text", keywords: [] });
      const index = new MemorySearchIndex(db);
      index.reconcile(store);

      let calls = 0;
      const embedder = {
        embedPassages: async (texts: readonly string[]) => {
          calls += texts.length;
          return texts.map(() => [0.5, 0.5]);
        },
        embedQuery: async () => [0.5, 0.5],
      };
      const backfill = index.startBackfill(store, embedder, "fake-e5", { baseDelayMs: 1 });
      await backfill.promise;
      expect(backfill.status).toBe("complete");
      expect(backfill.pending).toBe(0);
      expect(calls).toBe(1); // exactly the one chunk
      expect(index.vectorCount()).toBe(1);

      // 条件写：revision bump 改变了 chunk 文本 → 旧向量不得覆盖新 chunk
      await store.updateIfRevision(created.id, 1, {
        title: "T2",
        summary: "s2",
        content: "rewritten body",
        keywords: [],
      });
      index.reconcile(store);
      expect(index.backfillPending("fake-e5")).toBe(1);
    } finally {
      db.close();
    }
    tmp.leave();
  });

  it("reconcile preserves vectors for sha-identical chunks and drops them when the content changes", async () => {
    // §9.3 条件写语义的另一半：启动对账绝不清空已建好的 embedding。
    tmp.enter();
    const dbPath = path.join(tmp.dir, "vec-persist", "harness.db");
    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    const created = await store.create({ title: "T", summary: "s", content: "stable body text", keywords: [] });

    const db1 = openDatabase(dbPath);
    try {
      const index1 = new MemorySearchIndex(db1);
      index1.reconcile(store);
      const embedder = {
        embedPassages: async (texts: readonly string[]) => texts.map(() => [1, 0]),
        embedQuery: async () => [1, 0],
      };
      await index1.embedRecord(created, embedder, "fake-e5");
      expect(index1.vectorCount()).toBe(1);
    } finally {
      db1.close();
    }

    // reopen (fresh connection — the run-startup path) + reconcile: the vector
    // MUST survive the sha-identical re-sync.
    const db2 = openDatabase(dbPath);
    try {
      const index2 = new MemorySearchIndex(db2);
      expect(index2.vectorCount()).toBe(1);
      index2.reconcile(store);
      expect(index2.vectorCount()).toBe(1); // ← the regression this locks
      expect(index2.backfillPending("fake-e5")).toBe(0);

      // content change → new sha → the stale vector is dropped, chunk re-queues
      await store.updateIfRevision(created.id, 1, {
        title: "T",
        summary: "s",
        content: "changed body text",
        keywords: [],
      });
      index2.reconcile(store);
      expect(index2.vectorCount()).toBe(0);
      expect(index2.backfillPending("fake-e5")).toBe(1);
    } finally {
      db2.close();
    }
    tmp.leave();
  });

  it("memory tools run through the wrapper chain and read the run's own memory dir", async () => {
    // 两个 P2 回归一起锁：① memory 工具过 composeRuntime（evidence 落盘）；
    // ② 自定义 database 时权威目录是 dirname(database)/memory（与 reflect 一致）。
    tmp.enter();
    const dbPath = path.join(tmp.dir, "chain", "harness.db");
    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    const seeded = await store.create({
      title: "T",
      summary: "s",
      content: "the full body content marker",
      keywords: [],
    });

    const manager = new RunManager();
    const result = await manager.run({
      task: "read the memory",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([
        assistantMessage(
          [{ type: "toolCall", id: "call_mem", name: "memory_read", arguments: { id: seeded.id } }],
          "toolUse",
        ),
        assistantMessage([{ type: "text", text: "read it" }], "stop"),
      ]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: "coding", // memory tools join by default
    });
    manager.close();

    // the model saw the memory body through memory_read
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.isError).toBe(false);
      expect(toolResult.content.some((b) => b.type === "text" && b.text.includes("the full body content marker"))).toBe(
        true,
      );
    }
    // evidence capture (the wrapper chain) persisted the full result
    const evidenceDir = path.join(tmp.dir, ".harness", "evidence", result.record.id);
    const files = fs.existsSync(evidenceDir) ? fs.readdirSync(evidenceDir) : [];
    const evidence = files
      .filter((f) => f.endsWith(".md"))
      .map((f) => fs.readFileSync(path.join(evidenceDir, f), "utf8"))
      .find((text) => text.includes("the full body content marker"));
    expect(evidence).toBeDefined();
    tmp.leave();
  });
});

// ---------------------------------------------------------------------------
// P0-1/P1-3/P1-4/P2-5 批次：向量路接通、boost 排序、版本历史、原子认领
// ---------------------------------------------------------------------------

describe("hybrid recall wired into runs (向量路接通)", () => {
  it("(a) with vectors, the run-start recall fires the vector path (hybrid)", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "hybrid-run", "harness.db");
    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    const seeded = await store.create({
      title: "gem protocol",
      summary: "gem evaluation notes",
      content: "gem evaluation protocol details",
      keywords: ["gem"],
    });

    const db = openDatabase(dbPath);
    const index = new MemorySearchIndex(db);
    index.reconcile(store);
    // deterministic embedder: the chunk vector matches the QUERY vector —
    // the lexical path matches too (title carries "gem"), so both fire.
    let queryEmbeds = 0;
    const fake = {
      embedPassages: async (texts: readonly string[]) => texts.map(() => [0, 1]),
      embedQuery: async () => {
        queryEmbeds++;
        return [0, 1];
      },
    };
    await index.embedRecord(seeded, fake, "fake-e5");
    db.close();

    const captured: string[] = [];
    const manager = new RunManager();
    const result = await manager.run({
      task: "gem evaluation",
      model: FAKE_MODEL,
      streamFn: (model, context) => {
        captured.push(JSON.stringify(context));
        return scriptedStreamFn([assistantMessage([{ type: "text", text: "ok" }], "stop")])(model, context);
      },
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [],
      memory: { embedder: fake },
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    expect(queryEmbeds).toBe(1); // the vector path actually fired (exactly one query embedding)
    expect(captured.some((c) => c.includes("<relevant_experience>") && c.includes(seeded.id))).toBe(true);
  });

  it("(b) without vectors the retrieval path costs zero model calls; backfill runs after the run", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "no-vec", "harness.db");
    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    await store.create({ title: "T", summary: "s", content: "dedupe csv rows", keywords: [] });

    const db = openDatabase(dbPath);
    const index = new MemorySearchIndex(db);
    index.reconcile(store);
    expect(index.vectorCount()).toBe(0);
    db.close();

    let queryEmbeds = 0;
    const counting = {
      embedPassages: async (texts: readonly string[]) => texts.map(() => [1, 0]),
      embedQuery: async () => {
        queryEmbeds++;
        return [1, 0];
      },
    };
    const manager = new RunManager();
    const result = await manager.run({
      task: "dedupe csv rows",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "ok" }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [],
      memory: { embedder: counting },
    });
    expect(result.record.status).toBe("completed");
    expect(queryEmbeds).toBe(0); // 检索路零成本：无向量时从不触碰模型

    // run 结束后的 backfill 触发点：drain 后向量就绪（下一次 run 召回 hybrid）
    await manager.drainMemoryBackfill();
    const db2 = openDatabase(dbPath);
    try {
      const index2 = new MemorySearchIndex(db2);
      expect(index2.vectorCount()).toBe(1);
      expect(index2.backfillPending(EMBEDDING_MODEL_ID)).toBe(0);
    } finally {
      db2.close();
    }
    tmp.leave();
  });

  it("(c) memory_search walks the vector path with no degrade reason", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "tool-hybrid", "harness.db");
    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    const created = await store.create({
      title: "gem protocol",
      summary: "gem evaluation",
      content: "gem evaluation protocol",
      keywords: ["gem"],
    });
    const db = openDatabase(dbPath);
    try {
      const index = new MemorySearchIndex(db);
      index.reconcile(store);
      const fake = {
        embedPassages: async (texts: readonly string[]) => texts.map(() => [0, 1]),
        embedQuery: async () => [0, 1],
      };
      await index.embedRecord(created, fake, "fake-e5");

      const { createMemoryTools } = await import("../src/memory/tools.js");
      const tools = createMemoryTools({ store, index, runId: "run-x", embedder: () => fake });
      const search = tools.find((t) => t.name === "memory_search")!;
      const out = await search.execute("c1", { query: "gem evaluation" });
      expect(out.details).toMatchObject({ mode: "hybrid", degradeReason: undefined });
    } finally {
      db.close();
    }
    tmp.leave();
  });

  it("(d) a throwing embedder degrades to FTS — the run is unaffected", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "throw-embed", "harness.db");
    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    const seeded = await store.create({
      title: "organize reports",
      summary: "整理 quarterly reports 前先去重。",
      content: "dedupe quarterly reports before merging",
      keywords: ["reports"],
    });
    const db = openDatabase(dbPath);
    {
      const index = new MemorySearchIndex(db);
      index.reconcile(store);
    }
    db.close();

    const throwing = {
      embedPassages: async () => {
        throw new Error("embedding service down");
      },
      embedQuery: async () => {
        throw new Error("embedding service down");
      },
    };
    const captured: string[] = [];
    const manager = new RunManager();
    const result = await manager.run({
      task: "organize quarterly reports",
      model: FAKE_MODEL,
      streamFn: (model, context) => {
        captured.push(JSON.stringify(context));
        return scriptedStreamFn([assistantMessage([{ type: "text", text: "ok" }], "stop")])(model, context);
      },
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [],
      memory: { embedder: throwing },
    });
    manager.close();
    expect(result.record.status).toBe("completed"); // 降级而非失败
    expect(captured.some((c) => c.includes("<relevant_experience>") && c.includes(seeded.id))).toBe(true);
  });
});

describe("digest error attribution by toolCallId", () => {
  it("same tool called twice: only the FAILED call is flagged, even out of order", () => {
    const messages = [
      { role: "user", content: "go", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "read_file", arguments: { path: "a" } },
          { type: "toolCall", id: "c2", name: "read_file", arguments: { path: "b" } },
        ],
        timestamp: 2,
      },
      // results arrive in REVERSE order — id pairing must not care
      {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "read_file",
        content: [{ type: "text", text: "boom" }],
        isError: true,
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read_file",
        content: [{ type: "text", text: "fine" }],
        isError: false,
        timestamp: 4,
      },
    ] as never[];
    const digest = buildRunDigest({ id: "r", task: "go", modelSpec: "m", status: "completed" }, messages);
    expect(digest.toolCalls[0]).toMatchObject({ toolName: "read_file", isError: false }); // c1
    expect(digest.toolCalls[1]).toMatchObject({ toolName: "read_file", isError: true }); // c2
  });
});

describe("accessCount ranking boost (bounded multiplicative)", () => {
  async function seededPair(
    dbPath: string,
  ): Promise<{ store: MemoryStore; a: string; b: string; db: DatabaseSync; index: MemorySearchIndex }> {
    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    // identical-length bodies, same term frequency → bm25 tie on the shared term
    const a = await store.create({
      title: "tie-a",
      summary: "s",
      content: "memory-aaa target words align here",
      keywords: ["target"],
    });
    const b = await store.create({
      title: "tie-b",
      summary: "s",
      content: "memory-bbb target words align here",
      keywords: ["target"],
    });
    const db = openDatabase(dbPath);
    const index = new MemorySearchIndex(db);
    index.reconcile(store);
    return { store, a: a.id, b: b.id, db, index };
  }

  it("accessCount=0 → boost 1.0 and the original tie order stands", async () => {
    tmp.enter();
    const { store, a, b, db, index } = await seededPair(path.join(tmp.dir, "boost0", "harness.db"));
    try {
      const hits = await index.search(store, "target", { limit: 5 });
      expect(hits.map((h) => h.record.id)).toEqual([a, b]);
      expect(hits.every((h) => h.boost === 1)).toBe(true);
    } finally {
      db.close();
    }
    tmp.leave();
  });

  it("higher accessCount outranks an equal-FTS memory; the boost is capped at 1.30", async () => {
    tmp.enter();
    const { store, a, b, db, index } = await seededPair(path.join(tmp.dir, "boost1", "harness.db"));
    try {
      for (let i = 0; i < 100; i++) await store.recordAccess(b); // log2(101) > cap
      const hits = await index.search(store, "target", { limit: 5 });
      expect(hits[0]!.record.id).toBe(b); // 热门者排前
      expect(hits[0]!.boost).toBe(1.3); // 硬封顶：1 + 0.15 × 2
      expect(hits[1]!.record.id).toBe(a);
      expect(hits[1]!.boost).toBe(1);
    } finally {
      db.close();
    }
    tmp.leave();
  });
});

describe("memory version history (last 5, FIFO)", () => {
  it("7 consecutive updates leave exactly the latest 5 revisions, all parseable", async () => {
    tmp.enter();
    const store = new MemoryStore(path.join(tmp.dir, "hist", "memory"));
    const created = await store.create({ title: "v0", summary: "s", content: "body 0", keywords: [] });
    for (let i = 1; i <= 7; i++) {
      await store.updateIfRevision(created.id, i, {
        title: `v${i}`,
        summary: "s",
        content: `body ${i}`,
        keywords: [],
      });
    }
    const files = fs.readdirSync(path.join(tmp.dir, "hist", "memory", "history", created.id)).sort();
    expect(files).toEqual(["rev3.md", "rev4.md", "rev5.md", "rev6.md", "rev7.md"]);
    const versions = store.history(created.id);
    expect(versions.map((v) => v.revision)).toEqual([7, 6, 5, 4, 3]); // 降序
    // rev{n} 快照的是第 n 次替换前的内容：rev7 = 第 7 次 update 之前的 body 6
    expect(versions[0]!.content).toBe("body 6");
    expect(versions[4]!.content).toBe("body 2");
    // 历史文件可被 parseMemory 完整解析（store.history 走同一解析路径）
    // 当前版本仍在 active：第 7 次替换后 = rev8 = "body 7"
    expect(store.get(created.id)?.revision).toBe(8);
    expect(store.get(created.id)?.content).toBe("body 7");
    tmp.leave();
  });

  it("archive snapshots the pre-archive version into history too", async () => {
    tmp.enter();
    const store = new MemoryStore(path.join(tmp.dir, "hist-arch", "memory"));
    const created = await store.create({ title: "T", summary: "s", content: "pre-archive body", keywords: [] });
    await store.archiveIfUnchanged(created.id, 1);
    const versions = store.history(created.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.revision).toBe(1);
    expect(versions[0]!.content).toBe("pre-archive body");
    tmp.leave();
  });
});

describe("cross-process atomic id claim", () => {
  it("a claimed placeholder id is skipped (EEXIST retry) and left untouched", async () => {
    tmp.enter();
    const dir = path.join(tmp.dir, "claim", "memory");
    const store = new MemoryStore(dir);
    // Simulate another process's crashed/claimed M001: a 0-byte placeholder.
    fs.mkdirSync(path.join(dir, "active"), { recursive: true });
    fs.closeSync(fs.openSync(path.join(dir, "active", "M001.md"), "w"));

    const record = await store.create({ title: "T", summary: "s", content: "b", keywords: [] });
    expect(record.id).toBe("M002"); // EEXIST → nextId+1 retry
    // the placeholder is still there, unmodified, and reads as absent
    expect(fs.statSync(path.join(dir, "active", "M001.md")).size).toBe(0);
    expect(store.get("M001")).toBeUndefined();
    expect(store.get("M002")?.title).toBe("T");
    // the next create continues after the claimed max
    expect((await store.create({ title: "U", summary: "s", content: "b", keywords: [] })).id).toBe("M003");
    tmp.leave();
  });
});
