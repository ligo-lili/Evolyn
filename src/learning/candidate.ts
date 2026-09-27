import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import { HarnessError } from "../errors.js";
import { completeStructured, defaultChat, type ChatFn } from "../llm/structured.js";
import { resolveModel } from "../providers.js";
import { defaultDbPath, openDatabase } from "../storage/db.js";
import { RunRepo } from "../storage/repos/runs.js";
import { TraceEventRepo } from "../storage/repos/trace-events.js";
import { PatternRepo, type PatternRow } from "../storage/repos/patterns.js";
import { SkillCandidateRepo, type CandidateProvenance, type SkillCandidateRow } from "../storage/repos/candidates.js";
import { parseSkillMd, serializeSkillMd, SKILL_DESCRIPTION_MAX } from "../skills/format.js";
import { extractRunToolTrace, MIN_PATTERN_SUPPORT, type RunToolTrace } from "./miner.js";
import { skillsDir } from "../runtime/paths.js";

/**
 * 阶段 10 skill candidates: distill a support≥3 pattern into a draft SKILL.md
 * with full provenance. THE hard constraint lives here — a candidate can only
 * be created from a pattern that cleared MIN_PATTERN_SUPPORT, so a skill can
 * never be drafted from a single run. (promote.ts re-validates the format.)
 */

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

export const SKILL_DRAFT_SCHEMA = Type.Object({
  name: Type.String({ description: "skill name: lowercase slug [a-z0-9-], <=64 chars, e.g. note-file-workflow" }),
  description: Type.String({ description: `what the skill does and when to use it, <=${SKILL_DESCRIPTION_MAX} chars` }),
  body: Type.String({ description: "markdown instructions: step-by-step approach, which tools in which order, pitfalls to avoid" }),
});

export const CANDIDATE_SYSTEM_PROMPT =
  "You distill recurring tool-use patterns from agent runs into a reusable skill draft. " +
  "You will see one pattern (a tool sequence or an error→repair habit) and the runs that support it. " +
  "Write the skill so a future agent facing a similar task can follow it: concrete steps, which tools in which order, and the pitfalls observed in the runs. " +
  "Base the skill ONLY on what the runs show — do not invent capabilities. " +
  "Output ONLY strict JSON (no markdown fences, no commentary) with exactly these keys: " +
  'name (lowercase slug [a-z0-9-], <=64 chars), ' +
  "description (what the skill does and when to use it), " +
  "body (markdown instructions).";

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

/** Tolerant normalization: slug the name, trim/truncate the description; throw only on empty fields. */
export function parseSkillDraftStrict(raw: string, source = "candidate draft"): SkillDraft {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in response");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const name = slugify(String(parsed.name ?? ""), "");
  if (!name) throw new Error("name is missing or not sluggable");
  const description = String(parsed.description ?? "").trim().slice(0, SKILL_DESCRIPTION_MAX);
  if (!description) throw new Error("description is missing");
  const body = String(parsed.body ?? "").trim();
  if (!body) throw new Error("body is missing");
  return { name, description, body };
}

/** The per-run context the distiller sees (tasks + call sequences + error texts). */
export function buildCandidatePrompt(pattern: PatternRow, runs: readonly RunToolTrace[]): string {
  const MAX_RUNS_SHOWN = 10;
  const runLines = runs.slice(0, MAX_RUNS_SHOWN).map((r) => {
    const calls = r.calls.map((c) => `${c.toolName}${c.isError ? "(error)" : ""}`).join(" -> ");
    const errors = r.calls.filter((c) => c.errorText).map((c) => c.errorText);
    return `- task: ${r.task}\n  calls: ${calls}${errors.length ? `\n  errors: ${errors.join(" | ")}` : ""}`;
  });
  return [
    "Distill this recurring pattern into a skill draft JSON:",
    `pattern kind: ${pattern.kind}`,
    `pattern signature: ${pattern.signature}`,
    `support: ${pattern.support} independent runs`,
    "",
    "Supporting runs:",
    runLines.join("\n"),
  ].join("\n");
}

/** Mechanical draft used when even the structured pipeline fails — the loop must not dead-end. */
export function fallbackSkillDraft(pattern: PatternRow): SkillDraft {
  const kindPrefix = pattern.kind === "error-repair" ? "repair" : "workflow";
  const name = slugify(`${kindPrefix}-${pattern.signature}`, `pattern-${pattern.id.slice(0, 8)}`);
  const description = `Drafted from ${pattern.support} runs: ${pattern.kind === "error-repair" ? "recovery habit" : "tool workflow"} ${pattern.signature}.`;
  const body = [
    `# ${kindPrefix}: ${pattern.signature}`,
    "",
    `This draft was generated mechanically (LLM distillation was unavailable) from ${pattern.support} supporting runs.`,
    pattern.kind === "error-repair"
      ? `When a ${pattern.signature.replace("repair:", "")} call fails, re-attempt it with adjusted arguments — the supporting runs show this recovery succeeded.`
      : `Follow this tool order: ${pattern.signature.split(">").join(" → ")}.`,
    "",
    "## Supporting tasks",
    ...pattern.traceRefs.slice(0, 10).map((id) => `- run ${id}`),
  ].join("\n");
  return { name, description, body };
}

