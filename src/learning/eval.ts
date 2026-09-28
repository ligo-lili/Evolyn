import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
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
   * LLM-judge instructions for tasks whose quality has no deterministic
   * check (阶段 11: deterministic judging first, judge second). When set, the
   * judge decides pass/fail AFTER deterministic checks pass; a deterministic
   * failure short-circuits without calling the judge.
   */
  judgeInstructions?: string;
  /**
   * Fixture files rewritten before EVERY run of this task — update-style
   * tasks start from the same state in both arms and every repeat.
   */
  setupFiles?: Record<string, string>;
  /**
   * 阶段 14 coding fixture: a repo directory reset to a known state before
   * every run. `template` copies a committed fixture directory (offline,
   * deterministic); `url`+`ref` clone/reset a git repo instead (OSS mode —
   * ref = the bug-introducing parent commit; the fix commit's tests are
   * already in the tree and fail). The dir is workspace-relative; the agent
   * edits it with normal relative paths.
   */
  setupRepo?: { dir: string; template?: string; url?: string; ref?: string };
  /**
   * 阶段 14 deterministic test check: run this command (in `cwd`, default
   * workspace root) after the run — exit 0 passes, anything else fails with
   * the output tail. No LLM involved.
   */
  testCommand?: string;
  /** Directory the testCommand runs in, workspace-relative (default: root). */
  cwd?: string;
  /** Wall-clock budget for the test command (ms, default 120_000). */
  testTimeoutMs?: number;
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
  if (task.setupRepo) prepareRepoFixture(task.setupRepo);
}

/**
 * 阶段 14: reset a repo fixture to its defined buggy state. Templates copy a
 * committed fixture directory (rm + copy — deterministic, offline); git repos
 * clone once (kept under the dir) and reset per run via checkout --force +
 * clean -fd (ignored files like node_modules survive, the agent's tracked and
 * untracked edits do not).
 */
export function prepareRepoFixture(spec: NonNullable<EvalTask["setupRepo"]>): void {
  const dir = path.resolve(spec.dir);
  if (spec.template) {
    const template = path.resolve(spec.template);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(template, dir, { recursive: true });
    return;
  }
  if (spec.url) {
    const ref = spec.ref ?? "HEAD";
    const git = (args: string): string =>
      execSync(`git ${args}`, {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        windowsHide: true,
      }).toString();
    if (!fs.existsSync(path.join(dir, ".git"))) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
      execSync(`git clone ${spec.url} ${JSON.stringify(dir)}`, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
        windowsHide: true,
      });
    }
    git(`fetch origin ${ref} --force`);
    git(`checkout --force ${JSON.stringify(ref)}`);
    git(`clean -fd`);
    return;
  }
  throw new Error(`setupRepo.dir "${spec.dir}" needs a template or url`);
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
  /** Last non-empty assistant text — the LLM judge sees this. */
  finalText?: string;
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
      if (block.name === "write_file" || block.name === "write" || block.name === "edit") written.add(p);
      else if ((block.name === "read_file" || block.name === "read") && written.has(p)) return true;
    }
  }
  return false;
}

// ---------- LLM judge (阶段 11: deterministic first, judge second) ----------

export interface JudgeInput {
  task: string;
  judgeInstructions: string;
  finalText?: string;
  status: string;
}

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
}

export type JudgeFn = (input: JudgeInput) => Promise<JudgeVerdict>;

const JUDGE_SYSTEM_PROMPT =
  "You are a strict eval judge for a coding agent. " +
  "You see a task, extra judging instructions, and the agent's final response. " +
  "Decide ONLY whether the response satisfies the task's stated requirements per the judging instructions — " +
  "never reward unstated extra quality. Output ONLY strict JSON with keys pass (boolean) and reason (one sentence).";

export function parseJudgeVerdictStrict(raw: string): JudgeVerdict {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in judge response");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  if (typeof parsed.pass !== "boolean") throw new Error('judge verdict missing boolean "pass"');
  return { pass: parsed.pass, reason: String(parsed.reason ?? "").trim() || (parsed.pass ? "passed" : "failed") };
}

