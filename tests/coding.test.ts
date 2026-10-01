import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/storage/db.js";
import { RunRepo } from "../src/storage/repos/runs.js";
import { TraceEventRepo } from "../src/storage/repos/trace-events.js";
import { CheckpointRepo } from "../src/storage/repos/checkpoints.js";
import { readTraceFile } from "../src/trace/read.js";
import { reconcileJsonlTrace } from "../src/trace/reconcile.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { DEFAULT_RUN_LIMITS, LimitEnforcer, type LimitViolation } from "../src/runtime/limits.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { createCodingToolset } from "../src/runtime/tools/coding.js";
import { permissionsFor } from "../src/runtime/permissions.js";
import { createPermissionGate } from "../src/runtime/approval.js";
import { writeFileTool } from "../src/runtime/tools/write-file.js";
import { findCutIndex } from "../src/context/compaction.js";
import { buildWorkspaceTree } from "../src/context/workspace.js";
import { MemoryStore } from "../src/memory/store.js";
import { parseMemory, MEMORY_ID_PATTERN } from "../src/memory/model.js";
import { distillRunById } from "../src/memory/distiller.js";
import { promoteCandidate } from "../src/skills/promote.js";
import { SkillIndex } from "../src/skills/retrieve.js";
import { serializeSkillMd } from "../src/skills/format.js";
import { parseArgs } from "../src/cli/parse-args.js";
import { withPathFence } from "../src/runtime/tools/fence.js";
import { withEvidenceCapture } from "../src/runtime/tools/evidence.js";
import { TraceRecorder, type TraceSink } from "../src/trace/recorder.js";
import { FaultController, parseFaultSpec } from "../src/execution/fault.js";
import { applyPrune, planPrune } from "../src/storage/prune.js";
import { SkillCandidateRepo } from "../src/storage/repos/candidates.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AnyAgentTool } from "../src/runtime/tools/index.js";
import { PatternRepo } from "../src/storage/repos/patterns.js";
import { minePatternsFromDb } from "../src/learning/miner.js";
import { draftSkillFromPattern } from "../src/learning/candidate.js";
import {
  assertEvalRepeats,
  buildProtocol,
  judgeRun,
  prepareRepoFixture,
  runEvalArm,
  runEvalComparison,
  stableStringify,
  wilsonInterval,
  type EvalRunner,
} from "../src/learning/eval.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn, USAGE } from "./helpers.js";

const tmp = makeTempCwd();

// Fixture templates live in the package tree — capture the absolute path
// BEFORE makeTempCwd chdirs the process into the temp workspace.
const PACKAGE_ROOT = process.cwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

// ---------- 阶段 13 coding toolset ----------

describe("coding toolset (阶段 13)", () => {
  it("composes pi coding tools with replay markers attached", () => {
    const tools = createCodingToolset(tmp.dir, { shell: "powershell" });
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["read", "edit", "write", "grep", "ls", "find", "powershell", "send_notification"]);
    const replayOf = Object.fromEntries(tools.map((t) => [t.name, (t as { replay?: string }).replay]));
    expect(replayOf).toMatchObject({
      read: "safe",
      edit: "safe",
      write: "safe",
      grep: "safe",
      ls: "safe",
      find: "safe",
      powershell: "never", // shell commands can double side effects
      send_notification: "never",
    });
  });

  it("maps pi tool names to capability metadata (destructive shell, readonly readers)", () => {
    expect(permissionsFor("read")).toEqual({ capabilities: ["fs:read"], risk: "readonly" });
    expect(permissionsFor("edit").risk).toBe("mutating");
    expect(permissionsFor("edit").capabilities).toContain("fs:write");
    const shell = permissionsFor("powershell");
    expect(shell.risk).toBe("destructive");
    expect(shell.capabilities).toContain("process:exec");
    expect(shell.capabilities).toContain("net:outbound");
  });

  it("tools:'coding' switches the toolset, system prompt and injects the workspace map", async () => {
    tmp.enter();
    fs.writeFileSync(path.join(tmp.dir, "app.ts"), "export const x = 1;\n", "utf8");
    fs.mkdirSync(path.join(tmp.dir, "src"));
    fs.writeFileSync(path.join(tmp.dir, "src", "util.ts"), "export const y = 2;\n", "utf8");
    const captured: string[] = [];
    const manager = new RunManager();
    const result = await manager.run({
      task: "look around",
      model: FAKE_MODEL,
      streamFn: (model, context) => {
        captured.push(JSON.stringify(context));
        return scriptedStreamFn([assistantMessage([{ type: "text", text: "ok" }], "stop")])(model, context);
      },
      reporter: new CollectingReporter(),
      database: path.join(tmp.dir, "coding", "harness.db"),
      tools: "coding",
      memory: { limit: 0 },
      skills: false,
    });
    manager.close();
    expect(result.record.status).toBe("completed");
    expect(captured.some((c) => c.includes('"powershell"') && c.includes('"read"') && c.includes('"edit"'))).toBe(true);
    expect(result.record.systemPrompt).toContain("durable coding agent");
    expect(result.record.systemPrompt).toContain("<workspace>");
    expect(result.record.systemPrompt).toContain("app.ts");
    expect(result.record.systemPrompt).toContain("src/");
    tmp.leave();
  });

  it("default toolset stays demo (no workspace map, no shell tools) — eval baselines stay comparable", async () => {
    tmp.enter();
    const captured: string[] = [];
    const manager = new RunManager();
    const result = await manager.run({
      task: "hello",
      model: FAKE_MODEL,
      streamFn: (model, context) => {
        captured.push(JSON.stringify(context));
        return scriptedStreamFn([assistantMessage([{ type: "text", text: "ok" }], "stop")])(model, context);
      },
      reporter: new CollectingReporter(),
      database: path.join(tmp.dir, "demo", "harness.db"),
      tools: [],
      memory: { limit: 0 },
      skills: false,
    });
    manager.close();
    expect(result.record.status).toBe("completed");
    expect(captured.some((c) => c.includes('"powershell"'))).toBe(false);
    expect(result.record.systemPrompt).not.toContain("<workspace>");
    expect(result.record.systemPrompt).not.toContain("durable coding agent");
    tmp.leave();
  });
});

// ---------- P0: interactive default denies mutating tools in non-TTY ----------

describe("P0 approval posture (阶段 13)", () => {
  it("interactive mode in a non-TTY test env denies a mutating tool without prompting", async () => {
    const gate = createPermissionGate({ mode: "interactive" }, () => {});
    const decision = await gate({
      toolCall: { id: "c1", name: "write" },
      args: { path: "x.txt", content: "hi" },
    } as never);
    expect(decision).toMatchObject({ block: true });
  });

  it("readonly tools pass interactive mode without approval", async () => {
    const gate = createPermissionGate({ mode: "interactive" }, () => {});
    const decision = await gate({ toolCall: { id: "c2", name: "read" }, args: { path: "x.txt" } } as never);
    expect(decision).toBeUndefined();
  });
});

