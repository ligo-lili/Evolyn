import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { openDatabase } from "../src/storage/db.js";
import { TraceEventRepo } from "../src/storage/repos/trace-events.js";
import { CheckpointRepo } from "../src/storage/repos/checkpoints.js";
import { loadCrashedRun } from "../src/execution/recovery.js";
import { readTraceFile } from "../src/trace/read.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { sendNotificationTool } from "../src/runtime/tools/send-notification.js";
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
function crashAround(dbPath: string, runId: string, type: string, mode: "through" | "before"): number {
  const db = openDatabase(dbPath);
  try {
    const events = new TraceEventRepo(db).getByRun(runId);
    const idx = events.findIndex((e) => e.type === type);
    if (idx === -1) throw new Error(`event ${type} not found in seeded run`);
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
    const state = crashed.checkpoint?.state as {
      lastSeq: number;
      messages: number;
      toolCalls: Array<{ state: string }>;
    };
    expect(state.lastSeq).toBeLessThanOrEqual(cutSeq);
    expect(state.messages).toBe(2);
    expect(state.toolCalls).toEqual([{ toolCallId: "call_1", toolName: "send_notification", state: "planned" }]);
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
});
