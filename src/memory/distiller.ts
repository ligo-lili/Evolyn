import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { HarnessError } from "../errors.js";
import { resolveModel, getModelRegistry } from "../providers.js";
import { defaultDbPath, openDatabase } from "../storage/db.js";
import { RunRepo } from "../storage/repos/runs.js";
import { TraceEventRepo } from "../storage/repos/trace-events.js";
import { ExperienceRepo, newExperienceId, type ExperienceRecord } from "./store.js";

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
  "You distill coding-agent runs into reusable experience records for future retrieval. " +
  "Output ONLY strict JSON (no markdown fences, no commentary) with exactly these keys: " +
  'taskType (short english slug like "file-organization"), ' +
  "summaryEn (<=2 english sentences describing what the run did and how it went), " +
  "summaryZh (同样内容的中文，不超过两句), " +
  "approach (english: what worked, 1-2 sentences), " +
  "pitfalls (english: what to avoid next time, 1 sentence), " +
  'outcome ("success" | "partial" | "failed"), ' +
  "keywordsEn (array of 3-8 english search keywords).";

export function buildDistillPrompt(digest: RunDigest): string {
  const trimmed = {
    ...digest,
    finalAssistantText: digest.finalAssistantText?.slice(0, 1_000),
    toolCalls: digest.toolCalls.slice(0, 30).map((c) => ({ ...c, args: truncated(c.args) })),
  };
  return `Distill this agent run into the experience JSON:\n${JSON.stringify(trimmed, null, 1)}`;
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

/** Tolerant parsing: find the first {...} blob, normalize fields, fall back on garbage. */
export function parseExperienceDraft(raw: string, digest: RunDigest): ExperienceDraft {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("no JSON object found");
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const keywords = Array.isArray(parsed.keywordsEn)
      ? parsed.keywordsEn.map((k) => String(k)).filter(Boolean).slice(0, 8)
      : String(parsed.keywordsEn ?? "").split(/[,\s]+/).filter(Boolean).slice(0, 8);
    const draft: ExperienceDraft = {
      taskType: slugify(parsed.taskType, "uncategorized"),
      summaryEn: String(parsed.summaryEn ?? "").trim() || `Run ${digest.status} for task: ${digest.task}`,
      summaryZh: String(parsed.summaryZh ?? "").trim() || fallbackDraft(digest).summaryZh,
      approach: String(parsed.approach ?? "").trim() || "Not recorded.",
      pitfalls: String(parsed.pitfalls ?? "").trim() || "Not recorded.",
      outcome: normalizeOutcome(parsed.outcome, digest.status),
      keywordsEn: keywords,
    };
    return draft;
  } catch {
    return fallbackDraft(digest);
  }
}

export function defaultComplete(model: Model<Api>): CompleteFn {
  const models = getModelRegistry();
  return async (prompt: string) => {
    const assistant = await models.completeSimple(model, {
      systemPrompt: DISTILL_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() } as never],
    });
    return textOf(assistant.content);
  };
}

export function draftToRecord(draft: ExperienceDraft, runId: string): ExperienceRecord {
  return {
    id: newExperienceId(),
    runId,
    taskType: draft.taskType,
    summaryEn: draft.summaryEn,
    summaryZh: draft.summaryZh,
    approach: draft.approach,
    pitfalls: draft.pitfalls,
    outcome: draft.outcome,
    keywordsEn: draft.keywordsEn.join(" "),
    createdAt: new Date().toISOString(),
  };
}

export interface DistillOptions {
  database?: string;
  /** Cheap distillation model spec; defaults to HARNESS_DISTILL_MODEL or deepseek/deepseek-flash. */
  distillModelSpec?: string;
  /** Injectable completion for tests; default goes through the pi-ai registry. */
  complete?: CompleteFn;
}

/**
 * Distills a finished run into an experience record (阶段 9). Loads the run +
 * trace from the database, builds the digest, calls the distiller once
 * (cheap model), and stores the bilingual record with an FTS-indexed English
 * half. Throws on distiller/network failure — callers decide whether to warn.
 */
export async function distillRunById(runId: string, options: DistillOptions = {}): Promise<ExperienceRecord> {
  const db = openDatabase(options.database ?? defaultDbPath());
  try {
    const runRow = new RunRepo(db).get(runId);
    if (!runRow) throw new HarnessError(`run "${runId}" not found`);
    if (runRow.status === "running") throw new HarnessError(`run "${runId}" is still running — nothing to distill yet`);

    const messages = new TraceEventRepo(db)
      .getByRun(runId)
      .filter((e) => e.type === "message_end")
      .map((e) => e.message);
    const digest = buildRunDigest(runRow, messages);

    const spec = options.distillModelSpec ?? process.env.HARNESS_DISTILL_MODEL ?? "deepseek/deepseek-flash";
    const complete = options.complete ?? defaultComplete(resolveModel(spec));
    const draft = await distillExperience(digest, complete);

    const record: ExperienceRecord = { ...draftToRecord(draft, runId), model: spec };
    new ExperienceRepo(db).insert(record);
    return record;
  } finally {
    db.close();
  }
}

export async function distillExperience(digest: RunDigest, complete: CompleteFn): Promise<ExperienceDraft> {
  const raw = await complete(buildDistillPrompt(digest));
  return parseExperienceDraft(raw, digest);
}