// ---------- P1-3: resume runs recovered executions through the gates ----------

/** Seed a completed run that wrote gated.txt (hoisted to module scope — the
 * hardening suites reuse it for zombie/self-heal and single-count tests). */
async function seed(prefix: string): Promise<{ runId: string; dbPath: string }> {
  const dbPath = path.join(tmp.dir, prefix, "harness.db");
  const manager = new RunManager();
  const result = await manager.run({
    task: "write the file",
    model: FAKE_MODEL,
    streamFn: scriptedStreamFn([
      assistantMessage(
        [
          {
            type: "toolCall",
            id: "call_1",
            name: "write_file",
            arguments: { path: "gated.txt", content: "payload" },
          },
        ],
        "toolUse",
      ),
      assistantMessage([{ type: "text", text: "written" }], "stop"),
    ]),
    reporter: new CollectingReporter(),
    database: dbPath,
    tools: [writeFileTool],
  });
  manager.close();
  expect(result.record.status).toBe("completed");
  return { runId: result.record.id, dbPath };
}

function crashAround(dbPath: string, runId: string): void {
  // fabricate the kill AFTER tool_execution_start: the call sits in
  // "executing" and write_file (replay:"safe") takes the re-execute branch.
  const db = openDatabase(dbPath);
  try {
    const events = new TraceEventRepo(db).getByRun(runId);
    const idx = events.findIndex((e) => e.type === "tool_execution_start");
    const cutSeq = events[idx]!.seq;
    db.prepare("DELETE FROM trace_events WHERE run_id = ? AND seq > ?").run(runId, cutSeq);
    db.prepare("UPDATE runs SET status = 'running', finished_at = NULL, error = NULL WHERE id = ?").run(runId);
    for (const cp of new CheckpointRepo(db).list(runId)) {
      const state = cp.state as { lastSeq: number };
      if (state.lastSeq > cutSeq) db.prepare("DELETE FROM checkpoints WHERE run_id = ? AND seq = ?").run(runId, cp.seq);
    }
    const surviving = new TraceEventRepo(db).getByRun(runId);
    const tracePath = path.join(tmp.dir, ".harness", "traces", `${runId}.jsonl`);
    fs.writeFileSync(tracePath, surviving.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  } finally {
    db.close();
  }
}

describe("P1-3 resume gating (阶段 13)", () => {
  it("auto-deny blocks the recovered re-execution; the model sees the denial with a permission audit", async () => {
    const { runId, dbPath } = await seed("gate-deny");
    crashAround(dbPath, runId);

    const manager = new RunManager();
    const result = await manager.resume(runId, {
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "I was not allowed to rewrite." }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [writeFileTool],
      approval: { mode: "auto-deny" },
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    const toolResults = result.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    if (toolResults[0]?.role === "toolResult") {
      expect(toolResults[0].isError).toBe(true);
      expect(toolResults[0].content.some((b) => b.type === "text" && b.text.includes("auto-deny"))).toBe(true);
    }
    const trace = readTraceFile(result.tracePath as string);
    expect(
      trace.events.some((e) => e.type === "permission" && e.decision === "deny" && e.toolName === "write_file"),
    ).toBe(true);
    expect(trace.events.some((e) => e.type === "recovery_action" && e.action === "reexecute")).toBe(true);
    expect(trace.events.at(-1)).toMatchObject({ type: "run_end", status: "completed" });
  });

  it("without an approval override the recovered re-execution still goes through (regression)", async () => {
    const { runId, dbPath } = await seed("gate-allow");
    crashAround(dbPath, runId);

    const manager = new RunManager();
    const result = await manager.resume(runId, {
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "done" }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [writeFileTool],
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    const toolResults = result.messages.filter((m) => m.role === "toolResult");
    if (toolResults[0]?.role === "toolResult") expect(toolResults[0].isError).toBe(false);
    // write_file resolves against the workspace cwd (the temp dir root)
    expect(fs.readFileSync(path.join(tmp.dir, "gated.txt"), "utf8")).toBe("payload");
  });

  it("enforces the event-driven limits on the resumed segment (cost fuse, 加固期 P1)", async () => {
    const { runId, dbPath } = await seed("gate-limit");
    crashAround(dbPath, runId);

    // The scripted continuation reports real cost: after this assistant turn
    // the cost fuse must deny its tool call and degrade the run to failed.
    // (Regression: the resume dispatch used to skip limitEnforcer.onAgentEvent,
    // so turns/cost/consecutive-error fuses never accumulated after a crash.)
    const costly = {
      ...assistantMessage(
        [{ type: "toolCall", id: "call_2", name: "write_file", arguments: { path: "again.txt", content: "x" } }],
        "toolUse",
      ),
      usage: { ...USAGE, totalTokens: 5000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 } },
    };
    const manager = new RunManager();
    const result = await manager.resume(runId, {
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([costly, assistantMessage([{ type: "text", text: "done" }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [writeFileTool],
      limits: { maxCostUsd: 1 },
    });
    manager.close();

    expect(result.record.status).toBe("failed");
    expect(result.record.error).toContain("limit (cost)");
    const trace = readTraceFile(result.tracePath as string);
    expect(trace.events.some((e) => e.type === "limit_exceeded" && e.kind === "cost")).toBe(true);
    // the over-budget tool call must never have executed
    expect(fs.existsSync(path.join(tmp.dir, "again.txt"))).toBe(false);
  });
});

// ---------- P1-2: JSONL/SQLite reconciliation ----------

describe("P1-2 trace reconciliation (阶段 13)", () => {
  function seedDb(dbPath: string, count: number): Array<Record<string, unknown> & { seq: number }> {
    const db = openDatabase(dbPath);
    try {
      new RunRepo(db).insert({
        id: "r1",
        task: "t",
        modelSpec: "m",
        status: "completed",
        startedAt: new Date().toISOString(),
      });
      const repo = new TraceEventRepo(db);
      const events: Array<Record<string, unknown> & { seq: number }> = [];
      // a bracketed trace: run_start … message_end … run_end (readTraceFile requires both)
      const push = (event: Record<string, unknown> & { seq: number }): void => {
        repo.append(event as never);
        events.push(event);
      };
      push({ v: 1, seq: 1, ts: new Date().toISOString(), runId: "r1", type: "run_start", task: "t", modelSpec: "m" });
      for (let seq = 2; seq < count; seq++) {
        push({
          v: 1,
          seq,
          ts: new Date().toISOString(),
          runId: "r1",
          type: "message_end",
          message: { role: "user", content: "x", timestamp: seq },
        });
      }
      push({
        v: 1,
        seq: count,
        ts: new Date().toISOString(),
        runId: "r1",
        type: "run_end",
        status: "completed",
        durationMs: 1,
      });
      return events;
    } finally {
      db.close();
    }
  }

  it("drops the JSONL tail that SQLite never saw (kill between the two sinks)", () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "recon1", "harness.db");
    const events = seedDb(dbPath, 3);
    const file = path.join(tmp.dir, "recon1", "trace.jsonl");
    const extra = { ...events[2], seq: 4 };
    fs.writeFileSync(file, [...events, extra].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const result = reconcileJsonlTrace(file, events as never);
    expect(result.truncated).toBe(1);
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(3);
    expect(() => readTraceFile(file)).not.toThrow();
    tmp.leave();
  });

  it("rebuilds a short JSONL from the SQLite authority", () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "recon2", "harness.db");
    const events = seedDb(dbPath, 3);
    const file = path.join(tmp.dir, "recon2", "trace.jsonl");
    fs.writeFileSync(
      file,
      events
        .slice(0, 2)
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
      "utf8",
    );

    const result = reconcileJsonlTrace(file, events as never);
    expect(result.rebuilt).toBe(true);
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(3);
    tmp.leave();
  });

  it("backfills a mid-log SQLite hole from the JSONL copy; the tail stays truncated (加固期复核)", () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "recon-hole", "harness.db");
    const db = openDatabase(dbPath);
    let all: Array<Record<string, unknown> & { seq: number }> = [];
    try {
      new RunRepo(db).insert({
        id: "r1",
        task: "t",
        modelSpec: "m",
        status: "running",
        startedAt: new Date().toISOString(),
      });
      const repo = new TraceEventRepo(db);
      const mk = (seq: number): Record<string, unknown> & { seq: number } => ({
        v: 1,
        seq,
        ts: new Date().toISOString(),
        runId: "r1",
        type: seq === 1 ? "run_start" : "message_end",
        ...(seq === 1 ? { task: "t", modelSpec: "m" } : { message: { role: "user", content: "x", timestamp: seq } }),
      });
      // SQLite has a HOLE at seq 3 (its sink failed); the JSONL copy survived.
      for (const seq of [1, 2, 4, 5]) {
        const event = mk(seq);
        repo.append(event as never);
        all.push(event);
      }
      const hole = mk(3);
      all = [...all.slice(0, 2), hole, ...all.slice(2)];
      const file = path.join(tmp.dir, "recon-hole", "trace.jsonl");
      fs.writeFileSync(file, all.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

      const backfilledSeqs: number[] = [];
      const result = reconcileJsonlTrace(file, all.filter((e) => e.seq !== 3) as never, (event) => {
        backfilledSeqs.push(event.seq as number);
        repo.append(event as never);
      });
      expect(result.backfilled).toBe(1);
      expect(backfilledSeqs).toEqual([3]);
      const after = new TraceEventRepo(db).getByRun("r1");
      expect(after.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      db.close();
    }
    tmp.leave();
  });

  it("rebuilds when the JSONL is damaged mid-write (partial final line)", () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "recon3", "harness.db");
    const events = seedDb(dbPath, 3);
    const file = path.join(tmp.dir, "recon3", "trace.jsonl");
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n" + '{"v":1,"seq":4,"ts":"20', "utf8");

    const result = reconcileJsonlTrace(file, events as never);
    expect(result.rebuilt).toBe(true);
    expect(() => readTraceFile(file)).not.toThrow();
    tmp.leave();
  });
});

// ---------- P1-5: compaction fallback never orphans a toolResult ----------

describe("P1-5 compaction cut points (阶段 13)", () => {
  const toolResult = (id: string, text: string) =>
    ({
      role: "toolResult",
      toolCallId: id,
      toolName: "write_file",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
    }) as never;

  it("cut boundary inside a multi-result block: slice never starts with an orphaned toolResult", () => {
    // assistant with TWO calls, then trA (large) and trB (small); a budget that
    // lands the boundary on trA — the old fallback cut after trA, orphaning trB.
    const messages = [
      { role: "user", content: "go", timestamp: 1 } as never,
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "cA", name: "write_file", arguments: {} },
          { type: "toolCall", id: "cB", name: "write_file", arguments: {} },
        ],
        timestamp: 2,
      } as never,
      toolResult("cA", "a".repeat(2000)),
      toolResult("cB", "b".repeat(10)),
    ];
    const cut = findCutIndex(messages, 200);
    expect(cut).toBe(messages.length); // after the whole block — empty tail, no orphan
  });

  it("block mid-array: cut after the LAST toolResult of the block", () => {
    const messages = [
      { role: "user", content: "go", timestamp: 1 } as never,
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "cA", name: "write_file", arguments: {} },
          { type: "toolCall", id: "cB", name: "write_file", arguments: {} },
        ],
        timestamp: 2,
      } as never,
      toolResult("cA", "a".repeat(2000)),
      toolResult("cB", "b".repeat(10)),
      { role: "assistant", content: [{ type: "text", text: "both writes done" }], timestamp: 5 } as never,
    ];
    const cut = findCutIndex(messages, 200);
    expect(cut).toBe(4); // after cB, before the follow-up assistant
    const first = (messages[cut] as { role: string }).role;
    expect(first).not.toBe("toolResult");
  });
});

