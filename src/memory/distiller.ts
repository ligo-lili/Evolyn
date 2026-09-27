import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import { HarnessError } from "../errors.js";
import { completeStructured, defaultChat, type ChatFn } from "../llm/structured.js";
import { resolveModel, getModelRegistry } from "../providers.js";
import { defaultDbPath, openDatabase } from "../storage/db.js";
import { RunRepo } from "../storage/repos/runs.js";
import { TraceEventRepo } from "../storage/repos/trace-events.js";
import { MemorySearchIndex } from "./search.js";
import { MemoryStore } from "./store.js";
import type { MemoryRecord } from "./model.js";

export interface RunDigest {
  runId: string;
  task: string;
  modelSpec: string;
  status: string;
  error?: string;
  toolCalls: Array<{ toolName: string; args?: unknown; isError?: boolean }>;
  finalAssistantText?: string;
}

export interface ExperienceDraft {
  /** When set to an existing memory id, this run CONFIRMS/refines that memory instead of creating a new one. */
  updateOf?: string;
  taskType: string;
  summaryEn: string;
  summaryZh: string;
  approach: string;
  pitfalls: string;
  outcome: "success" | "partial" | "failed";
  keywordsEn: string[];
}

export type CompleteFn = (prompt: string) => Promise<string>;

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Compact the run into the digest the distiller sees (tool args truncated). */
export function buildRunDigest(
  record: { runId?: string; id?: string; task: string; modelSpec: string; status: string; error?: string },
  messages: readonly AgentMessage[],
): RunDigest {
  const toolCalls: RunDigest["toolCalls"] = [];
  let finalAssistantText: string | undefined;
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const block of m.content) {
        if (block.type === "toolCall") {
          toolCalls.push({ toolName: block.name, args: block.arguments });
        }
      }
      const text = textOf(m.content);
      if (text.trim()) finalAssistantText = text;
    } else if (m.role === "toolResult") {
      const call = [...toolCalls].reverse().find((c) => c.toolName === m.toolName && c.isError === undefined);
      if (call) call.isError = m.isError;
    }
  }
  return {
    runId: record.runId ?? record.id ?? "",
    task: record.task,
    modelSpec: record.modelSpec,
    status: record.status,
    error: record.error,
    toolCalls,
    finalAssistantText,
  };
}

export const DISTILL_SYSTEM_PROMPT =
  "You distill coding-agent runs into reusable memory records for future retrieval. " +
  "You will see the run digest and EXISTING memory candidates. " +
  "If this run is essentially the same task/pattern as one candidate, set updateOf to that candidate's id (a confirmation — refine its fields with what this run added). " +
  "Otherwise omit updateOf and create a new record. " +
  "Output ONLY strict JSON (no markdown fences, no commentary) with exactly these keys: " +
  "updateOf (optional existing memory id), " +
  'taskType (short english slug like "file-organization"), ' +
  "summaryEn (<=2 english sentences describing what the run did and how it went), " +
  "summaryZh (同样内容的中文，不超过两句), " +
  "approach (english: what worked, 1-2 sentences), " +
  "pitfalls (english: what to avoid next time, 1 sentence), " +
  'outcome ("success" | "partial" | "failed"), ' +
  "keywordsEn (array of 3-8 english search keywords).";

