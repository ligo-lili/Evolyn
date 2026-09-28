import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EvalArmResult, EvalReport, EvalVerdict } from "../../learning/eval.js";

type Row = Record<string, unknown>;

export interface EvalArmCost {
  totalTokens: number;
  totalDurationMs: number;
  avgTokens: number;
  avgDurationMs: number;
}

export interface SkillEvalRow {
  id: string;
  skillName: string;
  skillVersion?: number;
  sourceCandidateId?: string;
  evalSet: string;
  repeats: number;
  baselinePass: number;
  candidatePass: number;
  verdict: EvalVerdict;
  cost: { baseline: EvalArmCost; treatment: EvalArmCost };
  /** Full report JSON — the durable, self-contained record. */
  report: EvalReport;
  decidedAt: string;
}

function armCost(arm: EvalArmResult): EvalArmCost {
  const runs = arm.results.length;
  return {
    totalTokens: arm.totalTokens,
    totalDurationMs: arm.totalDurationMs,
    avgTokens: runs ? Math.round(arm.totalTokens / runs) : 0,
    avgDurationMs: runs ? Math.round(arm.totalDurationMs / runs) : 0,
  };
}

function rowToSkillEval(r: Row): SkillEvalRow {
  const report = JSON.parse(String(r.report_json)) as EvalReport;
  return {
    id: String(r.id),
    skillName: String(r.skill_name),
    skillVersion: report.skillVersion,
    sourceCandidateId: r.source_candidate_id == null ? undefined : String(r.source_candidate_id),
    evalSet: String(r.eval_set),
    repeats: Number(r.repeats),
    baselinePass: Number(r.baseline_pass),
    candidatePass: Number(r.candidate_pass),
    verdict: String(r.verdict) as SkillEvalRow["verdict"],
    cost: JSON.parse(String(r.cost_json)),
    report,
    decidedAt: String(r.decided_at),
  };
}

/** Persisted A/B eval reports (阶段 11) — the comparison ledger for skill iterations. */
export class SkillEvalRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: SkillEvalRow): void {
    this.db
      .prepare(
        `INSERT INTO skill_evals
         (id, skill_name, source_candidate_id, eval_set, repeats, baseline_pass, candidate_pass, cost_json, report_json, verdict, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.skillName,
        row.sourceCandidateId ?? null,
        row.evalSet,
        row.repeats,
        row.baselinePass,
        row.candidatePass,
        JSON.stringify(row.cost),
        JSON.stringify(row.report),
        row.verdict,
        row.decidedAt,
      );
  }

  list(limit = 20): SkillEvalRow[] {
    const rows = this.db.prepare("SELECT * FROM skill_evals ORDER BY decided_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(rowToSkillEval);
  }
}

export interface EvalBaselineRow {
  id: string;
  evalSet: string;
  modelSpec: string;
  /** 阶段 14: the toolset is part of the eval protocol (demo/coding). */
  toolset?: string;
  repeats: number;
  arm: EvalArmResult;
  recordedAt: string;
}

function rowToBaseline(r: Row): EvalBaselineRow {
  return {
    id: String(r.id),
    evalSet: String(r.eval_set),
    modelSpec: String(r.model_spec),
    toolset: r.toolset == null ? undefined : String(r.toolset),
    repeats: Number(r.repeats),
    arm: JSON.parse(String(r.arm_json)) as EvalArmResult,
    recordedAt: String(r.recorded_at),
  };
}

/**
 * No-skill regression baselines (阶段 11): one command records the reference
 * arm for a (task set, model) pair; later evals can compare against it
 * (`--against-baseline`) instead of re-running the baseline every time. The
 * latest record per pair is the live reference; history is kept.
 */
export class EvalBaselineRepo {
  constructor(private readonly db: DatabaseSync) {}

  record(input: {
    evalSet: string;
    modelSpec: string;
    toolset?: string;
    repeats: number;
    arm: EvalArmResult;
  }): EvalBaselineRow {
    const row: EvalBaselineRow = {
      id: randomUUID(),
      evalSet: input.evalSet,
      modelSpec: input.modelSpec,
      toolset: input.toolset,
      repeats: input.repeats,
      arm: input.arm,
      recordedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO eval_baselines (id, eval_set, model_spec, toolset, repeats, arm_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        row.evalSet,
        row.modelSpec,
        row.toolset ?? null,
        row.repeats,
        JSON.stringify(row.arm),
        row.recordedAt,
      );
    return row;
  }

  latest(evalSet: string, modelSpec: string, toolset?: string): EvalBaselineRow | undefined {
    const row = this.db
      .prepare(
        toolset === undefined
          ? "SELECT * FROM eval_baselines WHERE eval_set = ? AND model_spec = ? ORDER BY recorded_at DESC LIMIT 1"
          : "SELECT * FROM eval_baselines WHERE eval_set = ? AND model_spec = ? AND toolset = ? ORDER BY recorded_at DESC LIMIT 1",
      )
      .get(...(toolset === undefined ? [evalSet, modelSpec] : [evalSet, modelSpec, toolset])) as Row | undefined;
    return row ? rowToBaseline(row) : undefined;
  }

  list(limit = 20): EvalBaselineRow[] {
    const rows = this.db.prepare("SELECT * FROM eval_baselines ORDER BY recorded_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(rowToBaseline);
  }
}

/** Build the persistence-ready row from a fresh report. */
export function skillEvalRowFromReport(report: EvalReport, sourceCandidateId?: string): SkillEvalRow {
  return {
    id: randomUUID(),
    skillName: report.skill,
    skillVersion: report.skillVersion,
    sourceCandidateId,
    evalSet: report.taskSet,
    repeats: report.repeats,
    baselinePass: report.baseline.passRate,
    candidatePass: report.treatment.passRate,
    verdict: report.verdict,
    cost: { baseline: armCost(report.baseline), treatment: armCost(report.treatment) },
    report,
    decidedAt: report.decidedAt,
  };
}