// ---------- P1-1: memory path fence + id validation ----------

describe("P1-1 memory id fence (阶段 13)", () => {
  it("hostile ids cannot escape the memory dir; parse rejects invalid frontmatter ids", () => {
    tmp.enter();
    const store = new MemoryStore(path.join(tmp.dir, "mem"));
    expect(() => store.pathOf("../../evil")).toThrow();
    expect(() => store.pathOf("..\\evil")).toThrow();
    // ".." alone becomes the file "...md" INSIDE the dir (".md" is appended) —
    // not an escape; the fence still refuses real climbs.
    expect(store.pathOf("..")).toBe(path.join(tmp.dir, "mem", "ordinary", "...md"));
    expect(store.get("../../evil")).toBeUndefined();
    const hostile = `---\nid: ../../../evil\nrunId: r\ntaskType: t\noutcome: success\nkeywords: []\nconfirmations: 0\ncreated: now\nupdated: now\n---\n# x`;
    expect(() => parseMemory(hostile, "test")).toThrow(/invalid id/);
    expect(MEMORY_ID_PATTERN.test("mem-a")).toBe(true);
    expect(MEMORY_ID_PATTERN.test("../evil")).toBe(false);
    tmp.leave();
  });

  it("distiller ignores a hostile updateOf instead of merging through the fence", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "memfence", "harness.db");
    const manager = new RunManager();
    const result = await manager.run({
      task: "organize reports",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "done" }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [],
    });
    manager.close();

    const outcome = await distillRunById(result.record.id, {
      database: dbPath,
      complete: async () =>
        JSON.stringify({
          updateOf: "../../evil",
          taskType: "t",
          summaryEn: "hostile updateOf ignored",
          summaryZh: "敌意 updateOf 被忽略",
          approach: "n/a",
          pitfalls: "n/a",
          outcome: "success",
          keywordsEn: ["fence"],
        }),
    });
    expect(outcome.merged).toBe(false); // treated as a NEW record, not a merge
    expect(fs.existsSync(path.join(tmp.dir, "evil.md"))).toBe(false);
    tmp.leave();
  });
});

