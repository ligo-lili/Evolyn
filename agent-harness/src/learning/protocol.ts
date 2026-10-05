import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EvalTaskSet } from "./eval.js";

/**
 * 阶段 14: the pinned protocol + session artifacts — extracted from eval.ts in
 * the 加固期第三轮 split. Equal sha256 ⇒ two reports are comparable;
 * `learning/eval.js` re-exports this surface, so it stays the single import
 * point for callers.
 */

/** Bump when judging SEMANTICS change — the sha pins protocol + judge era.
 * v3 (加固期第三轮): expectSorted grades codepoint order — locale-independent. */
export const EVAL_JUDGE_VERSION = 3;

/** Key-sorted JSON — the canonical form the protocol sha is computed over.
 * 加固期第三轮: codepoint key order, locale-independent (cross-machine shas). */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, vv]) => [k, sort(vv)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export interface EvalProtocol {
  taskSet: string;
  tasks: unknown[];
  model: string;
  toolset?: string;
  repeats: number;
  judgeVersion: number;
}

/** The protocol pins everything the comparison depends on — except the arm
 * itself (skill vs no-skill), which is the variable under test. Equal
 * sha256 ⇒ the two reports are comparable. */
export function buildProtocol(
  taskSet: EvalTaskSet,
  opts: { model: string; toolset?: string; repeats: number },
): { protocol: EvalProtocol; sha256: string } {
  const protocol: EvalProtocol = {
    taskSet: taskSet.name,
    // codepoint order — the protocol sha must not depend on the machine's ICU (加固期第三轮)
    tasks: [...taskSet.tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    model: opts.model,
    toolset: opts.toolset,
    repeats: opts.repeats,
    judgeVersion: EVAL_JUDGE_VERSION,
  };
  const sha256 = createHash("sha256").update(stableStringify(protocol)).digest("hex");
  return { protocol, sha256 };
}

/** One line of session.jsonl — the replay/attribution index for one run. */
export interface EvalSessionLine {
  seq: number;
  repeat: number;
  arm: "baseline" | "treatment";
  taskId: string;
  runId?: string;
  tracePath?: string;
  status: string;
  pass: boolean;
  reason?: string;
  verified?: boolean;
  tokens?: number;
  durationMs?: number;
}

/** protocol.json + session.jsonl for one comparison (used by both the
 * full A/B and the regression path in eval.ts). */
export function writeSessionArtifacts(
  dir: string,
  protocol: EvalProtocol,
  sha256: string,
  session: readonly EvalSessionLine[],
): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "protocol.json"), JSON.stringify({ ...protocol, sha256 }, null, 2), "utf8");
  const sessionFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionFile, session.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return sessionFile;
}