export function buildJudgePrompt(input: JudgeInput): string {
  return [
    "Judge this coding-agent run:",
    `task: ${input.task}`,
    `judging instructions: ${input.judgeInstructions}`,
    `run status: ${input.status}`,
    `agent final response:\n${(input.finalText ?? "(no text response)").slice(0, 2_000)}`,
  ].join("\n");
}

/** Real judge via the pi-ai registry (same cheap model tier as the distiller). */
export function defaultJudge(modelSpec?: string): JudgeFn {
  const spec = modelSpec ?? process.env.HARNESS_DISTILL_MODEL ?? "deepseek/deepseek-flash";
  return async (input) => {
    const { completeStructured, defaultChat } = await import("../llm/structured.js");
    const { resolveModel } = await import("../providers.js");
    const complete = defaultChat(resolveModel(spec), { systemPrompt: JUDGE_SYSTEM_PROMPT });
    const { value } = await completeStructured({
      prompt: buildJudgePrompt(input),
      parse: parseJudgeVerdictStrict,
      complete,
      maxReprompts: 1,
    });
    return value;
  };
}

export interface EvalResult extends EvalRawRun {
  repeat: number;
  pass: boolean;
  /** Why it failed — undefined when pass. */
  reason?: string;
  /** True when the run died to provider infrastructure (rate limit/quota/auth), not the task. */
  infra?: boolean;
}

/**
 * Provider-infrastructure failures are NOT task failures: a 429 or an auth
 * error says nothing about the model's ability, and counting them as task
 * failures corrupts the comparison (阶段 12 lesson — the first weak-model
 * treatment arm was wiped out by OpenRouter's free-tier daily quota).
 * Vocabulary matches the retry.ts transient-error style. 阶段 14 addition:
 * Aliyun wraps out-of-credit as HTTP 400 + "Arrearage"/"overdue-payment"
 * ("Access denied") — a bare 400 is a normal bad request, so the business
 * words carry that match.
 */
const INFRA_ERROR_PATTERN =
  /\b429\b|\b401\b|\b403\b|\b400\b[\s\S]{0,200}(arrearage|overdue|insufficient)|arrearage|overdue[- ]?payment|access denied|rate.?limit|quota|insufficient credits|unauthorized|invalid api key|provider is not configured|not configured/i;

export function isInfraFailure(run: EvalRawRun): boolean {
  return run.status !== "completed" && run.error !== undefined && INFRA_ERROR_PATTERN.test(run.error);
}

export type EvalRunner = (task: EvalTask, skills: SkillInjection | false) => Promise<EvalRawRun>;

/**
 * Deterministic judging: run completed, and the expected artifact exists and
 * satisfies every stated check. No model opinion involved.
 */