// ---------- workspace tree ----------

describe("workspace tree (阶段 13)", () => {
  it("deterministic, files-first, skips node_modules/.git", () => {
    tmp.enter();
    fs.mkdirSync(path.join(tmp.dir, "src"));
    fs.mkdirSync(path.join(tmp.dir, "node_modules"));
    fs.writeFileSync(path.join(tmp.dir, "package.json"), "{}", "utf8");
    fs.writeFileSync(path.join(tmp.dir, "src", "b.ts"), "", "utf8");
    fs.writeFileSync(path.join(tmp.dir, "src", "a.ts"), "", "utf8");
    fs.writeFileSync(path.join(tmp.dir, "node_modules", "x.js"), "", "utf8");
    const tree1 = buildWorkspaceTree(tmp.dir);
    const tree2 = buildWorkspaceTree(tmp.dir);
    expect(tree1).toBe(tree2);
    expect(tree1.split("\n")).toEqual(["package.json", "src/", "  a.ts", "  b.ts"]);
    expect(tree1).not.toContain("node_modules");
    tmp.leave();
  });

  it("caps the entry count", () => {
    tmp.enter();
    for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(tmp.dir, `f${i}.txt`), "", "utf8");
    const tree = buildWorkspaceTree(tmp.dir);
    expect(tree.split("\n").length).toBeLessThanOrEqual(61); // 60 entries + ellipsis
    expect(tree.split("\n").at(-1)).toBe("…");
    tmp.leave();
  });
});

// ---------- 阶段 14: coding eval — setupRepo + testCommand ----------

describe("阶段 14 coding eval mechanics", () => {
  const FIXTURES: Record<string, { broken: string; fix: (dir: string) => void }> = {
    "string-utils": {
      broken: path.join(PACKAGE_ROOT, "evals", "fixtures", "string-utils"),
      fix: (dir) =>
        fs.writeFileSync(
          path.join(dir, "index.js"),
          '// Public API.\nmodule.exports = {\n  ...require("./lib/format"),\n  ...require("./lib/parse"),\n};\n',
          "utf8",
        ),
    },
    "inventory-cli": {
      broken: path.join(PACKAGE_ROOT, "evals", "fixtures", "inventory-cli"),
      fix: (dir) =>
        fs.writeFileSync(
          path.join(dir, "service.js"),
          'const config = require("./config");\n\nfunction restockList(items) {\n  // Items at or below the restock threshold need ordering.\n  const threshold = config.lowStockThreshold ?? 2;\n  return items.filter((item) => item.stock <= threshold).map((item) => item.sku);\n}\n\nmodule.exports = { restockList };\n',
          "utf8",
        ),
    },
    "todo-store": {
      broken: path.join(PACKAGE_ROOT, "evals", "fixtures", "todo-store"),
      fix: (dir) =>
        fs.writeFileSync(
          path.join(dir, "store.js"),
          'const fs = require("node:fs");\nconst { toJSON, fromJSON } = require("./serializer");\n\nfunction save(file, todos) {\n  fs.writeFileSync(file, JSON.stringify(todos.map(toJSON), null, 2));\n}\n\nfunction load(file) {\n  return JSON.parse(fs.readFileSync(file, "utf8")).map(fromJSON);\n}\n\nmodule.exports = { save, load };\n',
          "utf8",
        ),
    },
  };

  function runIn(dir: string): { code: number } {
    try {
      execSync("node test.js", { cwd: dir, stdio: "pipe" });
      return { code: 0 };
    } catch (err) {
      return { code: (err as { status?: number }).status ?? 1 };
    }
  }

  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`fixture ${name}: broken at seed, green after the intended fix (solvability proof)`, () => {
      tmp.enter();
      const dir = path.join(tmp.dir, "repos", name);
      prepareRepoFixture({ dir, template: fixture.broken });
      expect(runIn(dir).code).not.toBe(0); // the bug is live
      fixture.fix(dir);
      expect(runIn(dir).code).toBe(0); // the intended fix turns it green
      tmp.leave();
    });

    it(`fixture ${name}: prepareRepoFixture resets the repo before every run`, () => {
      tmp.enter();
      const dir = path.join(tmp.dir, "repos", name);
      prepareRepoFixture({ dir, template: fixture.broken });
      fixture.fix(dir); // simulate an agent's edit
      expect(runIn(dir).code).toBe(0);
      prepareRepoFixture({ dir, template: fixture.broken }); // next repeat/arm
      expect(runIn(dir).code).not.toBe(0); // the edit is gone — state is per-run
      tmp.leave();
    });
  }

  it("judgeRun testCommand: the repo's own tests decide, regardless of the run status", () => {
    tmp.enter();
    const dir = path.join(tmp.dir, "judge");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "test.js"), "process.exit(1);\n", "utf8");
    const task = { id: "t", task: "x", testCommand: "node test.js", cwd: "judge" };
    const completed = { taskId: "t", status: "completed" };
    const red = judgeRun(task, completed);
    expect(red.pass).toBe(false);
    expect(red.reason).toContain("test command failed");

    fs.writeFileSync(path.join(dir, "test.js"), "console.log('ok');\n", "utf8");
    expect(judgeRun(task, completed).pass).toBe(true);

    // a run that claims success but leaves a red suite still fails
    fs.writeFileSync(path.join(dir, "test.js"), "process.exit(3);\n", "utf8");
    expect(judgeRun(task, { taskId: "t", status: "completed" }).pass).toBe(false);
    tmp.leave();
  });

  it("an eval arm over a coding taskset judges via the repo tests end-to-end", async () => {
    tmp.enter();
    for (const [name, fixture] of Object.entries(FIXTURES)) {
      fs.cpSync(fixture.broken, path.join(tmp.dir, "evals", "fixtures", name), { recursive: true });
    }
    const inline = {
      name: "coding-fix-inline",
      tasks: Object.entries(FIXTURES).map(([id]) => ({
        id,
        task: `fix ${id}`,
        setupRepo: { dir: `repos/${id}`, template: path.join(tmp.dir, "evals", "fixtures", id) },
        testCommand: "node test.js",
        cwd: `repos/${id}`,
      })),
    };
    // runner 1: never edits → all three repos stay red
    const lazyRunner: EvalRunner = async (task) => ({ taskId: task.id, status: "completed" });
    const lazy = await runEvalArm(inline, lazyRunner, false);
    expect(lazy.passRate).toBe(0);
    expect(lazy.results.every((r) => r.reason?.includes("test command failed"))).toBe(true);

    // runner 2: applies the intended fix to each repo → all green
    const fixingRunner: EvalRunner = async (task) => {
      FIXTURES[task.id].fix(path.join(tmp.dir, "repos", task.id));
      return { taskId: task.id, status: "completed" };
    };
    const fixed = await runEvalArm(inline, fixingRunner, false);
    expect(fixed.passRate).toBe(1);
    tmp.leave();
  });
});

