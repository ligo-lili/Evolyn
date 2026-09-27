import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/db.js";
import { RunRepo } from "../src/storage/repos/runs.js";
import { MemoryStore } from "../src/memory/store.js";
import { MemorySearchIndex } from "../src/memory/search.js";
import { parseMemory, serializeMemory, type MemoryRecord } from "../src/memory/model.js";
import { buildRunDigest, distillRunById } from "../src/memory/distiller.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";

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

describe("memory model + markdown store (阶段 9.5)", () => {
  it("serializes to markdown with frontmatter and parses back losslessly", () => {
    const record = mkRecord();
    const raw = serializeMemory(record);
    expect(raw.startsWith("---")).toBe(true);
    const parsed = parseMemory(raw, "test");
    expect(parsed).toEqual(record);
  });

  it("store: save/get/list/core roundtrip over authoritative .md files", () => {
    tmp.enter();
    const store = new MemoryStore(path.join(tmp.dir, "mem"));
    store.writeCore("# Core Memory\n\nAlways use pnpm.\n");
    expect(store.readCore()).toContain("Always use pnpm");

    const a = mkRecord({ id: "mem-a", keywordsEn: ["csv", "dedupe"] });
    const b = mkRecord({ id: "mem-b", taskType: "notification", summaryEn: "Sent ops notification." });
    const fileA = store.save(a);
    store.save(b);
    expect(fs.existsSync(fileA)).toBe(true);
    expect(store.get("mem-a")?.summaryEn).toContain("dedupe");
    expect(store.list().map((m) => m.id).sort()).toEqual(["mem-a", "mem-b"]);
    expect(fs.readFileSync(fileA, "utf8")).toContain("## 中文摘要");
    tmp.leave();
  });
});

describe("memory search index (derived, rebuildable)", () => {
  it("searches, and rebuilds from markdown after the index is wiped", () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "idx", "harness.db");
    const db = openDatabase(dbPath);
    try {
      new RunRepo(db).insert({ id: "seed", task: "seed", modelSpec: "test/fake-model", status: "completed", startedAt: new Date().toISOString() });
      const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
      const index = new MemorySearchIndex(db);

      store.save(mkRecord({ id: "csv-mem" }));
      store.save(mkRecord({ id: "notify-mem", taskType: "notification", summaryEn: "Sent deployment notification to ops.", keywordsEn: ["notification", "deploy", "ops"] }));
      index.rebuild(store);
      expect(index.count()).toBe(2);

      const hits = index.searchFts("csv dedupe reports", 3);
      expect(hits[0]?.id).toBe("csv-mem");

      // wipe the derived index and rebuild from the authoritative files
      index.reset();
      expect(index.count()).toBe(0);
      expect(index.rebuild(store)).toBe(2);
      expect(index.searchFts("deployment notification")[0]?.id).toBe("notify-mem");
    } finally {
      db.close();
    }
    tmp.leave();
  });
});

describe("write-time reflection (阶段 9.5)", () => {
  it("creates a new memory on first distill, then confirms (updateOf) instead of duplicating", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "reflect", "harness.db");
    const manager = new RunManager();
    const result = await manager.run({
      task: "organize quarterly reports",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([
        assistantMessage([{ type: "text", text: "done" }], "stop"),
      ]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [],
    });
    manager.close();

    const first = await distillRunById(result.record.id, {
      database: dbPath,
      complete: async () =>
        JSON.stringify({ taskType: "file-organization", summaryEn: "Organized reports.", summaryZh: "整理报告。", approach: "manual", pitfalls: "none", outcome: "success", keywordsEn: ["reports"] }),
    });
    expect(first.merged).toBe(false);
    expect(fs.existsSync(first.file)).toBe(true);

    // second, similar run → the distiller sees the candidate and sets updateOf
    const manager2 = new RunManager();
    const result2 = await manager2.run({
      task: "organize quarterly reports again",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "done again" }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [],
    });
    manager2.close();

    const second = await distillRunById(result2.record.id, {
      database: dbPath,
      complete: async (messages) => {
        expect(messages.map((m) => m.content).join("\n")).toContain("EXISTING memory candidates");
        return JSON.stringify({
          updateOf: first.record.id,
          taskType: "file-organization",
          summaryEn: "Organized reports (refined by second run).",
          summaryZh: "整理报告（第二次运行精炼）。",
          approach: "manual",
          pitfalls: "none",
          outcome: "success",
          keywordsEn: ["reports", "quarterly"],
        });
      },
    });

    expect(second.merged).toBe(true);
    expect(second.record.id).toBe(first.record.id); // same memory, original provenance
    expect(second.record.confirmations).toBe(1);
    expect(second.record.runId).toBe(result.record.id); // original run preserved
    expect(second.record.keywordsEn).toEqual(["reports", "quarterly"]);

    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    expect(store.list()).toHaveLength(1);
    tmp.leave();
  });

  it("digest captures tool calls, error flags and final text", () => {
    const messages = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write_file", arguments: { path: "x" } }], timestamp: 2 },
      { role: "toolResult", toolCallId: "c1", toolName: "write_file", content: [{ type: "text", text: "wrote" }], isError: false, timestamp: 3 },
    ] as never[];
    const digest = buildRunDigest({ id: "r", task: "go", modelSpec: "m", status: "completed" }, messages);
    expect(digest.toolCalls[0]).toMatchObject({ toolName: "write_file", isError: false });
  });
});

describe("memory injection into runs (阶段 9.5)", () => {
  it("injects core memory and ordinary pointers into the system prompt", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "inject", "harness.db");
    const memoryDir = path.join(tmp.dir, ".harness", "memory");
    const store = new MemoryStore(memoryDir);
    store.writeCore("Always verify file writes by reading them back.\n");
    store.save(mkRecord({ id: "inject-mem", summaryZh: "整理报告前先去重。" }));

    const db = openDatabase(dbPath);
    new RunRepo(db).insert({ id: "seed", task: "seed", modelSpec: "test/fake-model", status: "completed", startedAt: new Date().toISOString() });
    new MemorySearchIndex(db).rebuild(store);
    db.close();

    const captured: string[] = [];
    const manager = new RunManager();
    const result = await manager.run({
      task: "organize reports",
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
    expect(captured.some((c) => c.includes("<core_memory>") && c.includes("verify file writes"))).toBe(true);
    expect(captured.some((c) => c.includes("<relevant_experience>") && c.includes("inject-mem"))).toBe(true);
    tmp.leave();
  });
});
