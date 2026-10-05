import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EvalRawRun, EvalResult, EvalTask } from "./eval.js";

/**
 * Deterministic first, LLM judge second (阶段 11) — extracted from eval.ts in
 * the 加固期第三轮 split. `learning/eval.js` re-exports this surface, so it
 * stays the single import point for callers.
 *
 *  - judgeRun: the deterministic gate — run completed + artifact checks + the
 *    optional coding-gate test command. No model opinion involved.
 *  - isInfraFailure: the provider-infrastructure vocabulary; infra failures
 *    invalidate a report instead of counting as task losses.
 *  - defaultJudge: the LLM judge over the pi-ai registry (same cheap model
 *    tier as the distiller) with a bounded extraction budget.
 */

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
      // Bounded extraction budget (加固期修复): an unbounded judge call hangs
      // the whole comparison when a provider stalls.
      signal: AbortSignal.timeout(120_000),
    });
    return value;
  };
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
      // 加固期第三轮: codepoint compare on the lowercased forms — the old
      // locale-collated verdict varied with the grading machine's ICU.
      const sorted = [...lines].sort((a, b) => {
        const x = a.toLowerCase();
        const y = b.toLowerCase();
        const cmp = x < y ? -1 : x > y ? 1 : 0;
        return descending ? -cmp : cmp;
      });
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
  //
  // build-eval 审计防绕过: the fixture's test files live in the agent's
  // workspace, so an edit to test.js / package.json could make `npm test`
  // trivially green without fixing anything — "never test.js" in the task
  // text is a prompt, not a defence. Before the test command runs, restore
  // both from the pristine template; the restore is recorded on the result
  // so reports can surface it. Runs without a template setupRepo are
  // unaffected (nothing to restore from).
  const restored: string[] = [];
  if (task.testCommand) {
    const cwd = task.cwd ? path.resolve(task.cwd) : process.cwd();
    if (task.setupRepo?.template) {
      for (const rel of ["test.js", "package.json"]) {
        let want: Buffer | undefined;
        try {
          want = fs.readFileSync(path.join(path.resolve(task.setupRepo.template), rel));
        } catch {
          continue; // the template does not ship this file — nothing to restore
        }
        const dst = path.join(cwd, rel);
        let have: Buffer | undefined;
        try {
          have = fs.readFileSync(dst);
        } catch {
          have = undefined; // absent (or unreadable) counts as needing the restore
        }
        if (have !== undefined && have.equals(want)) continue;
        fs.writeFileSync(dst, want);
        restored.push(rel);
      }
    }
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
      return {
        ...fail(`test command failed: ${task.testCommand}\n${tail.slice(0, 600)}`),
        ...(restored.length ? { restored } : {}),
      };
    }
  }
  return { ...run, repeat, pass: true, ...(restored.length ? { restored } : {}) };
}
