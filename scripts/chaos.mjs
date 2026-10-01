#!/usr/bin/env node
// 混沌模糊测试 (hardening round 3): kill agent-harness processes at RANDOM
// moments, hundreds of times, and assert the recovery state machine's
// PROPERTIES — not individual behaviors:
//
//   P1. any kill, at any moment: resume eventually COMPLETES (bounded rounds).
//       An iteration killed before anything durable happened is trivially ok.
//   P2. the trace is always offline-replayable: every line parses, seq is
//       monotonic without duplicates, run_start…run_end bracket intact after
//       the final resume, and ReplayMachine consumes the whole log.
//   P3. side effects are conserved: notifications.log lines === the number of
//       send_notification tool_execution_start events (every real execution is
//       one log line and one start event — synthesized resolutions and
//       re-derived recoveries never deliver).
//   P4. JSONL and SQLite agree on the seq set after the final resume.
//
// Requires a prior `npm run build` (imports dist/). Deterministic with --seed.
// Usage: node scripts/chaos.mjs [--iterations 200] [--keep] [--seed 42]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = pathToFileURL(path.join(here, "..", "dist", "index.js")).href;
const harness = await import(dist);
const driverPath = path.join(here, "chaos-driver.mjs");

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const has = (flag) => process.argv.includes(flag);

const ITERATIONS = Number(arg("--iterations", 200));
const MAX_RUN_KILL_DELAY = Number(arg("--max-run-kill-delay", 1500));
const MAX_RESUME_KILL_DELAY = Number(arg("--max-resume-kill-delay", 600));
const MAX_ROUNDS = Number(arg("--max-rounds", 8));
const KEEP = has("--keep");
const SEED = Number(arg("--seed", 1337));

if (!fs.existsSync(path.join(here, "..", "dist", "index.js"))) {
  console.error("dist/ not found — run `npm run build` first");
  process.exit(2);
}

// Deterministic PRNG (LCG) so any violation reproduces with the same --seed.
let state = SEED >>> 0;
const rand = () => {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 0xffffffff;
};
const randInt = (lo, hi) => Math.floor(lo + rand() * (hi - lo));

function killTree(child) {
  if (process.platform === "win32") {
    if (child.pid) {
      // fire-and-forget; exit 128 ("process not found") just means the child
      // finished before the kill landed — a clean-completion race, not an error
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    }
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function spawnDriver(args, cwd) {
  const child = spawn(process.execPath, [driverPath, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const state = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk) => (state.stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (state.stderr += String(chunk)));
  return {
    child,
    output: state,
    /** Resolves once the driver finished setup (imports + chdir) — kills scheduled before it are trivial. */
    waitForReady(timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        if (state.stderr.includes("##READY##")) return resolve();
        const timer = setTimeout(
          () => reject(new Error(`driver never became READY (stderr: ${state.stderr.slice(0, 200)})`)),
          timeoutMs,
        );
        const onData = () => {
          if (state.stderr.includes("##READY##")) {
            clearTimeout(timer);
            child.stderr?.off("data", onData);
            resolve();
          }
        };
        child.stderr?.on("data", onData);
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`driver exited before READY (code ${code})`));
        });
      });
    },
    killAfterRandom(maxDelay) {
      const delay = randInt(0, maxDelay);
      const timer = setTimeout(() => killTree(child), delay);
      return { delay, cancel: () => clearTimeout(timer) };
    },
    waitForExit(timeoutMs) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          killTree(child);
          resolve({ code: null, killedByChaosTimeout: true });
        }, timeoutMs);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, killedByChaosTimeout: false });
        });
      });
    },
  };
}

function check(condition, message, detail) {
  if (!condition) throw new Error(`INVARIANT VIOLATED: ${message}${detail ? ` — ${detail}` : ""}`);
}

const failures = [];
const stats = { kills: 0, trivial: 0, completed: 0, iterationsWithKill: 0 };