export interface DraftOptions {
  database?: string;
  /** Cheap distillation model spec; defaults to HARNESS_DISTILL_MODEL or deepseek/deepseek-flash. */
  modelSpec?: string;
  /** Injectable chat for tests; default goes through the pi-ai registry. */
  complete?: ChatFn;
  /** Where drafts and promoted skills live; default .harness/skills. */
  skillsRoot?: string;
}

export interface DraftOutcome {
  candidate: SkillCandidateRow;
  file: string;
  /** "llm" = structured distillation succeeded; "fallback" = mechanical draft. */
  method: "llm" | "fallback";
}

/**
 * Distill a pattern into a draft candidate. Throws when the pattern does not
 * exist or — the hard rule — when its support is below MIN_PATTERN_SUPPORT.
 */
export async function draftSkillFromPattern(patternKey: string, options: DraftOptions = {}): Promise<DraftOutcome> {
  const dbPath = options.database ?? defaultDbPath();
  const db = openDatabase(dbPath);
  try {
    const pattern = new PatternRepo(db).get(patternKey);
    if (!pattern) throw new HarnessError(`pattern "${patternKey}" not found — run \`skill mine\` first`);
    if (pattern.support < MIN_PATTERN_SUPPORT) {
      throw new HarnessError(
        `pattern "${pattern.signature}" has support ${pattern.support} < ${MIN_PATTERN_SUPPORT}: candidates may only be generated from patterns seen in at least ${MIN_PATTERN_SUPPORT} independent runs (single-run skills are forbidden)`,
      );
    }

    const eventRepo = new TraceEventRepo(db);
    const runRepo = new RunRepo(db);
    const traces = pattern.traceRefs
      .map((runId) => runRepo.get(runId))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .map((r) => extractRunToolTrace(r, eventRepo.getByRun(r.id)));

    let draft: SkillDraft;
    let method: DraftOutcome["method"] = "llm";
    try {
      const spec = options.modelSpec ?? process.env.HARNESS_DISTILL_MODEL ?? "deepseek/deepseek-flash";
      const model = resolveModel(spec) as Model<Api>;
      const complete: ChatFn = options.complete ?? defaultChat(model, { systemPrompt: CANDIDATE_SYSTEM_PROMPT });
      const { value } = await completeStructured({
        prompt: buildCandidatePrompt(pattern, traces),
        parse: (raw) => parseSkillDraftStrict(raw),
        complete,
        maxReprompts: 1,
        schemaTool: {
          name: "store_skill_draft",
          description: "Store the skill draft. Call this with the complete JSON payload.",
          parameters: SKILL_DRAFT_SCHEMA,
        },
      });
      draft = value;
    } catch (err) {
      process.stderr.write(
        `[skills] structured distillation failed (${err instanceof Error ? err.message : err}); using mechanical fallback draft\n`,
      );
      draft = fallbackSkillDraft(pattern);
      method = "fallback";
    }

    const skillsRoot = options.skillsRoot ?? skillsDir();
    const candidateId = randomUUID();
    const draftDir = path.join(skillsRoot, "drafts", candidateId);
    fs.mkdirSync(draftDir, { recursive: true });
    const file = path.join(draftDir, "SKILL.md");
    fs.writeFileSync(file, serializeSkillMd(draft), "utf8");

    // The file on disk is the authority — parse it back so the row reflects
    // exactly what promote() will later read.
    const doc = parseSkillMd(fs.readFileSync(file, "utf8"), file);
    const provenance: CandidateProvenance = {
      patternId: pattern.id,
      patternKind: pattern.kind,
      patternSignature: pattern.signature,
      support: pattern.support,
      runIds: pattern.traceRefs,
      model: options.complete ? "injected" : (options.modelSpec ?? process.env.HARNESS_DISTILL_MODEL ?? "deepseek/deepseek-flash"),
      method,
      distilledAt: new Date().toISOString(),
    };
    const candidate: SkillCandidateRow = {
      id: candidateId,
      patternId: pattern.id,
      status: "draft",
      name: doc.name,
      description: doc.description,
      skillMdPath: file,
      provenance,
      createdAt: new Date().toISOString(),
    };
    new SkillCandidateRepo(db).insert(candidate);
    return { candidate, file, method };
  } finally {
    db.close();
  }
}