// ---------- 阶段 14 hardening: pinned protocol, interleaved arms, session artifacts ----------

describe("阶段 14 protocol + session artifacts", () => {
  it("stableStringify is key-order independent", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("buildProtocol: deterministic sha, sensitive to task/model changes", () => {
    tmp.enter();
    const ts = {
      name: "p",
      tasks: [
        { id: "a", task: "one" },
        { id: "b", task: "two" },
      ],
    };
    const base = buildProtocol(ts, { model: "m", repeats: 2 });
    const again = buildProtocol(ts, { model: "m", repeats: 2 });
    expect(again.sha256).toBe(base.sha256);
    const reordered = {
      name: "p",
      tasks: [
        { id: "b", task: "two" },
        { id: "a", task: "one" },
      ],
    } as typeof ts;
    expect(buildProtocol(reordered, { model: "m", repeats: 2 }).sha256).toBe(base.sha256); // order-insensitive
    expect(buildProtocol(ts, { model: "OTHER", repeats: 2 }).sha256).not.toBe(base.sha256);
    expect(
      buildProtocol({ name: "p", tasks: [{ id: "a", task: "CHANGED" }] }, { model: "m", repeats: 2 }).sha256,
    ).not.toBe(base.sha256);
    tmp.leave();
  });

  it("comparison arms interleave per repeat and session.jsonl indexes every run", async () => {
    tmp.enter();
    const calls: Array<{ arm: string; taskId: string }> = [];
    const taskSet = {
      name: "interleave",
      tasks: [
        { id: "t1", task: "x" },
        { id: "t2", task: "x" },
      ],
    };
    const runner: EvalRunner = async (task, skills) => {
      const arm = skills === false ? "baseline" : "treatment";
      calls.push({ arm, taskId: task.id });
      return { taskId: task.id, status: "completed", tracePath: path.join(tmp.dir, task.id + ".jsonl"), tokens: 1 };
    };
    const artifactsDir = path.join(tmp.dir, "artifacts");
    const report = await runEvalComparison(taskSet, {
      runner,
      skillName: "s",
      modelSpec: "m",
      artifactsDir,
      repeats: 2,
    });
    // odd repeat → baseline first; even repeat → treatment first
    expect(calls[0]).toEqual({ arm: "baseline", taskId: "t1" });
    expect(calls[2]).toEqual({ arm: "treatment", taskId: "t1" });
    expect(calls[4]).toEqual({ arm: "treatment", taskId: "t1" });
    expect(calls[6]).toEqual({ arm: "baseline", taskId: "t1" });
    expect(calls).toHaveLength(8);
    expect(report.protocolSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.session).toContain("session.jsonl");

    const sessionLines = fs
      .readFileSync(report.session!, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(sessionLines).toHaveLength(8);
    expect(sessionLines[0]).toMatchObject({
      seq: 1,
      arm: "baseline",
      taskId: "t1",
      tracePath: expect.stringContaining("t1.jsonl"),
    });
    expect(sessionLines[2]).toMatchObject({ arm: "treatment" });
    const protocol = JSON.parse(fs.readFileSync(path.join(artifactsDir, "protocol.json"), "utf8"));
    expect(protocol.model).toBe("m");
    expect(protocol.sha256).toBe(report.protocolSha256);
    tmp.leave();
  });
});

// ---------- P1-4: promotion failure leaves no residue ----------

describe("P1-4 promotion cleanup (阶段 13)", () => {
  it("a rejected pi-loader check removes the written file (no residue for rebuild to index)", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "rollback", "harness.db");
    const db = openDatabase(dbPath);
    let patternIdValue = "";
    try {
      for (const i of [0, 1, 2]) {
        new RunRepo(db).insert({
          id: `rb-${i}`,
          task: `note file task ${i}`,
          modelSpec: "m",
          status: "completed",
          startedAt: new Date().toISOString(),
        });
        const repo = new TraceEventRepo(db);
        // two calls per run — single-call traces mine no 2-grams
        const calls: Array<[string, number]> = [
          ["write_file", i * 2 + 1],
          ["read_file", i * 2 + 2],
        ];
        for (const [toolName, seq] of calls) {
          const message = {
            role: "toolResult",
            toolCallId: `c-${toolName}-${seq}`,
            toolName,
            content: [{ type: "text", text: "w" }],
            isError: false,
            timestamp: Date.now(),
          };
          repo.append({
            v: 1,
            seq,
            ts: new Date().toISOString(),
            runId: `rb-${i}`,
            type: "message_end",
            message,
          } as never);
        }
      }
      new PatternRepo(db).replaceAll(minePatternsFromDb(db));
      patternIdValue = new PatternRepo(db).list()[0]!.id;
    } finally {
      db.close();
    }
    const skillsRoot = path.join(tmp.dir, "rollback", "skills");
    const draft = await draftSkillFromPattern(patternIdValue, {
      database: dbPath,
      complete: async () => JSON.stringify({ name: "rollback-skill", description: "d", body: "b" }),
      skillsRoot,
    });

    // force the pi-loader gate to reject via the mocked verifier
    const verify = await import("../src/skills/verify.js");
    const spy = vi
      .spyOn(verify, "verifyPromotedSkills")
      .mockReturnValue({ ok: false, skills: [], diagnostics: [{ type: "error", message: "forced rejection" }] });
    expect(() => promoteCandidate(draft.candidate.id, { database: dbPath, skillsRoot })).toThrow(/loadSkillsFromDir/);
    spy.mockRestore();
    expect(fs.existsSync(path.join(skillsRoot, "promoted", "rollback-skill"))).toBe(false);
    tmp.leave();
  });
});

