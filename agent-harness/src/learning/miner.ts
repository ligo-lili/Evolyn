import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TraceEvent } from "../trace/schema.js";
import { RunRepo } from "../storage/repos/runs.js";
import { TraceEventRepo } from "../storage/repos/trace-events.js";

/**
 * 阶段 10 pattern mining, deliberately the dumbest thing that works:
 * tool-name n-grams across runs, plus error→repair pairs (a tool that failed
 * and later succeeded within the same run). Everything is computed from the
 * authoritative trace_events; the patterns table is a rebuildable projection.
 *
 * Hard rule enforced here AND in candidate.ts: a pattern only exists at
 * support >= MIN_PATTERN_SUPPORT — three independent runs must agree before
 * anything downstream (skill drafting) is allowed to look at it.
 */
export const MIN_PATTERN_SUPPORT = 3;

export type PatternKind = "tool-sequence" | "error-repair";

export interface MinedCall {
  toolName: string;
  isError: boolean;
  /** First text block of an error toolResult, truncated — distiller context. */
  errorText?: string;
}

export interface RunToolTrace {
  runId: string;
  task: string;
  status: string;
  /** Ordered tool calls, as seen by the model. */
  calls: MinedCall[];
}

export type ReplaySafety = "all-safe" | "contains-never" | "unknown";

export interface PatternDraft {
  id: string;
  kind: PatternKind;
  /** tool-sequence: "read_file>write_file" · error-repair: "repair:read_file" */
  signature: string;
  /** Distinct runs exhibiting the pattern. */
  support: number;
  traceRefs: string[];
  /**
   * Pattern-aware tool idempotency (阶段 12): does the sequence involve
   * replay:"never" tools? Such patterns are hazardous to auto-retry or
   * re-execute (crash recovery / retry tiering read the same marker).
   * "unknown" when mined without a tool replay map.
   */
  replaySafety: ReplaySafety;
}

/** Deterministic pattern id: same signature → same id across re-mining. */
export function patternId(kind: PatternKind, signature: string): string {
  return createHash("sha1").update(`${kind}:${signature}`).digest("hex").slice(0, 16);
}

const ERROR_TEXT_MAX = 200;

function signatureTools(kind: PatternKind, signature: string): string[] {
  return kind === "error-repair" ? [signature.slice("repair:".length)] : signature.split(">");
}

function replaySafetyOf(kind: PatternKind, signature: string, toolReplay?: Record<string, string>): ReplaySafety {
  if (!toolReplay) return "unknown";
  return signatureTools(kind, signature).some((t) => toolReplay[t] === "never") ? "contains-never" : "all-safe";
}

/**
 * Extract a run's ordered tool-call trace from its events. toolResult messages
 * are the authoritative per-call record (阶段 7 口径): every call — real or
 * recovery-synthesized — ends with exactly one toolResult.
 */
export function extractRunToolTrace(
  run: { id: string; task: string; status: string },
  events: readonly TraceEvent[],
): RunToolTrace {
  const calls: MinedCall[] = [];
  for (const event of events) {
    if (event.type !== "message_end") continue;
    const m = event.message;
    if (m.role !== "toolResult") continue;
    let errorText: string | undefined;
    if (m.isError) {
      const text = m.content.find((b): b is { type: "text"; text: string } => b.type === "text");
      errorText = text ? text.text.slice(0, ERROR_TEXT_MAX) : undefined;
    }
    calls.push({ toolName: m.toolName, isError: Boolean(m.isError), errorText });
  }
  return { runId: run.id, task: run.task, status: run.status, calls };
}

export interface MineOptions {
  /** Hard floor (default 3). Lower values are rejected, not clamped. */
  minSupport?: number;
  /** Longest n-gram (default 3). */
  maxN?: number;
  /** Tool name → replay marker ("safe"|"never"); enables replaySafety classification. */
  toolReplay?: Record<string, string>;
}

interface Accumulator {
  signature: string;
  runs: Set<string>;
}

function buildPatterns(
  kind: PatternKind,
  acc: Map<string, Accumulator>,
  minSupport: number,
  toolReplay?: Record<string, string>,
): PatternDraft[] {
  return [...acc.values()]
    .filter((a) => a.runs.size >= minSupport)
    .map((a) => ({
      id: patternId(kind, a.signature),
      kind,
      signature: a.signature,
      support: a.runs.size,
      traceRefs: [...a.runs].sort(),
      replaySafety: replaySafetyOf(kind, a.signature, toolReplay),
    }))
    .sort((a, b) => b.support - a.support || a.signature.localeCompare(b.signature));
}

/**
 * Mine patterns from run traces. An n-gram's support counts DISTINCT runs; a
 * repeated n-gram inside one run counts once. n-grams made of a single
 * repeated tool (read_file>read_file) are repetition, not workflow — skipped.
 */
export function minePatterns(runs: readonly RunToolTrace[], options: MineOptions = {}): PatternDraft[] {
  const minSupport = options.minSupport ?? MIN_PATTERN_SUPPORT;
  if (minSupport < MIN_PATTERN_SUPPORT) {
    throw new Error(
      `minSupport ${minSupport} is below the hard floor (${MIN_PATTERN_SUPPORT}) — single-run patterns are not minable`,
    );
  }
  const maxN = options.maxN ?? 3;

  const sequences = new Map<number, Map<string, Accumulator>>();
  const repairs = new Map<string, Accumulator>();

  for (const run of runs) {
    const names = run.calls.map((c) => c.toolName);
    for (let n = 2; n <= maxN; n++) {
      let acc = sequences.get(n);
      if (!acc) sequences.set(n, (acc = new Map()));
      const seen: Set<string> = new Set();
      for (let i = 0; i + n <= names.length; i++) {
        const window = names.slice(i, i + n);
        if (new Set(window).size === 1) continue; // repetition, not a workflow
        const signature = window.join(">");
        if (seen.has(signature)) continue;
        seen.add(signature);
        const entry = acc.get(signature) ?? { signature, runs: new Set<string>() };
        entry.runs.add(run.runId);
        acc.set(signature, entry);
      }
    }

    // error→repair: the tool failed at some point and succeeded in a LATER call
    // of the same run (the model recovered) — one repair per (run, tool).
    const lastFailure = new Map<string, number>();
    const repaired = new Set<string>();
    run.calls.forEach((call, i) => {
      if (call.isError) lastFailure.set(call.toolName, i);
      else if (lastFailure.has(call.toolName) && !repaired.has(call.toolName)) {
        repaired.add(call.toolName);
        const signature = `repair:${call.toolName}`;
        const entry = repairs.get(signature) ?? { signature, runs: new Set<string>() };
        entry.runs.add(run.runId);
        repairs.set(signature, entry);
      }
    });
  }

  const mined: PatternDraft[] = [];
  for (const acc of [...sequences.values()]) {
    mined.push(...buildPatterns("tool-sequence", acc, minSupport, options.toolReplay));
  }
  mined.push(...buildPatterns("error-repair", repairs, minSupport, options.toolReplay));
  return mined;
}

/** CLI entry: mine patterns from every finished run in the database. */
export function minePatternsFromDb(db: DatabaseSync, options: MineOptions = {}): PatternDraft[] {
  const runRepo = new RunRepo(db);
  const eventRepo = new TraceEventRepo(db);
  const runs = runRepo
    .getByStatus("completed") // mine workflows that actually worked
    .map((r) => extractRunToolTrace(r, eventRepo.getByRun(r.id)))
    .filter((t) => t.calls.length > 0);
  return minePatterns(runs, options);
}
