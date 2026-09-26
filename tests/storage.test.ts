import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { openDatabase } from "../src/storage/db.js";
import { RunRepo } from "../src/storage/repos/runs.js";
import { TraceEventRepo } from "../src/storage/repos/trace-events.js";
import { CheckpointRepo } from "../src/storage/repos/checkpoints.js";
import { readTraceFile } from "../src/trace/read.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";

const tmp = makeTempCwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

function writeHelloSteps(): AssistantMessage[] {
  return [
    assistantMessage(
      [{ type: "toolCall", id: "call_1", name: "write_file", arguments: { path: "out/hello.txt", content: "hello harness" } }],
      "toolUse",
    ),
    assistantMessage([{ type: "text", text: "done: wrote out/hello.txt" }], "stop"),
  ];
}

describe("SQLite storage", () => {
  it("dual-writes trace events to JSONL and SQLite with identical content", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "data", "harness.db");
    const manager = new RunManager();

    const result = await manager.run({
      task: "write out/hello.txt",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(writeHelloSteps()),
      reporter: new CollectingReporter(),
      database: dbPath,
    });
    manager.close();

    expect(result.record.status).toBe("completed");

    // Reopen (not the same connection): both stores must agree event for event.
    const jsonl = readTraceFile(result.tracePath as string);
    const db = openDatabase(dbPath);
    try {
      const repo = new TraceEventRepo(db);
      expect(repo.getByRun(result.record.id)).toEqual(jsonl.events);
      expect(repo.countByRun(result.record.id)).toBe(jsonl.events.length);

      const toolCalls = repo.queryToolCalls("write_file", result.record.id);
      expect(toolCalls.length).toBeGreaterThanOrEqual(2); // exec start + exec_done + tool_result carry tool_name
      expect(repo.queryErrors(result.record.id)).toHaveLength(0);

      const runs = new RunRepo(db);
      expect(runs.get(result.record.id)?.status).toBe("completed");
      expect(runs.getByStatus("running")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("persists error tool results so queryErrors finds them", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "err", "harness.db");
    const steps = [
      assistantMessage(
        [{ type: "toolCall", id: "call_bad", name: "write_file", arguments: { path: "../escape.txt", content: "x" } }],
        "toolUse",
      ),
      assistantMessage([{ type: "text", text: "the write was rejected; stopping." }], "stop"),
    ];
    const manager = new RunManager();
    const result = await manager.run({
      task: "try to escape the workspace",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(steps),
      reporter: new CollectingReporter(),
      database: dbPath,
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    const db = openDatabase(dbPath);
    try {
      const errors = new TraceEventRepo(db).queryErrors(result.record.id);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => e.type === "tool_execution_end" && e.isError === true)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("assigns checkpoint seq per run and returns the latest", () => {
    tmp.enter();
    const db = openDatabase(path.join(tmp.dir, "cp", "harness.db"));
    try {
      // checkpoints.run_id → runs(id): the runs rows must exist first.
      const runs = new RunRepo(db);
      const base = { task: "t", modelSpec: "test/fake-model", startedAt: "t0" };
      runs.insert({ ...base, id: "run-1", status: "running" });
      runs.insert({ ...base, id: "run-2", status: "running" });

      const repo = new CheckpointRepo(db);
      repo.append("run-1", "message_boundary", { messages: 3 });
      repo.append("run-1", "tool_call", { toolCallId: "c1" });
      repo.append("run-2", "message_boundary", { messages: 1 });
      expect(repo.latest("run-1")).toMatchObject({ seq: 2, kind: "tool_call" });
      expect(repo.latest("run-2")).toMatchObject({ seq: 1, kind: "message_boundary" });
      expect(repo.list("run-1")).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("migrations are idempotent across reopen", () => {
    tmp.enter();
    const p = path.join(tmp.dir, "mig", "harness.db");
    openDatabase(p).close();
    const db = openDatabase(p);
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: unknown };
      expect(Number(row.n)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("committed data survives a hard process kill (WAL)", async () => {
    tmp.enter();
    const dbPath = path.join(tmp.dir, "wal", "harness.db");
    openDatabase(dbPath).close(); // create schema, then hand the file to the victim

    const script = path.join(tmp.dir, "kill-writer.mjs");
    fs.writeFileSync(
      script,
      `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=NORMAL");
db.exec("BEGIN");
db.prepare("INSERT INTO runs (id, task, model_spec, status, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
  .run("kill-run", "killed task", "test/fake-model", "running", "t0", "t0");
for (let i = 1; i <= 10; i++) {
  db.prepare("INSERT INTO trace_events (run_id, seq, ts, type, schema_version, tool_name, is_error, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("kill-run", i, "t", "message_end", 1, null, null, JSON.stringify({ runId: "kill-run", seq: i }));
}
db.exec("COMMIT");
console.log("READY");
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child never became READY")), 10_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`child exited before READY (code ${code})`));
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (String(chunk).includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    child.kill("SIGKILL");
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("child did not die")), 5_000)),
    ]);
    expect(code).not.toBe(0); // hard kill, not a clean exit

    // "Restart": a fresh connection must see every committed row.
    const db = openDatabase(dbPath);
    try {
      const repo = new TraceEventRepo(db);
      expect(repo.countByRun("kill-run")).toBe(10);
      expect(repo.getByRun("kill-run").map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(new RunRepo(db).get("kill-run")?.status).toBe("running");
    } finally {
      db.close();
    }
  });
});