// ---------- 加固期: punch-list fixes ----------

describe("加固期: token fuse for cost-less models", () => {
  it("trips on cumulative tokens when the model reports zero cost", () => {
    const violations: LimitViolation[] = [];
    const enforcer = new LimitEnforcer(
      { ...DEFAULT_RUN_LIMITS, maxTotalTokens: 100 },
      () => {},
      (v) => violations.push(v),
    );
    for (let i = 0; i < 2; i++) {
      enforcer.onAgentEvent({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { ...USAGE, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
      } as never);
    }
    const decision = enforcer.beforeToolCall("read", {});
    expect(decision).toMatchObject({ block: true, terminate: true });
    expect(violations[0]?.kind).toBe("tokens");
  });

  it("a normal run stays well under the default token budget", () => {
    const enforcer = new LimitEnforcer(
      { ...DEFAULT_RUN_LIMITS },
      () => {},
      () => {},
    );
    enforcer.onAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { ...USAGE, totalTokens: 50_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    } as never);
    expect(enforcer.beforeToolCall("read", {})).toBeUndefined();
  });
});

describe("加固期: rebuild loader gate", () => {
  it("rebuild skips directories the pi loader rejects (only loader-clean skills get indexed)", async () => {
    tmp.enter();
    const root = path.join(tmp.dir, "rebuild-gate");
    const db = openDatabase(path.join(root, "harness.db"));
    try {
      const promoted = path.join(root, "promoted");
      for (const name of ["good-skill", "bad-skill"]) {
        fs.mkdirSync(path.join(promoted, name), { recursive: true });
        fs.writeFileSync(
          path.join(promoted, name, "SKILL.md"),
          serializeSkillMd({ name, description: "d", body: "b" }),
        );
      }
      const verify = await import("../src/skills/verify.js");
      const real = verify.verifyPromotedSkills;
      const spy = vi
        .spyOn(verify, "verifyPromotedSkills")
        .mockImplementation((dir) =>
          String(dir).includes("bad-skill")
            ? { ok: false, skills: [], diagnostics: [{ type: "error", message: "pi loader rejects" }] }
            : real(dir),
        );
      try {
        const index = new SkillIndex(db);
        expect(index.rebuild(promoted)).toBe(1);
        expect(index.getByName(["good-skill"])).toHaveLength(1);
        expect(index.getByName(["bad-skill"])).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    } finally {
      db.close();
    }
    tmp.leave();
  });
});

describe("加固期: switch-flag coercion (--yolo true)", () => {
  it("coerces `--yolo true` to a boolean so the approval default does not silently downgrade", () => {
    expect(parseArgs(["run", "task text", "--yolo", "true"]).flags.yolo).toBe(true);
    expect(parseArgs(["run", "task text", "--yolo"]).flags.yolo).toBe(true);
    expect(parseArgs(["run", "task text", "--yolo=1"]).flags.yolo).toBe(true);
    // a value flag still captures its value as a string
    expect(parseArgs(["run", "task text", "--model", "deepseek/deepseek-flash"]).flags.model).toBe(
      "deepseek/deepseek-flash",
    );
    // positionals are untouched
    expect(parseArgs(["run", "a", "b"]).positional).toEqual(["a", "b"]);
  });
});

// ---------- 加固期第二轮: P0/P1/P2 work order ----------

describe("加固期: tool path fence", () => {
  it("rejects lexical escapes and symlink (junction) escapes", async () => {
    tmp.enter();
    // The fence root is a subdirectory; the junction target lives OUTSIDE it.
    const root = path.join(tmp.dir, "workspace");
    const outside = path.join(tmp.dir, "outside");
    fs.mkdirSync(path.join(root, "inner"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "top secret", "utf8");
    const link = path.join(root, "innocent-link");
    fs.symlinkSync(outside, link, "junction");
    const calls: string[] = [];
    const fenced = withPathFence(
      [
        {
          name: "probe",
          label: "Probe",
          description: "probe tool",
          parameters: {} as never,
          replay: "safe" as const,
          execute: async (_id: string, params: { path: string }) => {
            calls.push(params.path);
            return { content: [{ type: "text", text: "ok" }], details: undefined };
          },
        } as never,
      ],
      root,
    );
    await expect(fenced[0]!.execute("t1", { path: path.join(link, "secret.txt") })).rejects.toThrow(
      /escapes workspace root through a symlink/,
    );
    await expect(fenced[0]!.execute("t2", { path: "../outside/secret.txt" })).rejects.toThrow(/escapes workspace root/);
    await fenced[0]!.execute("t3", { path: "inner/inside.txt" });
    // the fence checks but does NOT rewrite — the tool receives the raw argument
    expect(calls).toEqual(["inner/inside.txt"]);
    tmp.leave();
  });

  it("sanitizes evidence filenames (model-controlled toolCallId cannot traverse)", async () => {
    tmp.enter();
    const dir = path.join(tmp.dir, "evidence");
    const tools = withEvidenceCapture([writeFileTool], dir);
    await tools[0]!.execute("../../evil", { path: "ok.txt", content: "x" });
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("evil.md");
    expect(fs.existsSync(path.join(tmp.dir, "evil.md"))).toBe(false);
    tmp.leave();
  });

  it("rejects NTFS stream specifiers and allows the workspace root itself (加固期复核)", async () => {
    tmp.enter();
    const calls: string[] = [];
    const fenced = withPathFence(
      [
        {
          name: "probe",
          label: "Probe",
          description: "probe tool",
          parameters: {} as never,
          replay: "safe" as const,
          execute: async (_id: string, params: { path: string }) => {
            calls.push(params.path);
            return { content: [{ type: "text", text: "ok" }], details: undefined };
          },
        } as never,
      ],
      tmp.dir,
    );
    fs.writeFileSync(path.join(tmp.dir, "host.txt"), "x", "utf8");
    if (process.platform === "win32") {
      // an ADS write would land INSIDE the root but is hidden from listings — rejected
      await expect(fenced[0]!.execute("t1", { path: "host.txt:hidden" })).rejects.toThrow(/stream specifier/);
    }
    await fenced[0]!.execute("t2", { path: "." }); // the root itself is inside, not an escape
    expect(calls).toEqual(["."]);
    tmp.leave();
  });

  it("captures FAILED executions so tidy pointers never dangle", async () => {
    tmp.enter();
    const dir = path.join(tmp.dir, "evidence-err");
    const boom: AnyAgentTool = {
      ...writeFileTool,
      execute: async () => {
        throw new Error("disk exploded");
      },
    };
    const tools = withEvidenceCapture([boom], dir);
    await expect(tools[0]!.execute("call_err", { path: "x", content: "y" })).rejects.toThrow(/disk exploded/);
    const written = fs.readFileSync(path.join(dir, "call_err.md"), "utf8");
    expect(written).toContain("EXECUTION ERROR");
    expect(written).toContain("disk exploded");
    tmp.leave();
  });

  it("the approval request carries a preview of the actual arguments", async () => {
    const seen: string[] = [];
    const gate = createPermissionGate(
      {
        mode: "interactive",
        approveFn: ({ toolName, argsPreview: preview }) => {
          seen.push(`${toolName}: ${preview}`);
          return false;
        },
      },
      () => {},
    );
    await gate({
      toolCall: { id: "c1", name: "write_file" },
      args: { path: "a.txt", content: "secret payload" },
    } as never);
    expect(seen[0]).toContain("write_file");
    expect(seen[0]).toContain("secret payload");
  });
});

describe("加固期: zombie run self-heal + single count", () => {
  it("a run whose trace already has run_end is healed (status backfilled), not resumed", async () => {
    const { runId, dbPath } = await seed("zombie");
    // Fabricate the zombie: the status write was lost, the trace is complete.
    const db = openDatabase(dbPath);
    db.prepare("UPDATE runs SET status = 'running', finished_at = NULL, error = NULL WHERE id = ?").run(runId);
    db.close();

    const manager = new RunManager();
    const result = await manager.resume(runId, { database: dbPath, model: FAKE_MODEL });
    manager.close();
    expect(result.record.status).toBe("completed");
    expect(result.messages).toEqual([]);
    const trace = readTraceFile(result.tracePath as string);
    expect(trace.events.filter((e) => e.type === "run_end")).toHaveLength(1); // no second run_end
  });

  it("a recovered re-execution counts ONCE against the tool-call budget", async () => {
    const { runId, dbPath } = await seed("single-count");
    crashAround(dbPath, runId);
    const manager = new RunManager();
    const result = await manager.resume(runId, {
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "done" }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [writeFileTool],
      approval: { mode: "auto-approve" },
      limits: { maxToolCalls: 1 }, // the recovered call is the one call — double counting would deny it
    });
    manager.close();
    expect(result.record.status).toBe("completed");
    expect(fs.readFileSync(path.join(tmp.dir, "gated.txt"), "utf8")).toBe("payload");
  });
});

describe("加固期: compaction single-turn shapes", () => {
  const system: AgentMessage = { role: "system", content: "sys" } as never;
  const user: AgentMessage = { role: "user", content: "do three things", timestamp: 1 } as never;
  const toolCall = (id: string): AgentMessage["content"] =>
    [{ type: "toolCall", id, name: "read", arguments: {} }] as never;
  const tr = (id: string): AgentMessage =>
    ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "r" }] }) as never;

  it("single turn, many tool calls: the cut never separates an assistant from its toolResults", () => {
    const msgs = [
      system,
      user,
      { role: "assistant", content: toolCall("c1"), usage: USAGE, stopReason: "toolUse" } as never,
      tr("c1"),
      { role: "assistant", content: toolCall("c2"), usage: USAGE, stopReason: "toolUse" } as never,
      tr("c2"),
      { role: "assistant", content: toolCall("c3"), usage: USAGE, stopReason: "toolUse" } as never,
      tr("c3"),
    ];
    const cut = findCutIndex(msgs, Number.POSITIVE_INFINITY);
    expect(cut).toBe(msgs.length); // empty tail is the only safe cut without a user boundary
  });

  it("final fallback never returns a tail that starts with a toolResult", () => {
    const msgs = [
      system,
      user,
      { role: "assistant", content: toolCall("c1"), usage: USAGE, stopReason: "toolUse" } as never,
      tr("c1"),
    ];
    const cut = findCutIndex(msgs, Number.POSITIVE_INFINITY);
    expect(cut).toBe(msgs.length); // guarded — the old code returned length-1 (orphaned toolResult)
    const asstTail = [system, user, { role: "assistant", content: [{ type: "text", text: "t" }] } as never];
    expect(findCutIndex(asstTail, Number.POSITIVE_INFINITY)).toBe(asstTail.length - 1);
  });
});