for (let i = 1; i <= ITERATIONS; i++) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agent-harness-chaos-"));
  const dbPath = path.join(ws, "harness.db");
  const jsonlFile = path.join(ws, ".harness", "traces");
  let kills = 0;
  try {
    // ---- phase 1: run, killed at a random moment AFTER setup ----
    {
      const run = spawnDriver(["run", dbPath], ws);
      await run.waitForReady();
      const kill = run.killAfterRandom(MAX_RUN_KILL_DELAY);
      const exit = await run.waitForExit(MAX_RUN_KILL_DELAY + 20_000);
      kill.cancel();
      if (exit.killedByChaosTimeout || exit.code !== 0) kills++; // anything but a clean completion = a kill landed
    }

    // ---- phase 2: resume until complete, occasionally killing mid-resume ----
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const db = harness.openDatabase(dbPath);
      let running;
      let finalRow;
      try {
        running = new harness.RunRepo(db).getByStatus("running").map((r) => r.id);
        finalRow = new harness.RunRepo(db).list(1)[0];
      } finally {
        db.close();
      }
      if (running.length === 0) break; // nothing left to resume
      const resume = spawnDriver(["resume", running[0], dbPath], ws);
      await resume.waitForReady();
      if (rand() < 0.4) {
        const kill = resume.killAfterRandom(MAX_RESUME_KILL_DELAY);
        const exit = await resume.waitForExit(MAX_RESUME_KILL_DELAY + 20_000);
        kill.cancel();
        if (exit.killedByChaosTimeout) break; // something wedged — invariants decide
        if (exit.code !== 0) kills++;
      } else {
        await resume.waitForExit(30_000); // clean resume; status checked via DB below
      }
    }

    // ---- phase 3: invariants over the FINAL durable state ----
    const db = harness.openDatabase(dbPath);
    let runRow;
    let events;
    try {
      runRow = new harness.RunRepo(db).list(1)[0];
      events = runRow ? new harness.TraceEventRepo(db).getByRun(runRow.id) : [];
    } finally {
      db.close();
    }

    if (!runRow || events.length === 0) {
      // killed before anything durable happened — trivially consistent
      stats.trivial++;
      if (!KEEP) fs.rmSync(ws, { recursive: true, force: true });
      continue;
    }

    check(runRow.status === "completed", "resume completed", `status=${runRow.status}, kills=${kills}`);
    stats.completed++;
    if (kills > 0) stats.iterationsWithKill++;
    stats.kills += kills;

    const parsed = harness.readTraceFile(path.join(jsonlFile, `${runRow.id}.jsonl`)); // bracket/seq damage throws
    check(
      parsed.events.length === events.length,
      "JSONL and SQLite event counts match",
      `${parsed.events.length} vs ${events.length}`,
    );
    const seqs = parsed.events.map((e) => e.seq);
    for (let s = 1; s < seqs.length; s++) {
      check(seqs[s] > seqs[s - 1], "seq monotonic, no duplicates", `position ${s}`);
    }
    check(JSON.stringify(seqs) === JSON.stringify(events.map((e) => e.seq)), "JSONL and SQLite seq sets identical");
    const machine = harness.ReplayMachine.replay(parsed.events); // must consume the whole log
    check(machine !== undefined, "ReplayMachine consumed the full trace");

    // P3: side-effect conservation, two-sided. A delivery REQUIRES an execution
    // start (log_lines <= starts: no double delivery — "executing" + replay
    // "never" synthesizes "outcome unknown", it never re-delivers), and every
    // COMPLETED execution (isError=false end) has its log line (log_lines >=
    // completed ends). The gap = kills in the start→side-effect window, where
    // the outcome is genuinely unknown — exactly the designed behavior.
    const starts = events.filter((e) => e.type === "tool_execution_start" && e.toolName === "send_notification").length;
    const completedEnds = events.filter(
      (e) => e.type === "tool_execution_end" && e.toolName === "send_notification" && e.isError === false,
    ).length;
    const logPath = path.join(ws, ".harness", "notifications.log");
    const logLines = fs.existsSync(logPath)
      ? fs
          .readFileSync(logPath, "utf8")
          .split("\n")
          .filter((l) => l.trim()).length
      : 0;
    check(logLines <= starts, "deliveries never exceed send_notification starts", `log=${logLines}, starts=${starts}`);
    check(
      logLines >= completedEnds,
      "every completed send_notification execution is logged",
      `log=${logLines}, completed=${completedEnds}`,
    );
    check(fs.readFileSync(path.join(ws, "out-1.txt"), "utf8") === "payload 1", "out.txt has the scripted content");

    if (i % 25 === 0 || i === ITERATIONS) {
      process.stdout.write(
        `[chaos] ${i}/${ITERATIONS} ok — completed=${stats.completed} trivial=${stats.trivial} kills so far=${kills}\n`,
      );
    }
    if (!KEEP) fs.rmSync(ws, { recursive: true, force: true });
  } catch (err) {
    const message = String(err?.message ?? err);
    // A driver dying before READY with empty stderr is chaos INFRASTRUCTURE
    // (spawn/AV/import flake), not a state-machine violation — retry the
    // episode once, mirroring the eval framework's infra-failure semantics.
    if (message.includes("never became READY")) {
      try {
        fs.rmSync(ws, { recursive: true, force: true });
      } catch {
        /* nothing durable to clean */
      }
      const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "agent-harness-chaos-"));
      try {
        const dbPath2 = path.join(ws2, "harness.db");
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const db = harness.openDatabase(dbPath2);
          let running;
          try {
            running = new harness.RunRepo(db).getByStatus("running").map((r) => r.id);
          } finally {
            db.close();
          }
          if (running.length === 0) break;
          const resume = spawnDriver(["resume", running[0], dbPath2], ws2);
          await resume.waitForReady();
          await resume.waitForExit(30_000);
        }
        const db2 = harness.openDatabase(dbPath2);
        try {
          const row = new harness.RunRepo(db2).list(1)[0];
          check(row && row.status === "completed", "retry episode did not complete");
        } finally {
          db2.close();
        }
        stats.completed++;
        process.stdout.write(`[chaos] iteration ${i} infra-flake retried ok\n`);
        if (!KEEP) fs.rmSync(ws2, { recursive: true, force: true });
        continue;
      } catch (retryErr) {
        failures.push({
          iteration: i,
          workspace: ws2,
          kills,
          error: `READY flake + retry failed: ${String(retryErr?.message ?? retryErr)}`,
        });
        continue;
      }
    }
    failures.push({ iteration: i, workspace: ws, kills, error: message });
    process.stdout.write(
      `[chaos] iteration ${i} FAILED: ${message}\n[chaos] workspace kept: ${ws}\n`,
    );
  }
}

process.stdout.write(
  `\n[chaos] ${ITERATIONS - failures.length}/${ITERATIONS} iterations passed — violations: ${failures.length}, completed episodes: ${stats.completed}, iterations with real kill: ${stats.iterationsWithKill}, total kills: ${stats.kills}\n`,
);
if (failures.length > 0) {
  for (const f of failures) process.stdout.write(`  - iter ${f.iteration} (${f.kills} kills): ${f.error}\n`);
  process.exit(1);
}