export function judgeRun(task: EvalTask, run: EvalRawRun, repeat = 1): EvalResult {
  const infra = isInfraFailure(run);
  const fail = (reason: string): EvalResult => ({
    ...run,
    repeat,
    pass: false,
    reason,
    ...(infra ? { infra: true } : {}),
  });
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
        return fail(
          `line ${unsorted + 1} ("${lines[unsorted]}") breaks ${descending ? "reverse" : "alphabetical"} order`,
        );
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
  // 阶段 14: the coding gate — the repo's own tests decide. Exit 0 passes;
  // anything else fails with the output tail. Fully deterministic.
  if (task.testCommand) {
    const cwd = task.cwd ? path.resolve(task.cwd) : process.cwd();
    try {
      execSync(task.testCommand, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: task.testTimeoutMs ?? 120_000,
        windowsHide: true,
        encoding: "utf8",
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const tail = `${e.stderr ?? ""}\n${e.stdout ?? ""}\n${e.message ?? ""}`.trim().split("\n").slice(-8).join("\n");
      return fail(`test command failed: ${task.testCommand}\n${tail.slice(0, 600)}`);
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
  /** Runs that died to provider infrastructure (rate limit/quota/auth). */
  infraFailures: number;
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
    infraFailures: results.filter((r) => r.infra === true).length,
    totalTokens: results.reduce((sum, r) => sum + (r.tokens ?? 0), 0),
    totalDurationMs: results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0),
  };
}

export interface EvalArmOptions {
  repeats?: number;
  /** LLM judge — consulted only when deterministic checks passed and the task sets judgeInstructions. */
  judge?: JudgeFn;
}

/** Run one arm of the task set, `repeats` times over, resetting fixtures per run. */
export async function runEvalArm(
  taskSet: EvalTaskSet,
  runner: EvalRunner,
  skills: SkillInjection | false,
  opts: EvalArmOptions = {},
): Promise<EvalArmResult> {
  const repeats = Math.max(1, opts.repeats ?? 1);
  const results: EvalResult[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const task of taskSet.tasks) {
      prepareTaskWorkspace(task);
      const raw = await runner(task, skills);
      const judged = judgeRun(task, raw, repeat);
      if (judged.pass && task.judgeInstructions && opts.judge) {
        // 阶段 11 ordering: deterministic checks already passed; the judge now
        // decides. A deterministic failure never reaches the judge.
        const verdict = await opts.judge({
          task: task.task,
          judgeInstructions: task.judgeInstructions,
          finalText: raw.finalText,
          status: raw.status,
        });
        results.push({ ...judged, pass: verdict.pass, reason: verdict.pass ? undefined : verdict.reason });
      } else {
        results.push(judged);
      }
    }
  }
  return summarizeArm(skills === false ? "baseline" : "treatment", results);
}

export type EvalVerdict = "candidate-wins" | "baseline-wins" | "tie";

export interface EvalReport {
  taskSet: string;
  /** The injected skill ("none" for a pure baseline run). */
  skill: string;
  /** Promoted-skill version at eval time (阶段 12) — makes v1/v2 ledger rows comparable. */
  skillVersion?: number;
  /** 阶段 14: toolset under test — part of the protocol identity. */
  toolset?: string;
  repeats: number;
  /** "fresh" = baseline arm re-run now; "stored" = recorded regression baseline. */
  baselineSource: "fresh" | "stored";
  baseline: EvalArmResult;
  treatment: EvalArmResult;
  verdict: EvalVerdict;
  /** False when infrastructure failures (rate limit/quota/auth) contaminated an arm — the verdict must not gate anything. */
  valid: boolean;
  invalidReason?: string;
  decidedAt: string;
}

export interface EvalRunOptions {
  runner: EvalRunner;
  skillName: string;
  /** Promoted-skill version, captured for ledger comparability (阶段 12). */
  skillVersion?: number;
  /** 阶段 14: toolset under test, recorded on the report for protocol identity. */
  toolset?: string;
  repeats?: number;
  judge?: JudgeFn;
}

function verdictOf(baseline: EvalArmResult, treatment: EvalArmResult): EvalVerdict {
  return treatment.passRate > baseline.passRate
    ? "candidate-wins"
    : treatment.passRate < baseline.passRate
      ? "baseline-wins"
      : "tie";
}

function validityOf(baseline: EvalArmResult, treatment: EvalArmResult): { valid: boolean; invalidReason?: string } {
  const infra = baseline.infraFailures + treatment.infraFailures;
  if (infra === 0) return { valid: true };
  return {
    valid: false,
    invalidReason: `${infra} run(s) died to provider infrastructure (rate limit/quota/auth) — the comparison is not attributable to the task; re-run after the limit resets or on a paid tier`,
  };
}

