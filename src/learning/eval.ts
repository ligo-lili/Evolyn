import fs from "node:fs";
import path from "node:path";
import { resolveModel } from "../providers.js";
import { RunManager, type SkillInjection } from "../runtime/run-manager.js";

/**
 * 阶段 10 scripted A/B eval, dumbest version that answers the question: on the
 * SAME task set, does the run succeed more often with the skill injected than
 * without? Deterministic judging first (run completed + expected artifact
 * checks); the LLM judge and report persistence arrive with the 阶段 11
 * framework. Always compare against the no-skill baseline — never report a
 * skill improvement without it (风险清单 #3).
 */

export interface EvalTask {
  id: string;
  task: string;
  /** Deterministic check: this file (workspace-relative) must exist after the run. */
  expectFile?: string;
  /** Deterministic check: the expectFile content must contain this substring. */
  expectContains?: string;
}

export interface EvalTaskSet {
  name: string;
  tasks: EvalTask[];
}

export function loadTaskSet(file: string): EvalTaskSet {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<EvalTaskSet>;
  if (!parsed.name || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error(`${file}: expected {"name": string, "tasks": [{id, task, expectFile?, expectContains?}]}`);
  }
  return { name: parsed.name, tasks: parsed.tasks };
}

/** What one arm observed for one task, before judging. */
export interface EvalRawRun {
  taskId: string;
  runId?: string;
  status: string;
  error?: string;
  tokens?: number;
  durationMs?: number;
  toolCalls?: number;
}

export interface EvalResult extends EvalRawRun {
  pass: boolean;
  /** Why it failed — empty when pass. */
  reason?: string;
}

export interface EvalArmResult {
  arm: "baseline" | "treatment";
  results: EvalResult[];
  passRate: number;
  totalTokens: number;
  totalDurationMs: number;
}

export type EvalRunner = (task: EvalTask, skills: SkillInjection | false) => Promise<EvalRawRun>;

/**
 * Deterministic judging: run completed, and the expected artifact exists and
 * (when specified) contains the expected substring. No model opinion involved.
 */
export function judgeRun(task: EvalTask, run: EvalRawRun): EvalResult {
  if (run.status !== "completed") {
    return { ...run, pass: false, reason: `run ${run.status}${run.error ? `: ${run.error}` : ""}` };
  }
  if (task.expectFile) {
    let content: string | undefined;
    try {
      content = fs.readFileSync(path.resolve(task.expectFile), "utf8");
    } catch {
      return { ...run, pass: false, reason: `expected file missing: ${task.expectFile}` };
    }
    if (task.expectContains && !content.includes(task.expectContains)) {
      return { ...run, pass: false, reason: `${task.expectFile} does not contain "${task.expectContains}"` };
    }
  }
  return { ...run, pass: true };
}

function summarizeArm(arm: EvalArmResult["arm"], results: EvalResult[]): EvalArmResult {
  return {
    arm,
    results,
    passRate: results.length ? results.filter((r) => r.pass).length / results.length : 0,
    totalTokens: results.reduce((sum, r) => sum + (r.tokens ?? 0), 0),
    totalDurationMs: results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0),
  };
}

/** Run one arm of the task set. */
export async function runEvalArm(taskSet: EvalTaskSet, runner: EvalRunner, skills: SkillInjection | false): Promise<EvalArmResult> {
  const results: EvalResult[] = [];
  for (const task of taskSet.tasks) {
    const raw = await runner(task, skills);
    results.push(judgeRun(task, raw));
  }
  return summarizeArm(skills === false ? "baseline" : "treatment", results);
}

export type EvalVerdict = "candidate-wins" | "baseline-wins" | "tie";

export interface EvalReport {
  taskSet: string;
  /** The injected skill ("none" for a pure baseline run). */
  skill: string;
  baseline: EvalArmResult;
  treatment: EvalArmResult;
  verdict: EvalVerdict;
  decidedAt: string;
}

/** Full A/B: baseline (no skills) vs treatment (the named skill forced in). */
export async function runEvalComparison(
  taskSet: EvalTaskSet,
  options: { runner: EvalRunner; skillName: string },
): Promise<EvalReport> {
  const baseline = await runEvalArm(taskSet, options.runner, false);
  const treatment = await runEvalArm(taskSet, options.runner, { only: [options.skillName] });
  const verdict: EvalVerdict =
    treatment.passRate > baseline.passRate ? "candidate-wins" : treatment.passRate < baseline.passRate ? "baseline-wins" : "tie";
  return { taskSet: taskSet.name, skill: options.skillName, baseline, treatment, verdict, decidedAt: new Date().toISOString() };
}

export function renderEvalReport(report: EvalReport): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const armLine = (arm: EvalArmResult) =>
    `${arm.arm === "baseline" ? "no-skill baseline" : `with skill "${report.skill}"`}: ${arm.results.filter((r) => r.pass).length}/${arm.results.length} pass (${pct(arm.passRate)}), ${arm.totalTokens} tokens, ${(arm.totalDurationMs / 1000).toFixed(1)}s`;
  const lines = [
    `eval "${report.taskSet}" — skill: ${report.skill}`,
    `  ${armLine(report.baseline)}`,
    `  ${armLine(report.treatment)}`,
    ...report.treatment.results.map((r) => `  · ${r.taskId}: ${r.pass ? "PASS" : `FAIL (${r.reason})`}`),
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
      };
    } finally {
      manager.close();
    }
  };
}
