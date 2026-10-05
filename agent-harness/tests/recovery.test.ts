import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { openDatabase } from "../src/storage/db.js";
import { TraceEventRepo } from "../src/storage/repos/trace-events.js";
import { RunRepo } from "../src/storage/repos/runs.js";
import { CheckpointRepo } from "../src/storage/repos/checkpoints.js";
import { loadCrashedRun } from "../src/execution/recovery.js";
import { readTraceFile } from "../src/trace/read.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { sendNotificationTool } from "../src/runtime/tools/send-notification.js";
import { readFileTool } from "../src/runtime/tools/read-file.js";
import { ContextWatermarkRepo } from "../src/storage/repos/context-watermarks.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";

const tmp = makeTempCwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

const TOOLS = [sendNotificationTool];

function steps(): AssistantMessage[] {
  return [
    assistantMessage(
      [
        {
          type: "toolCall",
          id: "call_1",
          name: "send_notification",
          arguments: { channel: "email", message: "deploy done" },
        },
      ],
      "toolUse",
    ),
    assistantMessage([{ type: "text", text: "notification sent" }], "stop"),
  ];
}

async function seedRun(prefix: string): Promise<{ runId: string; dbPath: string }> {
  const dbPath = path.join(tmp.dir, prefix, "harness.db");
  const manager = new RunManager();
  const result = await manager.run({
    task: "send a notification and confirm",
    model: FAKE_MODEL,
    streamFn: scriptedStreamFn(steps()),
    reporter: new CollectingReporter(),
    database: dbPath,
    tools: TOOLS,
  });
  manager.close();
  expect(result.record.status).toBe("completed");
  return { runId: result.record.id, dbPath };
}

/**
 * Fabricate a crash around `type` in the durable record: cut the SQLite event
 * log, reset the run row to running, drop checkpoints that would lead the log,
 * and mirror the surviving rows into the JSONL (a real kill truncates both).
 */
