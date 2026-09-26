import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { openDatabase } from "../src/storage/db.js";
import { TraceEventRepo } from "../src/storage/repos/trace-events.js";
import { collectErrors, summarize } from "../src/trace/query.js";
import { explain, ReplayMachine } from "../src/trace/replay.js";
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
      [{ type: "toolCall", id: "call_1", name: "send_notification", arguments: { channel: "email", message: "deploy done" } }],
      "toolUse",
    ),
    assistantMessage([{ type: "text", text: "notification sent" }], "stop"),
  ];
}

async function seedRun(prefix: string, streamFn = scriptedStreamFn(steps())): Promise<string> {
  const manager = new RunManager();
  const result = await manager.run({
    task: "send a notification and confirm",
    model: FAKE_MODEL,
    streamFn,
    reporter: new CollectingReporter(),
    database: path.join(tmp.dir, prefix, "harness.db"),
    tools: TOOLS,
  });
  manager.close();
  return result.record.id;
}

function loadEvents(dbPath: string, runId: string) {
  const db = openDatabase(dbPath);
  try {
    return new TraceEventRepo(db).getByRun(runId);
  } finally {
    db.close();
  }
}

describe("trace replay (阶段 7)", () => {
  it("replays every event and rebuilds the final state (完成标准：逐事件一致)", async () => {
    const dbPath = path.join(tmp.dir, "full", "harness.db");
    const runId = await seedRun("full");
    const events = loadEvents(dbPath, runId);

    const machine = ReplayMachine.replay(events);
    const s = machine.state;

    expect(s.consumed).toBe(events.length);
    expect(s.seq).toBe(events.at(-1)?.seq);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(s.messageSeqs).toHaveLength(s.messages.length);
    expect(s.task).toBe("send a notification and confirm");
    expect(s.runEnd).toMatchObject({ status: "completed" });

    const calls = [...s.calls.values()];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolCallId: "call_1", toolName: "send_notification", state: "executed", resolved: true, isError: false });
    expect(machine.pendingCalls()).toEqual([]);
  });

  it("prefix replay reproduces the crash-point state and explains why (完成标准：为什么可答)", async () => {
    const dbPath = path.join(tmp.dir, "prefix", "harness.db");
    const runId = await seedRun("prefix");
    const events = loadEvents(dbPath, runId);
    const startSeq = events.find((e) => e.type === "tool_execution_start")?.seq;
    expect(startSeq).toBeDefined();

    const { state, why } = explain(events, startSeq);
    expect(state.consumed).toBe(events.filter((e) => e.seq <= (startSeq as number)).length);
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(state.runEnd).toBeUndefined();

    const pending = ReplayMachine.replay(events.filter((e) => e.seq <= (startSeq as number))).pendingCalls();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toolCallId: "call_1", toolName: "send_notification", state: "executing" });

    expect(why.join("\n")).toContain("没有 run_end");
    expect(why.join("\n")).toContain("结果未知");
  });

  it("summarize aggregates turns, tool calls, tokens and status", async () => {
    const dbPath = path.join(tmp.dir, "summary", "harness.db");
    const runId = await seedRun("summary");
    const summary = summarize(loadEvents(dbPath, runId));

    expect(summary.runId).toBe(runId);
    expect(summary.status).toBe("completed");
    expect(summary.interrupted).toBe(false);
    expect(summary.assistantTurns).toBe(2);
    expect(summary.toolCalls).toEqual([{ toolName: "send_notification", calls: 1, errors: 0 }]);
    expect(summary.tokens.total).toBe(30); // 2 scripted calls × 15 tokens
    expect(summary.errorCount).toBe(0);
    expect(summary.recoveryActions).toBe(0);
  });

  it("errors surface in the summary and in collectErrors", async () => {
    const errorSteps = () => [
      assistantMessage(
        [{ type: "toolCall", id: "call_bad", name: "send_notification", arguments: { channel: "email", message: "x" } }],
        "toolUse",
      ),
      assistantMessage([{ type: "text", text: "gave up" }], "stop"),
    ];
    // make the tool fail by pointing send_notification at a read-only fs? simplest: escape via write_file is
    // a different tool; instead deny via approval — the denial is an isError tool result.
    const manager = new RunManager();
    const result = await manager.run({
      task: "send a notification",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(errorSteps()),
      reporter: new CollectingReporter(),
      database: path.join(tmp.dir, "errors", "harness.db"),
      tools: TOOLS,
      approval: { mode: "auto-deny" },
    });
    manager.close();
    const events = loadEvents(path.join(tmp.dir, "errors", "harness.db"), result.record.id);

    const summary = summarize(events);
    expect(summary.errorCount).toBeGreaterThanOrEqual(1);
    expect(summary.approvalDenials).toBe(1);
    const errors = collectErrors(events);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.type === "tool_execution_end" && e.isError)).toBe(true);
  });

  it("explains a model-failed run by naming the error", async () => {
    const failed = assistantMessage([{ type: "text", text: "" }], "error", "boom");
    const manager = new RunManager();
    const result = await manager.run({
      task: "anything",
      model: FAKE_MODEL,
      streamFn: () => {
        const stream = new AssistantMessageEventStream();
        stream.push({ type: "start", partial: failed });
        stream.push({ type: "error", reason: "error", error: failed });
        return stream;
      },
      reporter: new CollectingReporter(),
      database: path.join(tmp.dir, "failed", "harness.db"),
      tools: TOOLS,
    });
    manager.close();
    expect(result.record.status).toBe("failed");

    const { why } = explain(loadEvents(path.join(tmp.dir, "failed", "harness.db"), result.record.id));
    expect(why.join("\n")).toContain('error="boom"');
  });
});
