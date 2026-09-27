import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { resolveModel } from "../providers.js";
import { RunManager, type SkillInjection } from "../runtime/run-manager.js";

/**
 * 阶段 10/11 scripted A/B eval: on the SAME task set, does the run succeed
 * more often with the skill injected than without? Deterministic judging
 * first (run completed + artifact checks); the LLM judge arrives with the
 * 阶段 11 framework. Always compare against the no-skill baseline — never
 * report a skill improvement without it (风险清单 #3).
 *
 * Discrimination lessons from the first real A/B (阶段 10, 2 trivial tasks):
 * a tie at 100% vs 100% means the eval could not see the skill at all. v2
 * therefore adds (a) exact, hard-to-guess checks — line count, exact lines,
 * uniqueness, alphabetical order, per-line regex — where the task text states
 * the requirement but a first-shot model may still miss it; (b) `repeats` so
 * one fluky pass doesn't hide a real gap; (c) `setupFiles` fixtures rewritten
 * before EVERY run so neither arm nor repeat inherits another's workspace.
 */

export interface EvalTask {
  id: string;
  task: string;
  /** Deterministic check: this file (workspace-relative) must exist after the run. */
  expectFile?: string;
  /** Deterministic check: raw file content must contain this substring. */
  expectContains?: string;
  /** Exact number of non-empty lines the expectFile must contain. */
  expectLines?: number;
  /** Exact lines (trimmed), in order — the strongest check. */
  expectLinesExact?: string[];
  /** Non-empty lines must be pairwise distinct. */
  expectUnique?: boolean;
  /** Alphabetical order: true = A→Z, "desc" = Z→A (case-insensitive). */
  expectSorted?: boolean | "desc";
  /** Every non-empty line must match this JS regex. */
  expectLineRegex?: string;
  /**
   * Fixture files rewritten before EVERY run of this task — update-style
   * tasks start from the same state in both arms and every repeat.
   */
  setupFiles?: Record<string, string>;
}

export interface EvalTaskSet {
  name: string;
  tasks: EvalTask[];
}

export function loadTaskSet(file: string): EvalTaskSet {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<EvalTaskSet>;
  if (!parsed.name || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error(`${file}: expected {"name": string, "tasks": [{id, task, expectFile?, ...}]}`);
  }
  return { name: parsed.name, tasks: parsed.tasks };
}

/** Reset the workspace to the task's defined starting state before every run. */
export function prepareTaskWorkspace(task: EvalTask): void {
  if (task.expectFile) fs.rmSync(path.resolve(task.expectFile), { force: true });
  for (const [rel, content] of Object.entries(task.setupFiles ?? {})) {
    const abs = path.resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

/** What one arm observed for one run, before judging. */
export interface EvalRawRun {
  taskId: string;
  runId?: string;
  status: string;
  error?: string;
  tokens?: number;
  durationMs?: number;
  toolCalls?: number;
  /** True when the run read back a file it had written (verification behavior). */
  verified?: boolean;
}

/**
 * Deterministic process metric (阶段 10/11): did the model read back a file it
 * had written? Walks the transcript — a read_file of a path that an earlier
 * write_file created/updated counts as verification. This is the dimension
 * where a write→verify skill is measurable even when the baseline sits at the
 * pass-rate ceiling.
 */
export function readBackVerified(messages: readonly AgentMessage[]): boolean {
  const written = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const block of m.content) {
      if (block.type !== "toolCall") continue;
      const p = (block.arguments as { path?: unknown } | undefined)?.path;
      if (typeof p !== "string") continue;
      if (block.name === "write_file") written.add(p);
      else if (block.name === "read_file" && written.has(p)) return true;
    }
  }
  return false;
}

export interface EvalResult extends EvalRawRun {
  repeat: number;
  pass: boolean;
  /** Why it failed — undefined when pass. */
  reason?: string;
}

export type EvalRunner = (task: EvalTask, skills: SkillInjection | false) => Promise<EvalRawRun>;

/**
 * Deterministic judging: run completed, and the expected artifact exists and
 * satisfies every stated check. No model opinion involved.
 */