describe("加固期: eval robustness", () => {
  const taskSet = {
    name: "hardening",
    tasks: [
      { id: "t1", task: "task one" },
      { id: "t2", task: "task two" },
    ],
  };
  const okRunner: EvalRunner = async (task) => ({ taskId: task.id, status: "completed" });

  it("wilsonInterval brackets the pass rate honestly", () => {
    const zero = wilsonInterval(0, 10);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeGreaterThan(0);
    expect(zero.hi).toBeLessThan(0.35);
    const all = wilsonInterval(18, 18);
    expect(all.lo).toBeGreaterThan(0.8);
    expect(all.hi).toBe(1);
  });

  it("refuses single-repeat comparisons (a verdict of one run is noise)", async () => {
    await expect(runEvalComparison(taskSet, { runner: okRunner, skillName: "s", repeats: 1 })).rejects.toThrow(
      /repeats >= 2/,
    );
    expect(() => assertEvalRepeats(1)).toThrow(/repeats >= 2/);
  });

  it("a runner crash becomes a failed run and the arm completes (partial results land)", async () => {
    const arm = await runEvalArm(
      taskSet,
      async (task) => {
        if (task.id === "t2") throw new Error("provider exploded");
        return okRunner(task);
      },
      false,
      { repeats: 2 },
    );
    expect(arm.results).toHaveLength(4);
    const crashed = arm.results.filter((r) => r.status === "runner_error");
    expect(crashed).toHaveLength(2);
    expect(crashed.every((r) => r.pass === false && /runner crashed/.test(r.reason ?? ""))).toBe(true);
  });

  it("a judge crash fails the run instead of failing the comparison", async () => {
    const judged = await runEvalArm(
      { name: "judge-crash", tasks: [{ id: "j1", task: "explain", judgeInstructions: "be fair" }] },
      okRunner,
      false,
      {
        repeats: 2,
        judge: async () => {
          throw new Error("judge down");
        },
      },
    );
    expect(judged.results.every((r) => r.pass === false && /judge crashed/.test(r.reason ?? ""))).toBe(true);
  });
});