/** Full A/B: baseline (no skills) vs treatment (the named skill forced in), both fresh. */
export async function runEvalComparison(taskSet: EvalTaskSet, options: EvalRunOptions): Promise<EvalReport> {
  const repeats = Math.max(1, options.repeats ?? 1);
  const baseline = await runEvalArm(taskSet, options.runner, false, { repeats, judge: options.judge });
  const treatment = await runEvalArm(
    taskSet,
    options.runner,
    { only: [options.skillName] },
    { repeats, judge: options.judge },
  );
  return {
    taskSet: taskSet.name,
    skill: options.skillName,
    skillVersion: options.skillVersion,
    toolset: options.toolset,
    repeats,
    baselineSource: "fresh",
    baseline,
    treatment,
    verdict: verdictOf(baseline, treatment),
    ...validityOf(baseline, treatment),
    decidedAt: new Date().toISOString(),
  };
}

/** 阶段 11 regression mode: treatment arm only, compared against a recorded baseline. */
export async function runEvalAgainstBaseline(
  taskSet: EvalTaskSet,
  options: EvalRunOptions & { stored: { arm: EvalArmResult; repeats: number } },
): Promise<EvalReport> {
  const repeats = Math.max(1, options.repeats ?? 1);
  const treatment = await runEvalArm(
    taskSet,
    options.runner,
    { only: [options.skillName] },
    { repeats, judge: options.judge },
  );
  return {
    taskSet: taskSet.name,
    skill: options.skillName,
    skillVersion: options.skillVersion,
    toolset: options.toolset,
    repeats,
    baselineSource: "stored",
    baseline: options.stored.arm,
    treatment,
    verdict: verdictOf(options.stored.arm, treatment),
    ...validityOf(options.stored.arm, treatment),
    decidedAt: new Date().toISOString(),
  };
}

export function renderEvalReport(report: EvalReport): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const runs = report.baseline.results.length;
  const armLine = (arm: EvalArmResult, label: string) => {
    const avgTokens = runs ? Math.round(arm.totalTokens / runs) : 0;
    const avgSec = runs ? arm.totalDurationMs / runs / 1000 : 0;
    const infra = arm.infraFailures > 0 ? `, ${arm.infraFailures} INFRA-FAILED` : "";
    return (
      `${label}: ${arm.results.filter((r) => r.pass).length}/${runs} pass (${pct(arm.passRate)}), ` +
      `verify-read-back ${arm.verifiedRuns}/${runs}, ~${avgTokens} tok/run, ~${avgSec.toFixed(1)}s/run${infra}`
    );
  };
  const invalidPrefix = report.valid ? [] : [`  ⚠ INVALID REPORT: ${report.invalidReason}`];
  const lines = [
    ...invalidPrefix,
    `eval "${report.taskSet}" — skill: ${report.skill} — ${report.baseline.results.length / Math.max(1, report.repeats)} task(s) × ${report.repeats} repeat(s) × 2 arms`,
    `  ${armLine(report.baseline, report.baselineSource === "stored" ? "no-skill baseline (stored)" : "no-skill baseline")}`,
    `  ${armLine(report.treatment, `with skill "${report.skill}"`)}`,
    "  per task (baseline vs skill):",
    ...report.baseline.taskSummaries.map((b) => {
      const t = report.treatment.taskSummaries.find((s) => s.taskId === b.taskId);
      const failures = [...b.failures, ...(t?.failures ?? [])].slice(0, 4);
      return `    ${b.taskId}: ${b.passes}/${b.repeats} vs ${t?.passes ?? 0}/${t?.repeats ?? 0}${failures.length ? `\n      failures: ${failures.join(" | ")}` : ""}`;
    }),
    `verdict: ${report.verdict}${report.valid ? "" : " (INVALID — do not use for gating)"}`,
  ];
  return lines.join("\n");
}

export interface DefaultRunnerOptions {
  database?: string;
  /** 阶段 14: toolset for the runs — "coding" exercises the pi coding tools. */
  toolset?: "demo" | "coding";
}

function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const text = m.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text.trim()) return text;
  }
  return undefined;
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
        tools: options.toolset,
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
        finalText: lastAssistantText(result.messages),
      };
    } finally {
      manager.close();
    }
  };
}