function crashAround(dbPath: string, runId: string, type: string, mode: "through" | "before", occurrence = 1): number {
  const db = openDatabase(dbPath);
  try {
    const events = new TraceEventRepo(db).getByRun(runId);
    let idx = -1;
    for (let seen = 0, i = 0; i < events.length; i++) {
      if (events[i]!.type !== type) continue;
      if (++seen === occurrence) {
        idx = i;
        break;
      }
    }
    if (idx === -1) throw new Error(`event ${type} #${occurrence} not found in seeded run`);
    const cutSeq = (mode === "through" ? events[idx] : events[idx - 1])?.seq;
    if (cutSeq === undefined) throw new Error("cut seq undefined");
    db.prepare("DELETE FROM trace_events WHERE run_id = ? AND seq > ?").run(runId, cutSeq);
    db.prepare("UPDATE runs SET status = 'running', finished_at = NULL, error = NULL WHERE id = ?").run(runId);
    for (const cp of new CheckpointRepo(db).list(runId)) {
      const state = cp.state as { lastSeq: number };
      if (state.lastSeq > cutSeq) db.prepare("DELETE FROM checkpoints WHERE run_id = ? AND seq = ?").run(runId, cp.seq);
    }
    const surviving = new TraceEventRepo(db).getByRun(runId);
    const tracePath = path.join(tmp.dir, ".harness", "traces", `${runId}.jsonl`);
    fs.writeFileSync(tracePath, surviving.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    return cutSeq;
  } finally {
    db.close();
  }
}

/** Line count of the shared notification log — assertions use deltas, not absolutes. */
function logLines(): number {
  const log = path.join(tmp.dir, ".harness", "notifications.log");
  if (!fs.existsSync(log)) return 0;
  const content = fs.readFileSync(log, "utf8");
  return content.length === 0 ? 0 : content.trim().split("\n").length;
}

describe("crash recovery (阶段 5/6)", () => {
  it("reconstructs the exact crashed state: transcript, in-flight tool call, lagging checkpoint", async () => {
    const { runId, dbPath } = await seedRun("reconstruct");
    const cutSeq = crashAround(dbPath, runId, "tool_execution_start", "through");

    const db = openDatabase(dbPath);
    const crashed = loadCrashedRun(db, runId, TOOLS);
    db.close();

    expect(crashed.record.status).toBe("running");
    // pi never emits an event for the synthesized system message — the
    // transcript rebuilds as user/assistant; the system prompt comes from the
    // runs row (migration 002).
    expect(crashed.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(crashed.unresolved).toHaveLength(1);
    expect(crashed.unresolved[0]).toMatchObject({
      toolCallId: "call_1",
      toolName: "send_notification",
      state: "executing",
      args: { channel: "email", message: "deploy done" },
    });
    expect(crashed.lastSeq).toBe(cutSeq);
    expect(crashed.checkpoint?.kind).toBe("message_boundary");
    expect(crashed.degradations).toEqual([]); // a healthy record cross-checks clean
    const state = crashed.checkpoint?.state as {
      lastSeq: number;
      messages: number;
      toolCalls: Array<{ state: string }>;
    };
    expect(state.lastSeq).toBeLessThanOrEqual(cutSeq);
    expect(state.messages).toBe(2);
    expect(state.toolCalls).toEqual([{ toolCallId: "call_1", toolName: "send_notification", state: "planned" }]);
  });

  it("加固期第二轮: the lagging checkpoint is cross-checked — losses surface as degradations, never silently", () => {
    const dbPath = path.join(tmp.dir, "crosscheck", "harness.db");
    const db = openDatabase(dbPath);
    try {
      const runId = "run-crosscheck";
      new RunRepo(db).insert({
        id: runId,
        task: "t",
        modelSpec: "m",
        status: "running",
        startedAt: new Date().toISOString(),
      });
      const repo = new TraceEventRepo(db);
      const ts = new Date().toISOString();
      repo.append({ v: 1, seq: 1, ts, runId, type: "run_start", task: "t", modelSpec: "m" } as never);
      repo.append({
        v: 1,
        seq: 2,
        ts,
        runId,
        type: "message_end",
        message: { role: "user", content: "x", timestamp: 1 },
      } as never);
      repo.append({
        v: 1,
        seq: 3,
        ts,
        runId,
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_live", name: "send_notification", arguments: {} }],
          timestamp: 2,
        },
      } as never);
      // The checkpoint claims state the trace no longer holds: one extra
      // message, a seq horizon past the log's end, and a pending call whose
      // requesting message vanished.
      new CheckpointRepo(db).append(runId, "message_boundary", {
        lastSeq: 4,
        messages: 3,
        toolCalls: [{ toolCallId: "call_ghost", toolName: "ghost", state: "planned" }],
      });

      const crashed = loadCrashedRun(db, runId, TOOLS);
      expect(crashed.degradations).toHaveLength(3);
      const joined = crashed.degradations.join("\n");
      expect(joined).toMatch(/counted 3 message\(s\) but the trace holds only 2/);
      expect(joined).toMatch(/claims trace seq 4 but the log ends at 3/);
      expect(joined).toMatch(/call_ghost.*requesting message was lost/);
      // the call that IS in the trace stays silent
      expect(joined).not.toContain("call_live");
    } finally {
      db.close();
    }
  });

  it("加固期第二轮: resume restarts a run killed between the sinks of its first trace event (traced, nothing executed)", async () => {
    const dbPath = path.join(tmp.dir, "empty-ledger", "harness.db");
    const runId = "run-empty-ledger";
    const db = openDatabase(dbPath);
    new RunRepo(db).insert({
      id: runId,
      task: "send a notification and confirm",
      modelSpec: "fake-model",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    db.close();
    // The between-sinks window: run_start reached the JSONL but never SQLite.
    // reconcile clears the lone remnant — leaving the trace FILE (empty)
    // behind, which is the proof of a traced run the restart gate requires.
    const tracesPath = path.join(tmp.dir, ".harness", "traces");
    fs.mkdirSync(tracesPath, { recursive: true });
    fs.writeFileSync(
      path.join(tracesPath, `${runId}.jsonl`),
      JSON.stringify({
        v: 1,
        seq: 1,
        ts: new Date().toISOString(),
        runId,
        type: "run_start",
        task: "send a notification and confirm",
        modelSpec: "fake-model",
      }) + "\n",
      "utf8",
    );
    const before = logLines();

    const manager = new RunManager();
    const result = await manager.resume(runId, {
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(steps()),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: TOOLS,
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    expect(logLines()).toBe(before + 1); // the task really ran once
    const trace = readTraceFile(result.tracePath as string);
    expect(trace.events[0]).toMatchObject({ type: "run_start", seq: 1 });
    expect(trace.events.at(-1)).toMatchObject({ type: "run_end", status: "completed" });
  });

  it("加固期第五轮: refuses to restart a trace-less run with an empty ledger (no proof anything was traced)", async () => {
    const dbPath = path.join(tmp.dir, "traceless", "harness.db");
    const runId = "run-traceless";
    const db = openDatabase(dbPath);
    new RunRepo(db).insert({
      id: runId,
      task: "send a notification and confirm",
      modelSpec: "fake-model",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    db.close();
    // No trace file, no checkpoints, no watermark, no evidence: with `trace:
    // false` a run can have executed tools and still leave this exact state —
    // an unprovable restart must refuse (side effects could duplicate).
    const manager = new RunManager();
    await expect(
      manager.resume(runId, {
        model: FAKE_MODEL,
        streamFn: scriptedStreamFn([]),
        reporter: new CollectingReporter(),
        database: dbPath,
        tools: TOOLS,
      }),
    ).rejects.toThrow(/no trace to recover/);
    manager.close();
  });

  it("加固期第二轮: refuses to restart when a checkpoint proves the lost ledger had progressed", async () => {
    const { runId, dbPath } = await seedRun("guard-checkpoint");
    const db = openDatabase(dbPath);
    db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(runId);
    db.prepare("UPDATE runs SET status = 'running', finished_at = NULL, error = NULL WHERE id = ?").run(runId);
    db.close();
    fs.rmSync(path.join(tmp.dir, ".harness", "traces", `${runId}.jsonl`), { force: true });

    const manager = new RunManager();
    await expect(
      manager.resume(runId, {
        model: FAKE_MODEL,
        streamFn: scriptedStreamFn([]),
        reporter: new CollectingReporter(),
        database: dbPath,
        tools: TOOLS,
      }),
    ).rejects.toThrow(/refusing to restart/);
    manager.close();
  });

  it("加固期第二轮: refuses to restart when evidence files prove prior tool activity", async () => {
    const { runId, dbPath } = await seedRun("guard-evidence");
    const db = openDatabase(dbPath);
    db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM checkpoints WHERE run_id = ?").run(runId);
    db.prepare("UPDATE runs SET status = 'running', finished_at = NULL, error = NULL WHERE id = ?").run(runId);
    db.close();
    fs.rmSync(path.join(tmp.dir, ".harness", "traces", `${runId}.jsonl`), { force: true });

    const manager = new RunManager();
    await expect(
      manager.resume(runId, {
        model: FAKE_MODEL,
        streamFn: scriptedStreamFn([]),
        reporter: new CollectingReporter(),
        database: dbPath,
        tools: TOOLS,
      }),
    ).rejects.toThrow(/evidence file/);
    manager.close();
  });

  it("executing + replay:never → synthesizes an error result; delivery happens exactly once", async () => {
    const { runId, dbPath } = await seedRun("synthesize");
    crashAround(dbPath, runId, "tool_execution_start", "through");
    const before = logLines(); // the seed's real delivery

    const manager = new RunManager();
    const result = await manager.resume(runId, {
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "I could not confirm delivery." }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: TOOLS,
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    expect(logLines()).toBe(before); // no duplicate delivery

    const toolResults = result.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    if (toolResults[0]?.role === "toolResult") {
      expect(toolResults[0].isError).toBe(true);
      expect(toolResults[0].content.some((b) => b.type === "text" && b.text.includes("outcome is unknown"))).toBe(true);
    }
    const trace = readTraceFile(result.tracePath as string);
    expect(trace.events.some((e) => e.type === "recovery_action" && e.action === "synthesize_error")).toBe(true);
    expect(trace.events.at(-1)).toMatchObject({ type: "run_end", status: "completed" });
  });

  it("executed-no-result → rebuilds the toolResult from the recorded execution without re-running the tool", async () => {
    const { runId, dbPath } = await seedRun("rebuild");
    crashAround(dbPath, runId, "tool_execution_end", "through");
    const before = logLines();

    const manager = new RunManager();
    const result = await manager.resume(runId, {
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "done" }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: TOOLS,
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    expect(logLines()).toBe(before); // no re-execution
    const trace = readTraceFile(result.tracePath as string);
    expect(trace.events.some((e) => e.type === "recovery_action" && e.action === "rebuild_result")).toBe(true);
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    if (toolResult?.role === "toolResult") expect(toolResult.isError).toBe(false);
  });

  it("planned → re-executes the durable intent (it provably never started)", async () => {
    const { runId, dbPath } = await seedRun("reexecute");
    crashAround(dbPath, runId, "tool_execution_start", "before");
    const before = logLines(); // includes the seed run's real delivery; the fabricated
    // crash hides it, so from the durable record alone the call looks never-started —
    // recovery completes the intent and the +1 delta documents that trade-off.

    const manager = new RunManager();
    const result = await manager.resume(runId, {
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "done" }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: TOOLS,
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    expect(logLines()).toBe(before + 1); // exactly one recovery delivery
    const trace = readTraceFile(result.tracePath as string);
    expect(trace.events.some((e) => e.type === "recovery_action" && e.action === "reexecute")).toBe(true);
  });

  it("listInterrupted surfaces resumable runs; finished runs are rejected", async () => {
    const { runId, dbPath } = await seedRun("guard");
    const manager = new RunManager();

    // A completed run is neither a candidate nor resumable.
    expect(manager.listInterrupted(dbPath).map((r) => r.id)).toEqual([]);
    await expect(manager.resume(runId, { database: dbPath, model: FAKE_MODEL })).rejects.toThrow(/not resumable/);

    crashAround(dbPath, runId, "tool_execution_start", "through");
    expect(manager.listInterrupted(dbPath).map((r) => r.id)).toEqual([runId]);
    manager.close();
  });

  it("resume restores the stored toolset: an unresolved coding call is recovered, not synthesized away", async () => {
    fs.writeFileSync(path.join(tmp.dir, "note.txt"), "hello from the workspace\n", "utf8");
    const dbPath = path.join(tmp.dir, "toolset-restore", "harness.db");
    const seeder = new RunManager();
    const seed = await seeder.run({
      task: "read the note",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([
        assistantMessage(
          [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "note.txt" } }],
          "toolUse",
        ),
        assistantMessage([{ type: "text", text: "read done" }], "stop"),
      ]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: "coding",
    });
    seeder.close();
    expect(seed.record.status).toBe("completed");
    expect(seed.record.toolset).toBe("coding");
    crashAround(dbPath, seed.record.id, "tool_execution_start", "through");

    // No `tools` option here: the run row's "coding" spec must be restored
    // (migration 012). With the old demo default, recovery would synthesize a
    // "not registered in this session" error for the read call instead.
    const manager = new RunManager();
    const result = await manager.resume(seed.record.id, {
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "resumed fine" }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    const toolResults = result.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    if (toolResults[0]?.role === "toolResult") {
      expect(toolResults[0].isError).toBe(false);
      expect(toolResults[0].content.some((b) => b.type === "text" && b.text.includes("hello from the workspace"))).toBe(
        true,
      );
    }
    const trace = readTraceFile(result.tracePath as string);
    expect(trace.events.some((e) => e.type === "recovery_action" && e.action === "synthesize_error")).toBe(false);
    expect(trace.events.some((e) => e.type === "recovery_action" && e.action === "reexecute")).toBe(true);
  });

  it("加固期第四轮: a persisted watermark survives the crash and resume continues it (no re-summarization)", async () => {
    fs.writeFileSync(path.join(tmp.dir, "wm-a.txt"), "ALPHA-" + "a".repeat(2000), "utf8");
    fs.writeFileSync(path.join(tmp.dir, "wm-b.txt"), "BRAVO-" + "b".repeat(2000), "utf8");
    fs.writeFileSync(path.join(tmp.dir, "wm-c.txt"), "CHARLIE-" + "c".repeat(2000), "utf8");
    fs.writeFileSync(path.join(tmp.dir, "wm-d.txt"), "DELTA-" + "d".repeat(2000), "utf8");
    const dbPath = path.join(tmp.dir, "watermark", "harness.db");
    const summaryJson = JSON.stringify({
      current_objective: "read the files",
      user_constraints: [],
      key_decisions: [],
      completed_work: [],
      current_state: [],
      pending_work: [],
      important_facts: [],
    });
    const readStep = (id: string, file: string) =>
      assistantMessage([{ type: "toolCall", id, name: "read_file", arguments: { path: file } }], "toolUse");
    // 小窗口强制压缩：第 4 次请求时水位线覆盖 user + r1，第 5 次推进到 r2。
    const seeder = new RunManager();
    const seed = await seeder.run({
      task: "read three files in order",
      model: { ...FAKE_MODEL, contextWindow: 300 },
      streamFn: scriptedStreamFn([
        readStep("r1", "wm-a.txt"),
        readStep("r2", "wm-b.txt"),
        readStep("r3", "wm-c.txt"),
        readStep("r4", "wm-d.txt"),
        assistantMessage([{ type: "text", text: "all done" }], "stop"),
      ]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [readFileTool],
      context: { summaryChat: async () => summaryJson },
    });
    seeder.close();
    expect(seed.record.status).toBe("completed");

    // 完成态的行保留在库里（prune 回收）；手术把它变成真实的"in-flight 崩溃"。
    const db0 = openDatabase(dbPath);
    const persisted = new ContextWatermarkRepo(db0).get(seed.record.id);
    db0.close();
    expect(persisted).toBeTruthy();
    expect(persisted!.coveredCount).toBe(5);
    crashAround(dbPath, seed.record.id, "tool_execution_start", "through", 4);

    const resumedPrompts: string[] = [];
    const manager = new RunManager();
    const result = await manager.resume(seed.record.id, {
      model: { ...FAKE_MODEL, contextWindow: 300 },
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "resumed fine" }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [readFileTool],
      context: {
        summaryChat: async (turns) => {
          resumedPrompts.push(turns[0]!.content);
          return summaryJson;
        },
      },
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    // 续用持久化水位线：恢复段第一次摘要的材料只含未覆盖的尾部——CHARLIE（r3）
    // 在材料里（恰越 256 下限即停，DELTA/r4 作为最新受保护轮保持原样）；
    // ALPHA/BRAVO 已被覆盖，绝不重新进入摘要（未持久化时水位线从 0 重建，
    // 材料会从头包含 ALPHA/BRAVO）。
    const first = resumedPrompts[0]!;
    expect(first).toContain("CHARLIE");
    expect(first).not.toContain("DELTA");
    expect(first).not.toContain("ALPHA");
    expect(first).not.toContain("BRAVO");
  });

  it("加固期第四轮: refuses to restart when only a persisted watermark proves progress", async () => {
    const { runId, dbPath } = await seedRun("guard-watermark");
    const db = openDatabase(dbPath);
    db.prepare("DELETE FROM trace_events WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM checkpoints WHERE run_id = ?").run(runId);
    db.prepare("UPDATE runs SET status = 'running', finished_at = NULL, error = NULL WHERE id = ?").run(runId);
    // seedRun 的模型窗口很大、无压缩——此处直接构造该记录（守卫只关心存在性）。
    db.prepare("INSERT INTO context_watermarks (run_id, watermark_json, updated_at) VALUES (?, ?, ?)").run(
      runId,
      JSON.stringify({ coveredCount: 1, summary: { current_objective: "t" } }),
      new Date().toISOString(),
    );
    db.close();
    fs.rmSync(path.join(tmp.dir, ".harness", "traces", `${runId}.jsonl`), { force: true });

    const manager = new RunManager();
    await expect(
      manager.resume(runId, {
        model: FAKE_MODEL,
        streamFn: scriptedStreamFn([]),
        reporter: new CollectingReporter(),
        database: dbPath,
        tools: TOOLS,
      }),
    ).rejects.toThrow(/persisted context watermark/);
    manager.close();
  });
});
