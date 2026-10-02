import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { applyFaultToTools, FaultController, parseFaultSpec } from "../src/execution/fault.js";
import { sendNotificationTool } from "../src/runtime/tools/send-notification.js";
import { openDatabase } from "../src/storage/db.js";
import { RunRepo } from "../src/storage/repos/runs.js";
import { TraceEventRepo } from "../src/storage/repos/trace-events.js";
import { readTraceFile } from "../src/trace/read.js";
import { makeTempCwd } from "./helpers.js";

const tmp = makeTempCwd();
// The driver children resolve dist + node_modules relative to the package —
// capture the package root before any chdir.
const PACKAGE_ROOT = process.cwd();
const DRIVER = path.join(PACKAGE_ROOT, "scripts", "chaos-driver.mjs");
const DIST = path.join(PACKAGE_ROOT, "dist", "index.js");

afterEach(() => tmp.leave());

describe("fault injection (阶段 5)", () => {
  it("parses fault specs", () => {
    expect(parseFaultSpec(undefined)).toBeUndefined();
    expect(parseFaultSpec("after_tool_call:send_notification")).toEqual({
      point: "after_tool_call",
      toolName: "send_notification",
    });
    expect(() => parseFaultSpec("nope:tool")).toThrow(/unknown fault point/);
    expect(() => parseFaultSpec("after_tool_call:")).toThrow(/tool name/);
  });

  it("mid_tool_execution: side effect lands, then kill fires before the result is used", async () => {
    tmp.enter();
    const kills: string[] = [];
    const wrapped = applyFaultToTools(
      [sendNotificationTool],
      { point: "mid_tool_execution", toolName: "send_notification" },
      () => kills.push("kill"),
    );

    const result = await wrapped[0]!.execute("t1", { channel: "email", message: "deploy done" });

    expect(result.details.receiptId).toBeTruthy();
    expect(kills).toEqual(["kill"]);
    const log = fs.readFileSync(path.join(tmp.dir, ".harness", "notifications.log"), "utf8");
    expect(log).toContain("deploy done");
    tmp.leave();
  });

  it("leaves non-matching tools untouched", () => {
    const wrapped = applyFaultToTools(
      [sendNotificationTool],
      { point: "mid_tool_execution", toolName: "read_file" },
      () => {},
    );
    expect(wrapped[0]).toBe(sendNotificationTool);
  });

  it("FaultController fires only on the matching tool_execution_end", () => {
    const kills: string[] = [];
    const controller = new FaultController({ point: "after_tool_call", toolName: "send_notification" }, () =>
      kills.push("k"),
    );

    controller.onEvent({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "read_file",
      result: { content: [], details: undefined },
      isError: false,
    });
    expect(kills).toEqual([]);

    controller.onEvent({
      type: "tool_execution_end",
      toolCallId: "2",
      toolName: "send_notification",
      result: { content: [], details: undefined },
      isError: false,
    });
    expect(kills).toEqual(["k"]);
  });
});

// ---------- 加固期第三轮: fault windows E2E — REAL child kills ----------

/**
 * The driver child runs one RunManager episode with the deterministic
 * transcript-driven stream and KILLS ITSELF at the requested fault point
 * (process.exit(137)); the parent inspects the durable state, chains another
 * child for the resume, and asserts the invariants over the final trace.
 * Requires a prior `npm run build` (the driver imports dist/).
 */
