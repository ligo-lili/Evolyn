import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { HarnessError } from "../errors.js";
import { TRACE_SCHEMA_VERSION, type TraceEvent } from "./schema.js";

export interface ParsedTrace {
  runId: string;
  events: TraceEvent[];
}

export interface TraceFileInfo {
  runId: string;
  filePath: string;
  mtimeMs: number;
}

/**
 * Parses and validates a trace file: schema version, envelope integrity,
 * strictly increasing seq from 1, and the run_start…run_end lifecycle bracket.
 * A trace ending without run_end means the process died mid-run — that is a
 * crash-recovery candidate (阶段 5), reported as its own error here.
 */
export function readTraceFile(filePath: string): ParsedTrace {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new HarnessError(`cannot read trace file ${filePath}: ${err instanceof Error ? err.message : err}`);
  }

  const events: TraceEvent[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const at = `${filePath}:${i + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new HarnessError(`${at}: invalid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new HarnessError(`${at}: event must be an object`);
    }
    const ev = parsed as TraceEvent;
    if (ev.v !== TRACE_SCHEMA_VERSION) {
      throw new HarnessError(`${at}: schema version ${String(ev.v)}, expected ${TRACE_SCHEMA_VERSION}`);
    }
    if (typeof ev.seq !== "number" || typeof ev.ts !== "string" || typeof ev.runId !== "string" || typeof ev.type !== "string") {
      throw new HarnessError(`${at}: missing envelope fields (v/seq/ts/runId/type)`);
    }
    events.push(ev);
  }

  events.forEach((ev, i) => {
    if (ev.seq !== i + 1) {
      throw new HarnessError(`${filePath}: seq ${ev.seq} at position ${i + 1}, expected ${i + 1} (gap or reorder)`);
    }
    if (ev.runId !== events[0]?.runId) {
      throw new HarnessError(`${filePath}: mixed runIds "${events[0]?.runId}" and "${ev.runId}"`);
    }
  });

  const first = events[0];
  const last = events.at(-1);
  if (!first || first.type !== "run_start") {
    throw new HarnessError(`${filePath}: first event must be run_start`);
  }
  if (!last || last.type !== "run_end") {
    throw new HarnessError(
      `${filePath}: trace ends without run_end (${events.length} events) — the run was interrupted; recovery lands in 阶段 5`,
    );
  }
  return { runId: first.runId, events };
}

/** All trace files in a directory, oldest first. */
export function listTraces(dir: string): TraceFileInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const filePath = path.join(dir, f);
      return { runId: f.replace(/\.jsonl$/, ""), filePath, mtimeMs: statSync(filePath).mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}