describe("加固期: fault windows", () => {
  it("parses the new points (argument optional where meaningful)", () => {
    expect(parseFaultSpec("between_sinks")).toEqual({ point: "between_sinks", toolName: "" });
    expect(parseFaultSpec("between_sinks:message_end")).toEqual({ point: "between_sinks", toolName: "message_end" });
    expect(parseFaultSpec("after_assistant_message")).toEqual({ point: "after_assistant_message", toolName: "" });
    expect(parseFaultSpec("mid_recovery:3")).toEqual({ point: "mid_recovery", toolName: "3" });
    expect(() => parseFaultSpec("after_tool_call")).toThrow(/tool name/);
  });

  it("after_assistant_message fires on a tool-carrying assistant message (the planned window)", () => {
    const kills: string[] = [];
    const controller = new FaultController({ point: "after_assistant_message", toolName: "" }, () => kills.push("k"));
    controller.onEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    } as never);
    expect(kills).toEqual([]);
    controller.onEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: {} }] },
    } as never);
    expect(kills).toEqual(["k"]);
  });

  it("mid_recovery fires after N resolved calls", () => {
    const kills: string[] = [];
    const controller = new FaultController({ point: "mid_recovery", toolName: "2" }, () => kills.push("k"));
    controller.onRecoveryStep(1);
    expect(kills).toEqual([]);
    controller.onRecoveryStep(2);
    expect(kills).toEqual(["k"]);
  });

  it("between_sinks fires after the first sink persisted the event", () => {
    const order: string[] = [];
    const sink = (name: string): TraceSink => ({ append: (event) => order.push(`${name}:${event.seq}`) });
    const recorder = new TraceRecorder("r", [sink("jsonl"), sink("sqlite")], {
      onSinkBoundary: (event) => order.push(`boundary:${event.seq}`),
    });
    recorder.record({ type: "recovery_action", toolCallId: "c", toolName: "t", action: "reexecute" });
    expect(order).toEqual(["jsonl:1", "boundary:1", "sqlite:1"]);
  });
});

describe("加固期: prune (retention)", () => {
  it("prunes checkpoints of finished runs and traces/evidence beyond the keep window", () => {
    tmp.enter();
    const db = openDatabase(path.join(tmp.dir, "prune", "harness.db"));
    try {
      const now = Date.now();
      const runIds = ["old-1", "old-2", "old-3", "new-1", "live-1"];
      runIds.forEach((id, i) => {
        new RunRepo(db).insert({
          id,
          task: `task ${id}`,
          modelSpec: "m",
          status: id === "live-1" ? "running" : "completed",
          startedAt: new Date(now - (runIds.length - i) * 60_000).toISOString(),
        });
        db.prepare(
          "INSERT INTO checkpoints (run_id, seq, kind, state_json, created_at) VALUES (?, 1, 'message_boundary', '{}', ?)",
        ).run(id, new Date().toISOString());
      });
      const tracesDirPath = path.join(tmp.dir, "prune", "traces");
      const evidencePath = path.join(tmp.dir, "prune", "evidence");
      // finished DESC = [new-1, old-3, old-2, old-1]; keepRuns 2 → beyond = [old-2, old-1]
      for (const id of ["old-1", "old-2"]) {
        fs.mkdirSync(tracesDirPath, { recursive: true });
        fs.writeFileSync(path.join(tracesDirPath, `${id}.jsonl`), "x\n", "utf8");
        fs.mkdirSync(path.join(evidencePath, id), { recursive: true });
      }
      const plan = planPrune(db, { keepRuns: 2 });
      expect(plan.beyond.map((r) => r.runId).sort()).toEqual(["old-1", "old-2"]);
      const result = applyPrune(db, plan, { tracesDir: tracesDirPath, evidenceDir: evidencePath });
      expect(result.tracesDeleted).toBe(2);
      expect(result.evidenceDeleted).toBe(2);
      const cpRows = (id: string): number =>
        Number((db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE run_id = ?").get(id) as { n: number }).n);
      expect(cpRows("old-1")).toBe(0);
      expect(cpRows("new-1")).toBe(0);
      expect(cpRows("live-1")).toBe(1); // interrupted runs keep their checkpoints
    } finally {
      db.close();
    }
    tmp.leave();
  });
});

describe("加固期: --force promotion requires confirmation", () => {
  it("a declined confirmation leaves the promoted skill untouched; an accepted one overwrites", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "confirm", "harness.db");
    const db = openDatabase(dbPath);
    let patternId = "";
    try {
      for (const i of [0, 1, 2]) {
        new RunRepo(db).insert({
          id: `cf-${i}`,
          task: `note file task ${i}`,
          modelSpec: "m",
          status: "completed",
          startedAt: new Date().toISOString(),
        });
        const repo = new TraceEventRepo(db);
        const calls: Array<[string, number]> = [
          ["write_file", i * 2 + 1],
          ["read_file", i * 2 + 2],
        ];
        for (const [toolName, seq] of calls) {
          repo.append({
            v: 1,
            seq,
            ts: new Date().toISOString(),
            runId: `cf-${i}`,
            type: "message_end",
            message: {
              role: "toolResult",
              toolCallId: `c-${toolName}-${seq}`,
              toolName,
              content: [{ type: "text", text: "w" }],
              isError: false,
              timestamp: Date.now(),
            },
          } as never);
        }
      }
      new PatternRepo(db).replaceAll(minePatternsFromDb(db));
      patternId = new PatternRepo(db).list()[0]!.id;
    } finally {
      db.close();
    }
    const skillsRoot = path.join(tmp.dir, "confirm", "skills");
    const draft = await draftSkillFromPattern(patternId, {
      database: dbPath,
      complete: async () => JSON.stringify({ name: "confirm-skill", description: "d", body: "b" }),
      skillsRoot,
    });
    promoteCandidate(draft.candidate.id, { database: dbPath, skillsRoot });
    const promotedPath = path.join(skillsRoot, "promoted", "confirm-skill", "SKILL.md");
    expect(fs.readFileSync(promotedPath, "utf8")).toContain("confirm-skill");

    // simulate a v2 draft for the same skill
    fs.writeFileSync(
      draft.candidate.skillMdPath,
      serializeSkillMd({ name: "confirm-skill", description: "d", body: "v2 body" }),
      "utf8",
    );
    {
      const db2 = openDatabase(dbPath);
      try {
        new SkillCandidateRepo(db2).setStatus(draft.candidate.id, "draft");
      } finally {
        db2.close();
      }
    }
    expect(() =>
      promoteCandidate(draft.candidate.id, { database: dbPath, skillsRoot, force: true, confirm: () => false }),
    ).toThrow(/cancelled/);
    expect(fs.readFileSync(promotedPath, "utf8")).not.toContain("v2 body");
    promoteCandidate(draft.candidate.id, { database: dbPath, skillsRoot, force: true, confirm: () => true });
    expect(fs.readFileSync(promotedPath, "utf8")).toContain("v2 body");
    tmp.leave();
  });
});