export function judgeRun(task: EvalTask, run: EvalRawRun, repeat = 1): EvalResult {
  const fail = (reason: string): EvalResult => ({ ...run, repeat, pass: false, reason });
  if (run.status !== "completed") {
    return fail(`run ${run.status}${run.error ? `: ${run.error}` : ""}`);
  }
  if (task.expectFile) {
    let content: string;
    try {
      content = fs.readFileSync(path.resolve(task.expectFile), "utf8");
    } catch {
      return fail(`expected file missing: ${task.expectFile}`);
    }
    if (task.expectContains && !content.includes(task.expectContains)) {
      return fail(`${task.expectFile} does not contain "${task.expectContains}"`);
    }
    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (task.expectLinesExact) {
      const expected = task.expectLinesExact;
      if (lines.length !== expected.length) {
        return fail(`expected ${expected.length} non-empty lines, got ${lines.length}`);
      }
      const bad = lines.findIndex((l, i) => l !== expected[i]);
      if (bad !== -1) {
        return fail(`line ${bad + 1} is "${lines[bad]}" but expected "${expected[bad]}"`);
      }
    } else if (task.expectLines !== undefined && lines.length !== task.expectLines) {
      return fail(`expected ${task.expectLines} non-empty lines, got ${lines.length}`);
    }
    if (task.expectUnique && new Set(lines).size !== lines.length) {
      return fail(`${task.expectFile} contains duplicate lines`);
    }
    if (task.expectSorted) {
      const descending = task.expectSorted === "desc";
      const sorted = [...lines].sort((a, b) =>
        descending ? b.toLowerCase().localeCompare(a.toLowerCase()) : a.toLowerCase().localeCompare(b.toLowerCase()),
      );
      const unsorted = lines.findIndex((l, i) => l.toLowerCase() !== sorted[i]?.toLowerCase());
      if (unsorted !== -1) {
        return fail(`line ${unsorted + 1} ("${lines[unsorted]}") breaks ${descending ? "reverse" : "alphabetical"} order`);
      }
    }
    if (task.expectLineRegex) {
      const re = new RegExp(task.expectLineRegex);
      const bad = lines.find((l) => !re.test(l));
      if (bad !== undefined) {
        return fail(`line "${bad}" does not match /${task.expectLineRegex}/`);
      }
    }
  }
  return { ...run, repeat, pass: true };
}

export interface EvalTaskSummary {
  taskId: string;
  passes: number;
  repeats: number;
  /** Failure reasons across repeats, for the report. */
  failures: string[];
}

export interface EvalArmResult {
  arm: "baseline" | "treatment";
  results: EvalResult[];
  taskSummaries: EvalTaskSummary[];
  passRate: number;
  /** Runs that read back a written file — the skill-adoption process metric. */
  verifiedRuns: number;
  totalTokens: number;
  totalDurationMs: number;
}

function summarizeArm(arm: EvalArmResult["arm"], results: EvalResult[]): EvalArmResult {
  const byTask = new Map<string, EvalTaskSummary>();
  for (const r of results) {
    const s = byTask.get(r.taskId) ?? { taskId: r.taskId, passes: 0, repeats: 0, failures: [] };
    s.repeats++;
    if (r.pass) s.passes++;
    else s.failures.push(`#${r.repeat}: ${r.reason}`);
    byTask.set(r.taskId, s);
  }
  return {
    arm,
    results,
    taskSummaries: [...byTask.values()],
    passRate: results.length ? results.filter((r) => r.pass).length / results.length : 0,
    verifiedRuns: results.filter((r) => r.verified === true).length,
    totalTokens: results.reduce((sum, r) => sum + (r.tokens ?? 0), 0),
    totalDurationMs: results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0),
  };
}

/** Run one arm of the task set, `repeats` times over, resetting fixtures per run. */
export async function runEvalArm(
  taskSet: EvalTaskSet,
  runner: EvalRunner,
  skills: SkillInjection | false,
  repeats = 1,
): Promise<EvalArmResult> {
  const results: EvalResult[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const task of taskSet.tasks) {
      prepareTaskWorkspace(task);
      const raw = await runner(task, skills);
      results.push(judgeRun(task, raw, repeat));
    }
  }
  return summarizeArm(skills === false ? "baseline" : "treatment", results);
}

