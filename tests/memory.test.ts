import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/db.js";
import { RunRepo } from "../src/storage/repos/runs.js";
import { ExperienceRepo, newExperienceId, type ExperienceRecord } from "../src/memory/store.js";
import { buildRunDigest, distillExperience, distillRunById, fallbackDraft, parseExperienceDraft } from "../src/memory/distiller.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { sendNotificationTool } from "../src/runtime/tools/send-notification.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";

const tmp = makeTempCwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

const DIGEST = {
  runId: "run-1",
  task: "organize quarterly reports and dedupe csv rows",
  modelSpec: "test/fake-model",
  status: "completed",
  toolCalls: [{ toolName: "write_file", args: { path: "q3.csv" }, isError: false }],
  finalAssistantText: "done",
};

const GOOD_JSON = JSON.stringify({
  taskType: "file-organization",
  summaryEn: "Organized quarterly reports and deduplicated csv rows before merging.",
  summaryZh: "整理了季度报告，并在合并前对 csv 去重。",
  approach: "Read the exports first, dedupe rows by key, then write merged output.",
  pitfalls: "Do not merge before deduplicating — duplicates compound.",
  outcome: "success",
  keywordsEn: ["csv", "dedupe", "reports", "quarterly"],
});

describe("experience distiller (阶段 9)", () => {
  it("parses strict JSON drafts and normalizes fields", async () => {
    const draft = await distillExperience(DIGEST, async () => GOOD_JSON);
    expect(draft.taskType).toBe("file-organization");
    expect(draft.summaryZh).toContain("csv");
    expect(draft.outcome).toBe("success");
    expect(draft.keywordsEn).toEqual(["csv", "dedupe", "reports", "quarterly"]);
  });

  it("falls back to a naive draft when the model output is garbage", async () => {
    const draft = await distillExperience(DIGEST, async () => "I think it went fine overall.");
    expect(draft.taskType).toBe("uncategorized");
    expect(draft.outcome).toBe("success");
    expect(draft.keywordsEn.length).toBeGreaterThan(0);

    const failed = fallbackDraft({ ...DIGEST, status: "failed", error: "boom" });
    expect(failed.outcome).toBe("failed");
  });

  it("builds the run digest from transcript messages (tool calls + errors + final text)", () => {
    const messages = [
      { role: "user", content: "send it", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "send_notification", arguments: { channel: "ops" } }], timestamp: 2 },
      { role: "toolResult", toolCallId: "c1", toolName: "send_notification", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "sent" }], timestamp: 4 },
    ] as never[];
    const digest = buildRunDigest({ id: "r", task: "send it", modelSpec: "m", status: "completed" }, messages);
    expect(digest.toolCalls).toEqual([{ toolName: "send_notification", args: { channel: "ops" }, isError: false }]);
    expect(digest.finalAssistantText).toBe("sent");
  });
});

describe("experience store (FTS5)", () => {
  it("ranks relevant experience first and respects the limit", () => {
    tmp.enter();
    const db = openDatabase(path.join(tmp.dir, "exp", "harness.db"));
    try {
      // experiences.run_id → runs(id): seed the referenced run row first.
      new RunRepo(db).insert({ id: "seed", task: "seed task", modelSpec: "test/fake-model", status: "completed", startedAt: new Date().toISOString() });
      const repo = new ExperienceRepo(db);
      const seed: Array<[string, string, string, string]> = [
        // [taskType, summaryEn, keywords, summaryZh]
        ["file-organization", "Organized quarterly reports; dedupe csv rows before merging.", "csv dedupe reports quarterly organize", "整理季度报告，合并前 csv 去重"],
        ["notification", "Sent deployment notification to the ops channel.", "notification deploy ops", "向 ops 发送部署通知"],
        ["code-fix", "Fixed failing lint errors across src.", "lint fix code errors", "修复 src 的 lint 错误"],
        ["data-processing", "Generated a csv summary from raw exports after removing duplicate rows.", "csv duplicate rows summary export", "从原始导出生成 csv 摘要，先去重"],
        ["documentation", "Read config files and wrote the changelog.", "changelog config read docs", "读配置写变更日志"],
        ["file-organization", "Backed up the data folder before cleanup.", "backup cleanup data folder", "清理前备份数据目录"],
      ];
      for (const [taskType, summaryEn, keywordsEn, summaryZh] of seed) {
        const record: ExperienceRecord = {
          id: newExperienceId(),
          runId: "seed",
          taskType,
          summaryEn,
          summaryZh,
          approach: "n/a",
          pitfalls: "n/a",
          outcome: "success",
          keywordsEn,
          createdAt: new Date().toISOString(),
        };
        repo.insert(record);
      }
      expect(repo.count()).toBe(6);

      const csvHits = repo.search("csv duplicate rows", 3);
      expect(csvHits.length).toBeGreaterThan(0);
      expect(csvHits[0]!.summaryEn.toLowerCase()).toContain("csv");
      expect(csvHits.length).toBeLessThanOrEqual(3);

      const notifyHits = repo.search("deployment notification ops", 3);
      expect(notifyHits[0]!.taskType).toBe("notification");

      expect(repo.search("")).toEqual([]);
    } finally {
      db.close();
    }
    tmp.leave();
  });

  it("distillRunById stores an experience for a finished run (fake completion, no API key)", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "e2e", "harness.db");
    const manager = new RunManager();
    const result = await manager.run({
      task: "send a notification and confirm",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([
        assistantMessage([{ type: "toolCall", id: "c1", name: "send_notification", arguments: { channel: "email", message: "hi" } }], "toolUse"),
        assistantMessage([{ type: "text", text: "sent" }], "stop"),
      ]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [sendNotificationTool],
    });
    manager.close();
    expect(result.record.status).toBe("completed");

    const record = await distillRunById(result.record.id, {
      database: dbPath,
      complete: async () => GOOD_JSON,
    });
    expect(record.taskType).toBe("file-organization");

    const db = openDatabase(dbPath);
    try {
      const repo = new ExperienceRepo(db);
      expect(repo.count()).toBe(1);
      expect(repo.search("csv dedupe reports")[0]?.runId).toBe(result.record.id);
    } finally {
      db.close();
    }
    tmp.leave();
  });
});
