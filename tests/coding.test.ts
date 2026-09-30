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
import { PatternRepo } from "../src/storage/repos/patterns.js";
import { minePatternsFromDb } from "../src/learning/miner.js";
import { draftSkillFromPattern } from "../src/learning/candidate.js";
import {
  buildProtocol,
  judgeRun,
  prepareRepoFixture,
  runEvalArm,
  runEvalComparison,
  stableStringify,
  type EvalRunner,
} from "../src/learning/eval.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";

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

describe("P1-3 resume gating (阶段 13)", () => {
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
        if (state.lastSeq > cutSeq)
          db.prepare("DELETE FROM checkpoints WHERE run_id = ? AND seq = ?").run(runId, cp.seq);
      }
      const surviving = new TraceEventRepo(db).getByRun(runId);
      const tracePath = path.join(tmp.dir, ".harness", "traces", `${runId}.jsonl`);
      fs.writeFileSync(tracePath, surviving.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    } finally {
      db.close();
    }
  }

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
    const report = await runEvalComparison(taskSet, { runner, skillName: "s", modelSpec: "m", artifactsDir, repeats: 2 });
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