export type EvalVerdict = "candidate-wins" | "baseline-wins" | "tie";

export interface EvalReport {
  taskSet: string;
  /** The injected skill ("none" for a pure baseline run). */
  skill: string;
  repeats: number;
  baseline: EvalArmResult;
  treatment: EvalArmResult;
  verdict: EvalVerdict;
  decidedAt: string;
}

/** Full A/B: baseline (no skills) vs treatment (the named skill forced in). */
export async function runEvalComparison(
  taskSet: EvalTaskSet,
  options: { runner: EvalRunner; skillName: string; repeats?: number },
): Promise<EvalReport> {
  const repeats = Math.max(1, options.repeats ?? 1);
  const baseline = await runEvalArm(taskSet, options.runner, false, repeats);
  const treatment = await runEvalArm(taskSet, options.runner, { only: [options.skillName] }, repeats);
  const verdict: EvalVerdict =
    treatment.passRate > baseline.passRate ? "candidate-wins" : treatment.passRate < baseline.passRate ? "baseline-wins" : "tie";
  return { taskSet: taskSet.name, skill: options.skillName, repeats, baseline, treatment, verdict, decidedAt: new Date().toISOString() };
}

export function renderEvalReport(report: EvalReport): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const runs = report.baseline.results.length;
  const armLine = (arm: EvalArmResult, label: string) => {
    const avgTokens = runs ? Math.round(arm.totalTokens / runs) : 0;
    const avgSec = runs ? arm.totalDurationMs / runs / 1000 : 0;
    return (
      `${label}: ${arm.results.filter((r) => r.pass).length}/${runs} pass (${pct(arm.passRate)}), ` +
      `verify-read-back ${arm.verifiedRuns}/${runs}, ~${avgTokens} tok/run, ~${avgSec.toFixed(1)}s/run`
    );
  };
  const lines = [
    `eval "${report.taskSet}" — skill: ${report.skill} — ${report.baseline.results.length / Math.max(1, report.repeats)} task(s) × ${report.repeats} repeat(s) × 2 arms`,
    `  ${armLine(report.baseline, "no-skill baseline")}`,
    `  ${armLine(report.treatment, `with skill "${report.skill}"`)}`,
    "  per task (baseline vs skill):",
    ...report.baseline.taskSummaries.map((b) => {
      const t = report.treatment.taskSummaries.find((s) => s.taskId === b.taskId);
      const failures = [...b.failures, ...(t?.failures ?? [])].slice(0, 4);
      return `    ${b.taskId}: ${b.passes}/${b.repeats} vs ${t?.passes ?? 0}/${t?.repeats ?? 0}${failures.length ? `\n      failures: ${failures.join(" | ")}` : ""}`;
    }),
    `verdict: ${report.verdict}`,
  ];
  return lines.join("\n");
}

export interface DefaultRunnerOptions {
  database?: string;
}

/**
 * Real-model runner: one RunManager run per task, no distillation side
 * effects. Memory retrieval stays at its default — it is identical across
 * both arms (same task set, static memory store), so the skill remains the
 * only variable under test.
 */
export function defaultEvalRunner(modelSpec: string, options: DefaultRunnerOptions = {}): EvalRunner {
  const model = resolveModel(modelSpec);
  return async (task, skills) => {
    const manager = new RunManager();
    const started = Date.now();
    try {
      const result = await manager.run({
        task: task.task,
        model,
        database: options.database,
        reporter: { onEvent: () => {} },
        skills,
      });
      const toolCalls = result.messages.filter((m) => m.role === "toolResult").length;
      return {
        taskId: task.id,
        runId: result.record.id,
        status: result.record.status,
        error: result.record.error,
        tokens: result.usage?.totalTokens,
        durationMs: Date.now() - started,
        toolCalls,
        verified: readBackVerified(result.messages),
      };
    } finally {
      manager.close();
    }
  };
}