describe.skipIf(!fs.existsSync(DIST))("fault windows E2E (加固期第三轮, real process kills)", () => {
  function spawnDriver(args: string[], cwd: string) {
    const child = spawn(process.execPath, [DRIVER, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    return {
      child,
      getStdout: () => stdout,
      getStderr: () => stderr,
      waitForExit: (timeoutMs = 30_000) =>
        new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`driver did not exit within ${timeoutMs}ms (stderr: ${stderr.slice(0, 300)})`));
          }, timeoutMs);
          child.once("exit", (code) => {
            clearTimeout(timer);
            resolve(code ?? -1);
          });
        }),
    };
  }

  function readTrace(dbPath: string, runId: string) {
    const db = openDatabase(dbPath);
    try {
      return {
        events: new TraceEventRepo(db).getByRun(runId),
        runRow: new RunRepo(db).get(runId),
      };
    } finally {
      db.close();
    }
  }

  it("between_sinks: JSONL ahead of SQLite, resume completes (no duplicate seqs)", async () => {
    tmp.enter();
    const ws = path.join(tmp.dir, "e2e-sinks");
    fs.mkdirSync(ws, { recursive: true });
    const dbPath = path.join(ws, "harness.db");

    const killed = spawnDriver(["run", dbPath, "between_sinks:message_end"], ws);
    const killCode = await killed.waitForExit();
    expect(killCode).toBe(137); // the fault killed the child

    // SQLite only got run_start — the message_end landed in JSONL, then the kill.
    const db = openDatabase(dbPath);
    let runId: string;
    let types: string[];
    try {
      const running = new RunRepo(db).getByStatus("running");
      runId = running[0]!.id;
      types = new TraceEventRepo(db).getByRun(runId).map((e) => e.type);
    } finally {
      db.close();
    }
    expect(types.at(-1)).toBe("message_start");
    expect(types).not.toContain("message_end");

    const resumed = spawnDriver(["resume", runId, dbPath], ws);
    const resumeCode = await resumed.waitForExit();
    expect(resumeCode).toBe(0);

    const final = readTrace(dbPath, runId);
    expect(final.runRow?.status).toBe("completed");
    expect(fs.readFileSync(path.join(ws, "out-1.txt"), "utf8")).toBe("payload 1");
    const log = path.join(ws, ".harness", "notifications.log");
    const deliveries = fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l.trim()).length
      : 0;
    expect(deliveries).toBe(8); // the 24-step plan delivers 8 notifications
  }, 40_000);

  it("after_assistant_message (planned window): the pending call executes on resume", async () => {
    tmp.enter();
    const ws = path.join(tmp.dir, "e2e-planned");
    fs.mkdirSync(ws, { recursive: true });
    const dbPath = path.join(ws, "harness.db");

    const killed = spawnDriver(["run", dbPath, "after_assistant_message:write_file"], ws);
    expect(await killed.waitForExit()).toBe(137);

    const db = openDatabase(dbPath);
    let runId: string;
    let lastType: string;
    let lastMessage: { role?: string; content?: Array<{ type: string }> } | undefined;
    let starts: number;
    try {
      runId = new RunRepo(db).getByStatus("running")[0]!.id;
      const events = new TraceEventRepo(db).getByRun(runId);
      const last = events.at(-1)!;
      lastType = last.type;
      lastMessage = (last as unknown as { message?: { role: string; content: Array<{ type: string }> } }).message;
      starts = events.filter((e) => e.type === "tool_execution_start").length;
    } finally {
      db.close();
    }
    // The planned-window assertions: the tool call is durably recorded but the
    // tool never started.
    expect(lastType).toBe("message_end");
    expect(lastMessage?.role).toBe("assistant");
    expect(lastMessage?.content.some((b) => b.type === "toolCall")).toBe(true);
    expect(starts).toBe(0);

    const resumed = spawnDriver(["resume", runId, dbPath], ws);
    expect(await resumed.waitForExit()).toBe(0);

    const final = readTrace(dbPath, runId);
    expect(final.runRow?.status).toBe("completed");
    expect(fs.readFileSync(path.join(ws, "out-1.txt"), "utf8")).toBe("payload 1");
    expect(
      final.events.some(
        (e) => e.type === "recovery_action" && (e as unknown as { action: string }).action === "reexecute",
      ),
    ).toBe(true);
    const log = path.join(ws, ".harness", "notifications.log");
    const deliveries = fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l.trim()).length
      : 0;
    expect(deliveries).toBe(8); // the 24-step plan delivers 8 notifications
  }, 40_000);

  it("mid_recovery: killed between recovery decisions, the next resume stitches and completes", async () => {
    tmp.enter();
    const ws = path.join(tmp.dir, "e2e-recovery");
    fs.mkdirSync(ws, { recursive: true });
    const dbPath = path.join(ws, "harness.db");

    // Crash 1: mid_tool_execution — the notification delivered, result unknown.
    const first = spawnDriver(["run", dbPath, "mid_tool_execution:send_notification"], ws);
    expect(await first.waitForExit()).toBe(137);

    const db1 = openDatabase(dbPath);
    let runId: string;
    try {
      runId = new RunRepo(db1).getByStatus("running")[0]!.id;
    } finally {
      db1.close();
    }

    // Crash 2: the resume itself is killed AFTER resolving the one call.
    const second = spawnDriver(["resume", runId, dbPath, "mid_recovery:1"], ws);
    expect(await second.waitForExit()).toBe(137);

    const afterSecond = readTrace(dbPath, runId);
    expect(afterSecond.runRow?.status).toBe("running");
    expect(
      afterSecond.events.some(
        (e) => e.type === "recovery_action" && (e as unknown as { action: string }).action === "synthesize_error",
      ),
    ).toBe(true);

    // Resume 3: clean — stitches the recovered state and completes.
    const third = spawnDriver(["resume", runId, dbPath], ws);
    expect(await third.waitForExit()).toBe(0);

    const final = readTrace(dbPath, runId);
    expect(final.runRow?.status).toBe("completed");
    // Side-effect conservation across ALL THREE segments: exactly one delivery.
    const log = path.join(ws, ".harness", "notifications.log");
    const deliveries = fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
    expect(deliveries).toBe(8); // the 24-step plan delivers 8 notifications
    // The whole episode is one valid trace (same run id, continuous seqs).
    expect(() => readTraceFile(path.join(ws, ".harness", "traces", `${runId}.jsonl`))).not.toThrow();
  }, 60_000);
});