export function buildDistillPrompt(digest: RunDigest, candidates: MemoryRecord[] = []): string {
  const trimmed = {
    ...digest,
    finalAssistantText: digest.finalAssistantText?.slice(0, 1_000),
    toolCalls: digest.toolCalls.slice(0, 30).map((c) => ({ ...c, args: truncated(c.args) })),
  };
  const candidateLines = candidates.map((c) => `- id: ${c.id} | taskType: ${c.taskType} | confirmations: ${c.confirmations} | ${c.summaryEn}`);
  return [
    "Distill this agent run into the experience JSON:",
    JSON.stringify(trimmed, null, 1),
    candidateLines.length ? `\nEXISTING memory candidates (set updateOf if this run confirms one):\n${candidateLines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function truncated(value: unknown): unknown {
  const s = JSON.stringify(value);
  if (s === undefined || s.length <= 300) return value;
  return s.slice(0, 300) + "…";
}

function slugify(value: unknown, fallback: string): string {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function normalizeOutcome(value: unknown, status: string): ExperienceDraft["outcome"] {
  const v = String(value ?? "").toLowerCase();
  if (v === "success" || v === "partial" || v === "failed") return v;
  return status === "completed" ? "success" : "failed";
}

export function fallbackDraft(digest: RunDigest): ExperienceDraft {
  const keywords = [...new Set(digest.task.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2))].slice(0, 8);
  return {
    taskType: "uncategorized",
    summaryEn: `Run ${digest.status} for task: ${digest.task}`,
    summaryZh: `任务「${digest.task}」${digest.status === "completed" ? "已完成" : "未成功完成"}。`,
    approach: digest.toolCalls.length ? `Used tools: ${[...new Set(digest.toolCalls.map((c) => c.toolName))].join(", ")}.` : "No tool calls recorded.",
    pitfalls: digest.error ? `Failed with: ${digest.error}` : "None recorded.",
    outcome: normalizeOutcome(undefined, digest.status),
    keywordsEn: keywords,
  };
}

/** Tolerant wrapper: strict parse, falling back to a naive draft on garbage. */
export function parseExperienceDraft(raw: string, digest: RunDigest): ExperienceDraft {
  try {
    return parseExperienceDraftStrict(raw, digest);
  } catch {
    return fallbackDraft(digest);
  }
}

/** Strict parse — throws on anything that is not a well-formed draft JSON. */
export function parseExperienceDraftStrict(raw: string, digest: RunDigest): ExperienceDraft {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in response");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const keywords = Array.isArray(parsed.keywordsEn)
    ? parsed.keywordsEn.map((k) => String(k)).filter(Boolean).slice(0, 8)
    : String(parsed.keywordsEn ?? "").split(/[,\s]+/).filter(Boolean).slice(0, 8);
  return {
    updateOf: typeof parsed.updateOf === "string" && parsed.updateOf.trim() ? parsed.updateOf.trim() : undefined,
    taskType: slugify(parsed.taskType, "uncategorized"),
    summaryEn: String(parsed.summaryEn ?? "").trim() || `Run ${digest.status} for task: ${digest.task}`,
    summaryZh: String(parsed.summaryZh ?? "").trim() || fallbackDraft(digest).summaryZh,
    approach: String(parsed.approach ?? "").trim() || "Not recorded.",
    pitfalls: String(parsed.pitfalls ?? "").trim() || "Not recorded.",
    outcome: normalizeOutcome(parsed.outcome, digest.status),
    keywordsEn: keywords,
  };
}

export const MEMORY_DRAFT_SCHEMA = Type.Object({
  updateOf: Type.Optional(Type.String({ description: "id of an existing memory this run confirms" })),
  taskType: Type.String(),
  summaryEn: Type.String(),
  summaryZh: Type.String(),
  approach: Type.String(),
  pitfalls: Type.String(),
  outcome: Type.Union([Type.Literal("success"), Type.Literal("partial"), Type.Literal("failed")]),
  keywordsEn: Type.Array(Type.String()),
});

export function defaultChatForModel(model: Model<Api>): ChatFn {
  return defaultChat(model, { systemPrompt: DISTILL_SYSTEM_PROMPT });
}

export async function distillExperience(
  digest: RunDigest,
  complete: ChatFn,
  candidates: MemoryRecord[] = [],
): Promise<ExperienceDraft> {
  // 阶段 9.8: direct parse → re-prompt with the parse error → constrained
  // decoding (schema tool); distillRunById applies the naive draft as the
  // last-resort fallback when even this pipeline fails.
  const { value } = await completeStructured({
    prompt: buildDistillPrompt(digest, candidates),
    parse: (raw) => parseExperienceDraftStrict(raw, digest),
    complete,
    maxReprompts: 1,
    schemaTool: {
      name: "store_memory",
      description: "Store the distilled memory record. Call this with the complete JSON payload.",
      parameters: MEMORY_DRAFT_SCHEMA,
    },
  });
  return value;
}

export interface DistillOptions {
  database?: string;
  /** Cheap distillation model spec; defaults to HARNESS_DISTILL_MODEL or deepseek/deepseek-flash. */
  distillModelSpec?: string;
  /** Injectable chat for tests; default goes through the pi-ai registry. */
  complete?: ChatFn;
}

export interface DistillOutcome {
  record: MemoryRecord;
  /** True when this run confirmed/refined an existing memory instead of creating one. */
  merged: boolean;
  file: string;
}

/**
 * Distills a finished run into memory (阶段 9.5): loads run + trace from the
 * database, recalls same-topic candidates, asks the distiller to either
 * confirm/refine an existing memory (write-time reflection) or create a new
 * one, then persists to the authoritative Markdown store and syncs the
 * derived search index. Throws on distiller/network failure — callers decide
 * whether to warn.
 */
export async function distillRunById(runId: string, options: DistillOptions = {}): Promise<DistillOutcome> {
  const dbPath = options.database ?? defaultDbPath();
  const db = openDatabase(dbPath);
  try {
    const runRow = new RunRepo(db).get(runId);
    if (!runRow) throw new HarnessError(`run "${runId}" not found`);
    if (runRow.status === "running") throw new HarnessError(`run "${runId}" is still running — nothing to distill yet`);

    const messages = new TraceEventRepo(db)
      .getByRun(runId)
      .filter((e) => e.type === "message_end")
      .map((e) => e.message);
    const digest = buildRunDigest(runRow, messages);

    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    const index = new MemorySearchIndex(db);
    const candidates = index.searchFts(digest.task, 3);

    const spec = options.distillModelSpec ?? process.env.HARNESS_DISTILL_MODEL ?? "deepseek/deepseek-flash";
    const complete = options.complete ?? defaultChatForModel(resolveModel(spec));
    let draft: ExperienceDraft;
    try {
      draft = await distillExperience(digest, complete, candidates);
    } catch (err) {
      // Last-resort fallback (阶段 9.8): even the structured pipeline failed —
      // store a naive record rather than losing the run's experience entirely.
      process.stderr.write(`[memory] structured distillation failed (${err instanceof Error ? err.message : err}); using naive draft\n`);
      draft = fallbackDraft(digest);
    }

    const now = new Date().toISOString();
    let record: MemoryRecord;
    let merged = false;
    const existing = draft.updateOf ? store.get(draft.updateOf) : undefined;
    if (existing) {
      // Write-time reflection: this run confirms the existing memory. Original
      // runId provenance is preserved; content is refined by this run.
      record = {
        ...existing,
        summaryEn: draft.summaryEn,
        summaryZh: draft.summaryZh,
        approach: draft.approach,
        pitfalls: draft.pitfalls,
        outcome: draft.outcome,
        keywordsEn: [...new Set([...existing.keywordsEn, ...draft.keywordsEn])].slice(0, 10),
        confirmations: existing.confirmations + 1,
        updated: now,
      };
      merged = true;
    } else {
      record = {
        id: randomUUID(),
        runId,
        taskType: draft.taskType,
        outcome: draft.outcome,
        summaryEn: draft.summaryEn,
        summaryZh: draft.summaryZh,
        approach: draft.approach,
        pitfalls: draft.pitfalls,
        keywordsEn: draft.keywordsEn,
        confirmations: 0,
        model: spec,
        created: now,
        updated: now,
      };
    }
    const file = store.save(record);
    index.syncRecord(record);
    return { record, merged, file };
  } finally {
    db.close();
  }
}

export { MemoryStore, MemorySearchIndex };
export type { MemoryRecord };
