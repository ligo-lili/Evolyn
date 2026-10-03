#!/usr/bin/env node
// 混沌模糊测试 (hardening round 3): kill agent-harness processes at RANDOM
// moments, hundreds of times, and assert the recovery state machine's
// PROPERTIES — not individual behaviors:
//
//   P1. any kill, at any moment: resume eventually COMPLETES (bounded rounds).
//       An iteration killed before anything durable happened is trivially ok.
//   P2. the trace is always offline-replayable: every line parses, seq is
//       monotonic without duplicates, run_start…run_end bracket intact after
//       the final resume, and the replay state machine ends with NO pending
//       tool calls (a completed run with a pending call would be the
//       false-completion bug).
//   P3. side effects are conserved, two-sided. A delivery REQUIRES an
//       execution start (log_lines <= starts: no double delivery — "executing"
//       + replay "never" synthesizes "outcome unknown", it never re-delivers),
//       and every COMPLETED execution (isError=false end) has its log line
//       (log_lines >= completed ends). The gap = kills in the
//       start→side-effect window, where the outcome is genuinely unknown.
//   P4. JSONL and SQLite agree on the seq set after the final resume.
//
// Requires a prior `npm run build` (imports dist/). Deterministic with --seed.
// A driver dying before READY is chaos INFRASTRUCTURE (spawn/import flake) —
// the episode is retried once on a fresh workspace, mirroring the eval
// framework's infra-failure semantics; a second flake is a real failure.
//
// Usage: node scripts/chaos.mjs [--iterations 200] [--keep] [--seed 42]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = pathToFileURL(path.join(here, "..", "dist", "index.js")).href;
const harness = await import(dist);
const driverPath = path.join(here, "chaos-driver.mjs");

function rawArg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] !== undefined ? String(process.argv[i + 1]) : undefined;
}
const has = (flag) => process.argv.includes(flag);

function positiveIntArg(flag, fallback) {
  const raw = rawArg(flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`invalid ${flag}: ${raw} (expected a positive integer)`);
    process.exit(2);
  }
  return value;
}
function intArg(flag, fallback) {
  const raw = rawArg(flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`invalid ${flag}: ${raw} (expected a number)`);
    process.exit(2);
  }
  return value;
}

const ITERATIONS = positiveIntArg("--iterations", 200);
const MAX_RUN_KILL_DELAY = positiveIntArg("--max-run-kill-delay", 1500);
const MAX_RESUME_KILL_DELAY = positiveIntArg("--max-resume-kill-delay", 600);
const MAX_ROUNDS = positiveIntArg("--max-rounds", 8);
const KEEP = has("--keep");
const SEED = intArg("--seed", 1337);

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
      // finished before the kill landed. A spawn failure must NOT crash the
      // fuzzer — fall back to a direct kill.
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      });
    } else {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
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
          // An exit before READY is an infra flake too (import crash) — same
          // signature, same retry semantics.
          reject(new Error(`driver never became READY (exited with code ${code}; stderr: ${state.stderr.slice(0, 200)})`));
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

/**
 * One full episode on a fresh workspace: a run killed at a random moment,
 * then resume rounds (each randomly killed with p=0.4) until nothing is left
 * running. Returns the number of kills that landed. Throws "never became
 * READY" on infra flakes — the caller retries on a fresh workspace.
 */
async function runEpisode(ws) {
  const dbPath = path.join(ws, "harness.db");
  let kills = 0;

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
    try {
      running = new harness.RunRepo(db).getByStatus("running").map((r) => r.id);
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
  return kills;
}

/**
 * Invariants over the FINAL durable state of an episode. Returns "trivial"
 * when the kill landed before anything durable happened. Throws with a
 * detailed message on any violation.
 */
function checkInvariants(ws) {
  const dbPath = path.join(ws, "harness.db");
  const db = harness.openDatabase(dbPath);
  let runRow;
  let events;
  try {
    runRow = new harness.RunRepo(db).list(1)[0];
    events = runRow ? new harness.TraceEventRepo(db).getByRun(runRow.id) : [];
  } finally {
    db.close();
  }

  if (!runRow || events.length === 0) return "trivial";

  check(runRow.status === "completed", "resume completed", `status=${runRow.status}`);

  const jsonlFile = path.join(ws, ".harness", "traces", `${runRow.id}.jsonl`);
  const parsed = harness.readTraceFile(jsonlFile); // bracket/seq damage throws
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
  // A COMPLETED run must replay with every tool call resolved — a pending call
  // after completion would be exactly the false-completion bug.
  const machine = harness.ReplayMachine.replay(parsed.events);
  check(
    machine.pendingCalls().length === 0,
    "completed run replays with no pending tool calls",
    JSON.stringify(machine.pendingCalls()),
  );

  // P3: side-effect conservation, two-sided (see the header comment).
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
  check(fs.readFileSync(path.join(ws, "out-1.txt"), "utf8") === "payload 1", "out-1.txt has the scripted content");
  return "ok";
}

const stats = { kills: 0, trivial: 0, completed: 0, iterationsWithKill: 0, infraFlakes: 0 };
const failures = [];

for (let i = 1; i <= ITERATIONS; i++) {
  let ws = fs.mkdtempSync(path.join(os.tmpdir(), "agent-harness-chaos-"));
  let kills = 0;
  try {
    try {
      kills = await runEpisode(ws);
    } catch (err) {
      if (!String(err?.message ?? err).includes("never became READY")) throw err;
      // Infra flake (spawn/import) — one retry on a fresh workspace; a second
      // flake propagates as a real failure.
      stats.infraFlakes++;
      fs.rmSync(ws, { recursive: true, force: true });
      ws = fs.mkdtempSync(path.join(os.tmpdir(), "agent-harness-chaos-"));
      kills = await runEpisode(ws);
    }

    const verdict = checkInvariants(ws);
    if (verdict === "trivial") {
      stats.trivial++;
    } else {
      stats.completed++;
      if (kills > 0) stats.iterationsWithKill++;
      stats.kills += kills;
    }
    if (i % 25 === 0 || i === ITERATIONS) {
      process.stdout.write(
        `[chaos] ${i}/${ITERATIONS} ok — completed=${stats.completed} trivial=${stats.trivial} total kills=${stats.kills}\n`,
      );
    }
    if (!KEEP) fs.rmSync(ws, { recursive: true, force: true });
  } catch (err) {
    const message = String(err?.message ?? err);
    failures.push({ iteration: i, workspace: ws, kills, error: message });
    process.stdout.write(`[chaos] iteration ${i} FAILED: ${message}\n[chaos] workspace kept: ${ws}\n`);
  }
}

process.stdout.write(
  `\n[chaos] ${ITERATIONS - failures.length}/${ITERATIONS} iterations passed — violations: ${failures.length}, completed episodes: ${stats.completed}, iterations with real kill: ${stats.iterationsWithKill}, total kills: ${stats.kills}, infra flakes retried: ${stats.infraFlakes}\n`,
);
if (failures.length > 0) {
  for (const f of failures) process.stdout.write(`  - iter ${f.iteration} (${f.kills} kills): ${f.error}\n`);
  process.exit(1);
}
