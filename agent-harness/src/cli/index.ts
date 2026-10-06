#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError } from "../errors.js";
import { defaultModelSpec } from "../config.js";
import { getModelRegistry, listProviderIds, resolveModel } from "../providers.js";
import { listTraces } from "../trace/read.js";
import { explain } from "../trace/replay.js";
import { summarize } from "../trace/query.js";
import { renderReplay, renderSummary, renderTimeline } from "../trace/show.js";
import { defaultDbPath, openDatabase } from "../storage/db.js";
import { RunRepo } from "../storage/repos/runs.js";
import { TraceEventRepo } from "../storage/repos/trace-events.js";
import { harnessDataDir, tracesDir } from "../runtime/paths.js";
import { ConsoleReporter } from "../runtime/reporter.js";
import { RunManager } from "../runtime/run-manager.js";
import { ChatApp, type ChatExitSummary } from "../modes/interactive/chat.js";
import { type ApprovalMode } from "../runtime/approval.js";
import { ALL_CAPABILITIES, type Capability } from "../runtime/permissions.js";
import type { ToolsetSpec } from "../runtime/run-manager.js";
import type { TraceEvent } from "../trace/schema.js";
import { reflectRunById } from "../memory/reflection.js";
import { MAX_ACTIVE_MEMORIES, MemoryStore } from "../memory/store.js";
import { MemorySearchIndex } from "../memory/search.js";
import { EMBEDDING_MODEL_ID, localEmbedder } from "../memory/embedding.js";
import { minePatternsFromDb } from "../learning/miner.js";
import { draftSkillFromPattern } from "../learning/candidate.js";
import {
  assertEvalRepeats,
  buildProtocol,
  defaultEvalRunner,
  loadTaskSet,
  MIN_EVAL_REPEATS,
  renderEvalReport,
  runEvalAgainstBaseline,
  runEvalArm,
  runEvalComparison,
} from "../learning/eval.js";
import { applyPrune, planPrune } from "../storage/prune.js";
import { EvalBaselineRepo, SkillEvalRepo, skillEvalRowFromReport } from "../storage/repos/evals.js";
import { promoteCandidate } from "../skills/promote.js";
import { SkillIndex, toAssemblerEntries } from "../skills/retrieve.js";
import { verifyPromotedSkills } from "../skills/verify.js";
import { PatternRepo } from "../storage/repos/patterns.js";
import { SkillCandidateRepo } from "../storage/repos/candidates.js";
import { promotedSkillsDir, skillsDir } from "../runtime/paths.js";
import { DEMO_TOOLS } from "../runtime/tools/index.js";
import { parseArgs } from "./parse-args.js";

const HELP = `agent-harness — durable execution harness on top of Pi Agent Runtime

Usage:
  agent-harness [chat] [--model provider/model-id] [--tools demo|coding]
                    [--yolo] [--approval auto-approve|auto-deny|interactive]
                    [--capabilities fs:read,fs:write,...]
                                           interactive coding agent (REPL over
                                           one durable run; /help inside for
                                           slash commands)
  agent-harness run "<task>" [--model provider/model-id] [--tools demo|coding]
                    [--yolo] [--approval auto-approve|auto-deny|interactive]
                    [--capabilities fs:read,fs:write,...] [--fault point:tool]
  agent-harness resume [runId]           recover an interrupted run (default: latest)
                    [--yolo] — approval gates apply to recovered tool executions too
  agent-harness resume [runId] --chat    recover AND continue the same conversation
                    interactively (trace continues on the same run id)
  agent-harness memory core              show/create the always-resident Core Memory (key entries + evidence)
  agent-harness memory list [--all]      list active (or all incl. archived) memories (authoritative markdown)
  agent-harness memory search <query> [--limit <n>]   hybrid FTS5+vector with the documented degrade chain
  agent-harness memory rebuild [--vector]      reconcile/rebuild indexes from the .md files (--vector embeds)
  agent-harness memory status            index diagnostics: tokenizer, schema, backfill state, capacity
  agent-harness memory history <id>       list the version snapshots of one memory (restore = copy back)
  agent-harness memory distill <runId> [--force]   reflect a run into memory (gate skipped with --force)
  agent-harness skill mine [--min-support <n>]
                                           mine tool-sequence / error-repair patterns from finished runs
  agent-harness skill patterns             list mined patterns
  agent-harness skill draft <patternId> [--model <spec>]
                                           distill a draft SKILL.md from a pattern (hard rule: support>=3)
  agent-harness skill candidates           list skill candidates
  agent-harness skill show <candidateId>   print a candidate's SKILL.md
  agent-harness skill promote <candidateId> [--force]
                                           promote a candidate to .harness/skills/promoted/<name>/SKILL.md
                                           (--force over an existing skill shows the diff and requires
                                           confirmation: interactive y/N, or --yes in non-interactive shells)
  agent-harness skill list                 list promoted skills
  agent-harness skill retrieve "<task>"    preview which skills a run would inject
  agent-harness skill rebuild              rebuild the skill index from the promoted SKILL.md files
  agent-harness skill eval <taskset.json> --skill <name> [--model <spec>] [--repeats <n>] [--against-baseline]
                                           scripted A/B: no-skill baseline vs skill-injected (report persisted)
  agent-harness skill baseline <taskset.json> [--model <spec>] [--repeats <n>]
                                           record the no-skill regression baseline for a task set + model
                                           NOTE: a task set is operator-provided executable configuration —
                                           testCommand entries run through the shell, and eval arms execute
                                           tools unattended (auto-approve). Only load task sets you trust.
  agent-harness skill evals [limit]        list persisted eval reports (the iteration ledger)
  agent-harness skill verify               check the promoted root loads via pi loadSkillsFromDir
  agent-harness models [provider]          list providers, or a provider's models
  agent-harness prune [--keep-runs <n>] [--deep] [--dry-run]
                                           prune checkpoints of finished runs, and traces/evidence beyond
                                           the keep window (default 20 runs); --deep also drops the
                                           trace_events ledger rows for pruned runs and VACUUMs
  agent-harness trace list                 list recorded runs
  agent-harness trace show <runId> [--all] render a run's execution timeline
  agent-harness trace summary <runId> [--json]
                                            aggregate stats for a run
  agent-harness trace replay <runId> [--until <seq>]
                                           rebuild the run's state at any point + explain why
  agent-harness trace query <runId> [--tool <name>] [--errors]
                                           query a run's events in SQLite
  agent-harness help

Model providers: openai, anthropic, deepseek (built into pi-ai), qwen
(DashScope compatible-mode) and openrouter (OpenAI-compatible; ids keep their
slash, e.g. openrouter/qwen/qwen3.8-27b:free).
API keys are read from the environment:
  OPENAI_API_KEY  ANTHROPIC_API_KEY  DEEPSEEK_API_KEY  DASHSCOPE_API_KEY|QWEN_API_KEY  OPENROUTER_API_KEY
Default model comes from HARNESS_MODEL. Traces land in .harness/traces/<runId>.jsonl.
Approval: the CLI defaults to INTERACTIVE approval (non-interactive shells
auto-deny mutating tools); --yolo opts in to full autonomy explicitly.`;

/** Load a run's events from SQLite — works for finished AND interrupted runs. */
function loadRunEvents(id: string): TraceEvent[] {
  const db = openDatabase(defaultDbPath());
  try {
    const events = new TraceEventRepo(db).getByRun(id);
    if (events.length === 0) throw new HarnessError(`run "${id}" not found in ${defaultDbPath()}`);
    return events;
  } finally {
    db.close();
  }
}

/** Line-level diff summary (removed then added) for the --force confirmation. */
function simpleDiff(oldText: string, newText: string): string[] {
  const oldLines = new Set(oldText.split("\n"));
  const newLines = new Set(newText.split("\n"));
  return [
    ...oldText
      .split("\n")
      .filter((l) => !newLines.has(l))
      .map((l) => `- ${l}`),
    ...newText
      .split("\n")
      .filter((l) => !oldLines.has(l))
      .map((l) => `+ ${l}`),
  ];
}

/** Parse `--repeats` at the CLI boundary. An unparseable value (`--repeats abc`)
 *  used to flow through as NaN and surface as a confusing "got NaN" error
 *  deep inside eval.ts; reject it here instead, before any eval work starts.
 *  Returns undefined when the flag is absent (callers apply their default). */
function parseRepeatsFlag(value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    console.error(`invalid --repeats value: ${String(value)} (expected a positive integer)`);
    return undefined;
  }
  return Number(raw);
}

/** Parse `--keep-runs` at the CLI boundary. An unparseable value used to flow
 * into planPrune as NaN where Math.max(1, NaN) = NaN and slice(NaN) kept
 * NOTHING — a typo like `--keep-runs abc` deleted the traces of ALL finished
 * runs. Same contract as parseRepeatsFlag: undefined = flag absent. */
function parseKeepRunsFlag(value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    console.error(`invalid --keep-runs value: ${String(value)} (expected a positive integer)`);
    return undefined;
  }
  return Number(raw);
}

/**
 * Interactive mode (chat): pi-tui REPL over one durable run per conversation.
 * Same flags as `run` (--model/--tools/--yolo/--approval/--capabilities). The
 * exit epilogue mirrors run(): reflect the run into memory, drain the
 * embedding backfill, close the database.
 */
async function runChat(
  flags: Record<string, string | boolean>,
  capabilities: readonly Capability[] | undefined,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('interactive mode requires a TTY — use: agent-harness run "<task>"');
    return 2;
  }
  const flagModel = typeof flags.model === "string" ? flags.model : undefined;
  const spec = flagModel ?? defaultModelSpec();
  if (!spec) {
    console.error("no model selected: pass --model provider/model-id or set HARNESS_MODEL (see: agent-harness models)");
    return 2;
  }
  const model = resolveModel(spec);
  const toolsFlag = typeof flags.tools === "string" ? flags.tools : undefined;
  if (toolsFlag !== undefined && toolsFlag !== "demo" && toolsFlag !== "coding") {
    console.error(`unknown --tools "${toolsFlag}" (expected demo | coding)`);
    return 2;
  }
  const chatApprovalMode: ApprovalMode =
    flags.yolo === true
      ? "auto-approve"
      : ((typeof flags.approval === "string" ? (flags.approval as ApprovalMode) : undefined) ?? "interactive");

  const manager = new RunManager();
  let summary: ChatExitSummary;
  try {
    const app = new ChatApp({
      manager,
      model,
      tools: toolsFlag as ToolsetSpec | undefined,
      approvalMode: chatApprovalMode,
      capabilities,
    });
    summary = await app.run();
  } catch (err) {
    manager.close();
    throw err;
  }

  console.log("");
  if (summary.runId) {
    console.log(`run ${summary.runId}`);
    console.log(`status: ${summary.status ?? "unknown"} (${summary.cycles} cycle(s))`);
    if (summary.error) console.error(`error: ${summary.error}`);
  }
  if (summary.runId && flags["no-distill"] !== true) {
    try {
      const outcome = await reflectRunById(summary.runId);
      if (outcome.action === "created" || outcome.action === "updated") {
        console.log(
          `memory: ${outcome.action} ${outcome.record.id} (rev ${outcome.record.revision}) — ${outcome.reason}`,
        );
      } else {
        console.log(`memory: ${outcome.action} — ${outcome.reason}`);
      }
    } catch (err) {
      console.error(`memory: reflection failed (${err instanceof Error ? err.message : err})`);
    }
    if (await manager.drainMemoryBackfill()) {
      console.log("memory: embedding backfill complete (vector recall now effective)");
    }
  }
  manager.close();
  return summary.status === "completed" || summary.status === undefined ? 0 : 1;
}

/**
 * `resume [runId] --chat`: recover an interrupted run and continue the SAME
 * conversation in the interactive TUI (trace seq continues on the run). The
 * model/toolset come from the run row unless overridden by flags.
 */
async function resumeIntoChat(
  flags: Record<string, string | boolean>,
  capabilities: readonly Capability[] | undefined,
  targetId: string | undefined,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("interactive resume requires a TTY — use: agent-harness resume [runId]");
    return 2;
  }
  const toolsFlag = typeof flags.tools === "string" ? flags.tools : undefined;
  if (toolsFlag !== undefined && toolsFlag !== "demo" && toolsFlag !== "coding") {
    console.error(`unknown --tools "${toolsFlag}" (expected demo | coding)`);
    return 2;
  }
  const chatApprovalMode: ApprovalMode =
    flags.yolo === true
      ? "auto-approve"
      : ((typeof flags.approval === "string" ? (flags.approval as ApprovalMode) : undefined) ?? "interactive");

  const manager = new RunManager();
  const runId = targetId ?? manager.listInterrupted().at(-1)?.id;
  if (!runId) {
    console.log("(no interrupted runs to resume)");
    manager.close();
    return 0;
  }
  let summary: ChatExitSummary;
  try {
    // The run row carries the crashed run's model + toolset (migration 012).
    let modelSpec: string | undefined;
    let toolset: ToolsetSpec | undefined;
    {
      const db = openDatabase(defaultDbPath());
      try {
        const row = new RunRepo(db).get(runId);
        if (row) {
          modelSpec = row.modelSpec;
          toolset = row.toolset;
        }
      } finally {
        db.close();
      }
    }
    const spec = modelSpec ?? (typeof flags.model === "string" ? flags.model : defaultModelSpec());
    if (!spec) {
      console.error(
        "no model selected: pass --model provider/model-id or set HARNESS_MODEL (see: agent-harness models)",
      );
      manager.close();
      return 2;
    }
    const model = resolveModel(spec);
    const app = new ChatApp({
      manager,
      model,
      tools: (toolsFlag as ToolsetSpec | undefined) ?? toolset,
      approvalMode: chatApprovalMode,
      capabilities,
      resumeRunId: runId,
    });
    summary = await app.run();
  } catch (err) {
    manager.close();
    throw err;
  }

  console.log("");
  if (summary.runId) {
    console.log(`run ${summary.runId}`);
    console.log(`status: ${summary.status ?? "unknown"} (${summary.cycles} cycle(s))`);
    if (summary.error) console.error(`error: ${summary.error}`);
  }
  if (summary.runId && flags["no-distill"] !== true) {
    try {
      const outcome = await reflectRunById(summary.runId);
      if (outcome.action === "created" || outcome.action === "updated") {
        console.log(
          `memory: ${outcome.action} ${outcome.record.id} (rev ${outcome.record.revision}) — ${outcome.reason}`,
        );
      } else {
        console.log(`memory: ${outcome.action} — ${outcome.reason}`);
      }
    } catch (err) {
      console.error(`memory: reflection failed (${err instanceof Error ? err.message : err})`);
    }
    if (await manager.drainMemoryBackfill()) {
      console.log("memory: embedding backfill complete (vector recall now effective)");
    }
  }
  manager.close();
  return summary.status === "completed" || summary.status === undefined ? 0 : 1;
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  // Shared flag parsing (run and resume both gate on these).
  const approvalFlag = typeof flags.approval === "string" ? flags.approval : undefined;
  if (
    approvalFlag !== undefined &&
    approvalFlag !== "auto-approve" &&
    approvalFlag !== "auto-deny" &&
    approvalFlag !== "interactive"
  ) {
    console.error(`unknown --approval mode "${approvalFlag}" (expected auto-approve | auto-deny | interactive)`);
    return 2;
  }
  const capabilitiesFlag = typeof flags.capabilities === "string" ? flags.capabilities : undefined;
  let capabilities: readonly Capability[] | undefined;
  if (capabilitiesFlag) {
    const requested = capabilitiesFlag
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean) as readonly Capability[];
    const invalid = requested.filter((c) => !ALL_CAPABILITIES.includes(c as never));
    if (invalid.length > 0) {
      console.error(`unknown capabilities: ${invalid.join(", ")} (available: ${ALL_CAPABILITIES.join(", ")})`);
      return 2;
    }
    capabilities = requested;
  }

  if (command === "chat" || (process.argv.length <= 2 && process.stdin.isTTY)) {
    return runChat(flags, capabilities);
  }

  if (command === "models") {
    const provider = positional[0];
    if (!provider) {
      console.log(listProviderIds().join("\n"));
      return 0;
    }
    const models = getModelRegistry()
      .getModels(provider)
      .map((m) => `${provider}/${m.id}`);
    console.log(models.length ? models.join("\n") : `(no models registered for "${provider}")`);
    return 0;
  }

  if (command === "memory") {
    const sub = positional[0];
    const dbPath = defaultDbPath();
    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    if (sub === "core") {
      const existing = store.readCoreFile();
      if (existing === undefined) {
        store.ensureCore();
        console.log(`created ${store.corePath} — entries upsert via core_memory_update; edit the file freely.`);
      } else {
        console.log(`core memory file: ${store.corePath}`);
        console.log(`entries (${existing.entries.length}):`);
        for (const e of existing.entries) {
          console.log(`  - ${e.key}: ${e.content}`);
          console.log(`      reason: ${e.reason}`);
          console.log(`      source: ${e.sourceStatement}`);
        }
        const injected = store.readCore();
        if (injected) console.log(`\n--- injected into every run (within the 2000-token budget) ---\n${injected}`);
      }
      return 0;
    }
    if (sub === "list") {
      const status = flags.all === true ? undefined : "active";
      const records = status ? store.list(status) : [...store.list("active"), ...store.list("archive")];
      if (records.length === 0) {
        console.log("(no memory yet — runs are reflected automatically unless --no-distill)");
        return 0;
      }
      for (const m of records) {
        console.log(`${m.id} [${m.status}] rev ${m.revision} reads=${m.accessCount} — ${m.title}`);
        console.log(`    ${m.summary}`);
        console.log(`    ${path.relative(process.cwd(), store.pathOf(m.id, m.status))}`);
      }
      return 0;
    }
    if (sub === "search") {
      const query = positional.slice(1).join(" ").trim();
      if (!query) {
        console.error("usage: agent-harness memory search <query> [--limit <n>]");
        return 2;
      }
      const db = openDatabase(dbPath);
      try {
        const index = new MemorySearchIndex(db);
        const limit = typeof flags.limit === "string" ? Number(flags.limit) : 5;
        const capped = Number.isFinite(limit) && limit > 0 ? limit : 5;
        // HYBRID with the documented degrade chain — mode/degrade_reason are
        // part of the result, not a CLI flag.
        const hits = await index.search(store, query, {
          limit: capped,
          embedder: localEmbedder(),
          embeddingModel: EMBEDDING_MODEL_ID,
        });
        if (hits.length === 0) {
          console.log("(no matching memory — try `memory rebuild` if you edited the .md files)");
          return 0;
        }
        console.log(`(mode: ${hits[0]?.mode}${hits[0]?.degradeReason ? ` — ${hits[0].degradeReason}` : ""})`);
        hits.forEach((h, i) => {
          console.log(
            `#${i + 1} ${h.record.id} (rev ${h.record.revision}) ${h.record.title} [score ${h.score.toFixed(5)} ×${h.boost.toFixed(2)}]`,
          );
          console.log(`    ${h.record.summary}`);
          console.log(`    ${h.snippet.replace(/\n/g, " ").slice(0, 200)}`);
          console.log(
            `    file: ${path.relative(process.cwd(), store.pathOf(h.record.id, h.record.status))} (run ${h.record.sourceRunId ?? "?"})`,
          );
        });
      } finally {
        db.close();
      }
      return 0;
    }
    if (sub === "rebuild") {
      const db = openDatabase(dbPath);
      try {
        const index = new MemorySearchIndex(db);
        const n = index.rebuild(store);
        store.rebuildIndex();
        let vectors = 0;
        if (flags.vector === true) {
          // Synchronous embed on the CLI path; startup uses the background backfill.
          const embedder = localEmbedder();
          const live = store.list("active");
          for (const record of live) await index.embedRecord(record, embedder, EMBEDDING_MODEL_ID);
          vectors = index.vectorCount();
        }
        console.log(
          `index rebuilt from ${n} memory file(s)${flags.vector === true ? `, ${vectors} vector(s) embedded` : ""}`,
        );
      } finally {
        db.close();
      }
      return 0;
    }
    if (sub === "history") {
      const id = positional[1];
      if (!id) {
        console.error("usage: agent-harness memory history <id>");
        return 2;
      }
      const versions = store.history(id);
      if (versions.length === 0) {
        console.log(`(no history for ${id} — snapshots start at the first update/archive)`);
        return 0;
      }
      for (const v of versions) {
        console.log(`rev ${v.revision} (${v.updated}) — ${v.title}`);
        console.log(`    ${v.summary}`);
        console.log(`    ${path.relative(process.cwd(), store.historyPath(id, v.revision))}`);
      }
      console.log(`\nrestore = copy the file back to active/ (no restore command by design).`);
      return 0;
    }
    if (sub === "status") {
      const db = openDatabase(dbPath);
      try {
        const index = new MemorySearchIndex(db);
        const diag = index.diagnostics(EMBEDDING_MODEL_ID);
        console.log(`memory dir: ${store.dir}`);
        console.log(
          `active: ${store.activeCount()} (cap ${MAX_ACTIVE_MEMORIES}) | archive: ${store.list("archive").length}`,
        );
        for (const [key, value] of Object.entries(diag)) {
          if (value !== "") console.log(`${key}: ${value}`);
        }
      } finally {
        db.close();
      }
      return 0;
    }
    if (sub === "distill") {
      const id = positional[1];
      if (!id) {
        console.error("usage: agent-harness memory distill <runId> [--force]");
        return 2;
      }
      const outcome = await reflectRunById(id, { force: flags.force === true });
      if (outcome.action === "created" || outcome.action === "updated") {
        console.log(
          `memory: ${outcome.action} ${outcome.record.id} (rev ${outcome.record.revision}) — ${outcome.reason}`,
        );
        console.log(`    ${outcome.file}`);
      } else {
        console.log(`memory: ${outcome.action} — ${outcome.reason}`);
      }
      return 0;
    }
    console.error(
      "usage: agent-harness memory core | memory list [--all] | memory search <query> | memory history <id> | memory rebuild [--vector] | memory status | memory distill <runId> [--force]",
    );
    return 2;
  }

  if (command === "skill") {
    const sub = positional[0];
    const dbPath = defaultDbPath();

    if (sub === "mine") {
      const db = openDatabase(dbPath);
      try {
        const minSupport = typeof flags["min-support"] === "string" ? Number(flags["min-support"]) : undefined;
        if (minSupport !== undefined && (!Number.isFinite(minSupport) || minSupport < 3)) {
          console.error("--min-support is floored at 3: single-run patterns are not minable");
          return 2;
        }
        const drafts = minePatternsFromDb(db, {
          ...(minSupport !== undefined ? { minSupport } : {}),
          // 阶段 12 pattern-aware idempotency: classify patterns by the tools'
          // replay markers (send_notification is "never").
          toolReplay: Object.fromEntries(DEMO_TOOLS.map((t) => [t.name, String(t.replay ?? "safe")])),
        });
        const count = new PatternRepo(db).replaceAll(drafts);
        console.log(`mined ${count} pattern(s) with support >= ${minSupport ?? 3} from finished runs`);
        for (const p of new PatternRepo(db).list()) {
          console.log(
            `[${p.kind}] ${p.signature} — support ${p.support}, replay ${p.replaySafety} (${p.traceRefs.length} trace(s)) id=${p.id}`,
          );
        }
        if (count === 0) console.log("(no pattern cleared the threshold — run a few similar tasks first)");
      } finally {
        db.close();
      }
      return 0;
    }

    if (sub === "patterns") {
      const db = openDatabase(dbPath);
      try {
        const patterns = new PatternRepo(db).list();
        if (patterns.length === 0) {
          console.log("(no patterns — run `skill mine`)");
          return 0;
        }
        for (const p of patterns) {
          console.log(`[${p.kind}] ${p.signature} — support ${p.support} id=${p.id}`);
          console.log(`    runs: ${p.traceRefs.join(", ")}`);
        }
      } finally {
        db.close();
      }
      return 0;
    }

    if (sub === "draft") {
      const patternId = positional[1];
      if (!patternId) {
        console.error("usage: agent-harness skill draft <patternId> [--model <spec>]");
        return 2;
      }
      const outcome = await draftSkillFromPattern(patternId, {
        modelSpec: typeof flags.model === "string" ? flags.model : undefined,
        skillsRoot: skillsDir(),
      });
      console.log(
        `candidate ${outcome.candidate.id} (${outcome.method === "llm" ? "LLM distillation" : "mechanical fallback"}) — support ${outcome.candidate.provenance.support}, pattern ${outcome.candidate.provenance.patternSignature}`,
      );
      console.log(`    ${outcome.file}`);
      return 0;
    }

    if (sub === "candidates") {
      const db = openDatabase(dbPath);
      try {
        const candidates = new SkillCandidateRepo(db).list();
        if (candidates.length === 0) {
          console.log("(no candidates — run `skill draft <patternId>`)");
          return 0;
        }
        for (const c of candidates) {
          console.log(`[${c.status}] ${c.name} — ${c.description.slice(0, 90)}`);
          console.log(`    id=${c.id} pattern=${c.provenance.patternSignature} support=${c.provenance.support}`);
          console.log(`    ${path.relative(process.cwd(), c.skillMdPath)}`);
        }
      } finally {
        db.close();
      }
      return 0;
    }

    if (sub === "show") {
      const id = positional[1];
      if (!id) {
        console.error("usage: agent-harness skill show <candidateId>");
        return 2;
      }
      const db = openDatabase(dbPath);
      let candidate;
      try {
        candidate = new SkillCandidateRepo(db).get(id);
      } finally {
        db.close();
      }
      if (!candidate) {
        console.error(`candidate "${id}" not found`);
        return 1;
      }
      console.log(fs.readFileSync(candidate.skillMdPath, "utf8"));
      return 0;
    }

    if (sub === "promote") {
      const id = positional[1];
      if (!id) {
        console.error("usage: agent-harness skill promote <candidateId> [--force]");
        return 2;
      }
      // 加固期 (P1) poisoning defense: --force overwrites an existing skill —
      // show the caller the actual diff and require explicit confirmation
      // (TTY: interactive y/N; non-TTY: an explicit --yes flag).
      let confirm: (() => boolean) | undefined;
      if (flags.force === true) {
        let draft: ReturnType<SkillCandidateRepo["get"]>;
        {
          const db = openDatabase(dbPath);
          try {
            draft = new SkillCandidateRepo(db).get(id);
          } finally {
            db.close();
          }
        }
        const existingPath = draft ? path.join(promotedSkillsDir(), draft.name, "SKILL.md") : undefined;
        const existingRaw =
          draft && existingPath && fs.existsSync(existingPath) ? fs.readFileSync(existingPath, "utf8") : undefined;
        const draftRaw =
          draft && fs.existsSync(draft.skillMdPath) ? fs.readFileSync(draft.skillMdPath, "utf8") : undefined;
        if (existingRaw !== undefined && draftRaw !== undefined && existingRaw !== draftRaw) {
          console.log("[promote --force] overwriting the existing promoted SKILL.md. Diff (old → new):");
          for (const line of simpleDiff(existingRaw, draftRaw).slice(0, 60)) console.log(`  ${line}`);
        }
        if (process.stdin.isTTY) {
          const readline = await import("node:readline/promises");
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          try {
            const answer = await rl.question("[promote --force] overwrite the promoted skill? type yes: ");
            if (!/^y(es)?$/i.test(answer.trim())) {
              console.error("cancelled");
              return 1;
            }
          } finally {
            rl.close();
          }
        } else if (flags.yes !== true) {
          console.error(
            "[promote --force] non-interactive shell — pass --yes to confirm the overwrite (the diff above is what changes)",
          );
          return 2;
        }
        confirm = () => true; // already confirmed above; the library hook stays satisfied
      }
      const outcome = promoteCandidate(id, { skillsRoot: skillsDir(), force: flags.force === true, confirm });
      console.log(
        outcome.overwritten
          ? `promoted "${outcome.skill.name}" v${outcome.skill.version} (overwrote previous version)`
          : `promoted "${outcome.skill.name}" v${outcome.skill.version}`,
      );
      console.log(`    ${outcome.skillMdPath}`);
      console.log("    future runs matching this skill will see it in <available_skills>");
      return 0;
    }

    if (sub === "list") {
      const db = openDatabase(dbPath);
      let skills;
      try {
        skills = new SkillIndex(db).list();
      } finally {
        db.close();
      }
      if (skills.length === 0) {
        console.log("(no promoted skills — `skill draft` + `skill promote` creates them)");
        return 0;
      }
      for (const s of skills) {
        console.log(`[v${s.version}] ${s.name} — ${s.description.slice(0, 100)}`);
        console.log(`    ${path.relative(process.cwd(), path.join(s.dirPath, "SKILL.md"))}`);
      }
      return 0;
    }

    if (sub === "retrieve") {
      const query = positional.slice(1).join(" ").trim();
      if (!query) {
        console.error('usage: agent-harness skill retrieve "<task>"');
        return 2;
      }
      const db = openDatabase(dbPath);
      try {
        const hits = new SkillIndex(db).search(query, 2);
        if (hits.length === 0) {
          console.log("(no matching skill would be injected)");
          return 0;
        }
        console.log("would inject into <available_skills>:");
        for (const e of toAssemblerEntries(hits, process.cwd())) {
          console.log(`  ${e.name} — ${e.description.slice(0, 90)}`);
          console.log(`      ${e.location}`);
        }
      } finally {
        db.close();
      }
      return 0;
    }

    if (sub === "rebuild") {
      const db = openDatabase(dbPath);
      try {
        const n = new SkillIndex(db).rebuild(promotedSkillsDir());
        console.log(`skill index rebuilt from ${n} promoted skill file(s)`);
      } finally {
        db.close();
      }
      return 0;
    }

    if (sub === "eval") {
      const file = positional[1];
      const skillName = typeof flags.skill === "string" ? flags.skill : undefined;
      if (!file || !skillName) {
        console.error(
          "usage: agent-harness skill eval <taskset.json> --skill <name> [--model <spec>] [--repeats <n>] [--against-baseline]",
        );
        return 2;
      }
      const db = openDatabase(dbPath);
      let registered;
      try {
        registered = new SkillIndex(db).getByName([skillName])[0];
      } finally {
        db.close();
      }
      if (!registered) {
        console.error(`no promoted skill named "${skillName}" (see: agent-harness skill list)`);
        return 1;
      }
      const taskSet = loadTaskSet(file);
      const spec = typeof flags.model === "string" ? flags.model : defaultModelSpec();
      if (!spec) {
        console.error("no model selected: pass --model provider/model-id or set HARNESS_MODEL");
        return 2;
      }
      if (flags.repeats !== undefined && parseRepeatsFlag(flags.repeats) === undefined) return 2;
      const repeats = assertEvalRepeats(parseRepeatsFlag(flags.repeats) ?? MIN_EVAL_REPEATS);
      const toolsFlag = typeof flags.tools === "string" ? flags.tools : undefined;
      if (toolsFlag !== undefined && toolsFlag !== "demo" && toolsFlag !== "coding") {
        console.error(`unknown --tools "${toolsFlag}" (expected demo | coding)`);
        return 2;
      }
      const runner = defaultEvalRunner(spec, { toolset: toolsFlag as "demo" | "coding" | undefined });
      const artifactsDir = path.join(
        harnessDataDir(process.cwd()),
        "evals",
        taskSet.name,
        `run-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      );
      const currentSha = buildProtocol(taskSet, { model: spec, toolset: toolsFlag, repeats }).sha256;
      let report;
      if (flags["against-baseline"] === true) {
        const db2 = openDatabase(dbPath);
        let stored;
        try {
          stored = new EvalBaselineRepo(db2).latest(taskSet.name, spec, toolsFlag);
        } finally {
          db2.close();
        }
        if (!stored) {
          console.error(
            `no recorded baseline for "${taskSet.name}" + ${spec} (tools: ${toolsFlag ?? "demo"}) — run: agent-harness skill baseline ${file} --model ${spec}${toolsFlag ? ` --tools ${toolsFlag}` : ""}`,
          );
          return 1;
        }
        if (stored.protocolSha256 && stored.protocolSha256 !== currentSha) {
          console.warn(
            `⚠ protocol sha mismatch: stored baseline ${stored.protocolSha256.slice(0, 12)} vs current ${currentSha.slice(0, 12)} — the comparison spans different protocols`,
          );
        }
        if (stored.repeats !== repeats) {
          console.warn(`warning: stored baseline used repeats=${stored.repeats}, this run repeats=${repeats}`);
        }
        console.log(
          `running ${taskSet.tasks.length} task(s) × ${repeats} repeat(s) — treatment arm only, against the stored baseline (${stored.recordedAt})…`,
        );
        report = await runEvalAgainstBaseline(taskSet, {
          runner,
          skillName,
          skillVersion: registered.version,
          toolset: toolsFlag,
          modelSpec: spec,
          artifactsDir,
          repeats,
          stored: { arm: stored.arm, repeats: stored.repeats },
        });
      } else {
        console.log(
          `running ${taskSet.tasks.length} task(s) × ${repeats} repeat(s) × 2 arms (baseline / +skill "${skillName}")…`,
        );
        report = await runEvalComparison(taskSet, {
          runner,
          skillName,
          skillVersion: registered.version,
          toolset: toolsFlag,
          modelSpec: spec,
          artifactsDir,
          repeats,
        });
      }
      // 阶段 11: every report enters the ledger for cross-iteration comparison.
      const db3 = openDatabase(dbPath);
      try {
        new SkillEvalRepo(db3).insert(skillEvalRowFromReport(report, registered.sourceCandidateId));
      } finally {
        db3.close();
      }
      console.log(renderEvalReport(report));
      console.log("report persisted (see: agent-harness skill evals)");
      return 0;
    }

    if (sub === "baseline") {
      const file = positional[1];
      if (!file) {
        console.error("usage: agent-harness skill baseline <taskset.json> [--model <spec>] [--repeats <n>]");
        return 2;
      }
      const spec = typeof flags.model === "string" ? flags.model : defaultModelSpec();
      if (!spec) {
        console.error("no model selected: pass --model provider/model-id or set HARNESS_MODEL");
        return 2;
      }
      if (flags.repeats !== undefined && parseRepeatsFlag(flags.repeats) === undefined) return 2;
      const repeats = assertEvalRepeats(parseRepeatsFlag(flags.repeats) ?? MIN_EVAL_REPEATS);
      const toolsFlag = typeof flags.tools === "string" ? flags.tools : undefined;
      if (toolsFlag !== undefined && toolsFlag !== "demo" && toolsFlag !== "coding") {
        console.error(`unknown --tools "${toolsFlag}" (expected demo | coding)`);
        return 2;
      }
      const taskSet = loadTaskSet(file);
      const runner = defaultEvalRunner(spec, { toolset: toolsFlag as "demo" | "coding" | undefined });
      const protocolSha = buildProtocol(taskSet, { model: spec, toolset: toolsFlag, repeats }).sha256;
      console.log(
        `recording no-skill baseline: ${taskSet.tasks.length} task(s) × ${repeats} repeat(s) with ${spec} (tools: ${toolsFlag ?? "demo"}, protocol ${protocolSha.slice(0, 12)})…`,
      );
      const arm = await runEvalArm(taskSet, runner, false, { repeats });
      const db = openDatabase(dbPath);
      let recorded;
      try {
        recorded = new EvalBaselineRepo(db).record({
          evalSet: taskSet.name,
          modelSpec: spec,
          toolset: toolsFlag,
          protocolSha256: protocolSha,
          repeats,
          arm,
        });
      } finally {
        db.close();
      }
      const runs = arm.results.length;
      console.log(
        `baseline ${recorded.id} recorded: ${arm.results.filter((r) => r.pass).length}/${runs} pass (${Math.round(arm.passRate * 100)}%), verify-read-back ${arm.verifiedRuns}/${runs}, ~${runs ? Math.round(arm.totalTokens / runs) : 0} tok/run`,
      );
      // Surface why runs failed — an all-infra baseline (0 tokens, instant
      // deaths) should be self-explaining, not a mystery for the operator.
      const failures = arm.results.filter((r) => !r.pass);
      if (failures.length > 0) {
        console.warn(
          `⚠ ${failures.length}/${runs} run(s) failed (infra: ${arm.infraFailures}) — first reason: ${failures[0]?.reason}`,
        );
        if (arm.infraFailures === failures.length && failures.length === runs) {
          console.warn(
            "  every run died to infrastructure — check the API key env var for this shell before trusting this baseline",
          );
        }
      }
      console.log(`later evals can compare against it: skill eval <taskset.json> --skill <name> --against-baseline`);
      return 0;
    }

    if (sub === "evals") {
      const limit = typeof flags.limit === "string" ? Number(flags.limit) : 10;
      const db = openDatabase(dbPath);
      let rows;
      try {
        rows = new SkillEvalRepo(db).list(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10);
      } finally {
        db.close();
      }
      if (rows.length === 0) {
        console.log("(no persisted eval reports yet — `skill eval` / `skill baseline` records them)");
        return 0;
      }
      for (const r of rows) {
        const pct = (v: number) => `${Math.round(v * 100)}%`;
        const verdict = r.report.valid === false ? `${r.verdict} (INVALID)` : r.verdict;
        console.log(
          `${r.decidedAt.slice(0, 19)} ${verdict.padEnd(23)} ${r.skillName}${r.skillVersion ? `@v${r.skillVersion}` : ""} @ ${r.evalSet} (×${r.repeats}) — baseline ${pct(r.baselinePass)} vs skill ${pct(r.candidatePass)}`,
        );
        console.log(
          `    tokens: baseline ~${r.cost.baseline.avgTokens}/run vs skill ~${r.cost.treatment.avgTokens}/run; duration: ~${r.cost.baseline.avgDurationMs}ms vs ~${r.cost.treatment.avgDurationMs}ms`,
        );
      }
      return 0;
    }

    if (sub === "verify") {
      const verification = verifyPromotedSkills(promotedSkillsDir());
      if (verification.skills.length === 0 && verification.diagnostics.length === 0) {
        console.log("(no promoted skills to verify)");
        return 0;
      }
      for (const s of verification.skills) console.log(`loaded by pi loadSkillsFromDir: ${s.name} (${s.filePath})`);
      for (const d of verification.diagnostics)
        console.error(`diagnostic [${d.type}] ${d.message}${d.path ? ` (${d.path})` : ""}`);
      console.log(verification.ok ? "verification OK" : "verification FAILED");
      return verification.ok ? 0 : 1;
    }

    console.error(
      'usage: agent-harness skill mine | patterns | draft <patternId> | candidates | show <id> | promote <id> | list | retrieve "<task>" | rebuild | verify | eval <taskset.json> --skill <name> | baseline <taskset.json> | evals',
    );
    return 2;
  }

  if (command === "trace") {
    const sub = positional[0];
    if (sub === "list") {
      const traces = listTraces(tracesDir());
      if (traces.length === 0) {
        console.log("(no traces yet — run a task first)");
        return 0;
      }
      for (const t of traces) console.log(`${t.runId}  ${new Date(t.mtimeMs).toISOString()}`);
      return 0;
    }
    if (sub === "show") {
      const id = positional[1];
      if (!id) {
        console.error("usage: agent-harness trace show <runId> [--all]");
        return 2;
      }
      const events = loadRunEvents(id);
      console.log(renderTimeline({ runId: events[0]!.runId, events }, { all: flags.all === true }));
      if (events.at(-1)?.type !== "run_end") {
        console.log("\n(trace incomplete: no run_end — interrupted run, `resume` can recover it)");
      }
      return 0;
    }
    if (sub === "summary") {
      const id = positional[1];
      if (!id) {
        console.error("usage: agent-harness trace summary <runId>");
        return 2;
      }
      const summary = summarize(loadRunEvents(id));
      console.log(flags.json === true ? JSON.stringify(summary, null, 2) : renderSummary(summary));
      return 0;
    }
    if (sub === "replay") {
      const id = positional[1];
      if (!id) {
        console.error("usage: agent-harness trace replay <runId> [--until <seq>]");
        return 2;
      }
      const untilFlag = typeof flags.until === "string" ? Number(flags.until) : undefined;
      if (untilFlag !== undefined && (!Number.isFinite(untilFlag) || untilFlag < 1)) {
        console.error(`invalid --until "${flags.until}"`);
        return 2;
      }
      const { state, why } = explain(loadRunEvents(id), untilFlag);
      console.log(renderReplay(state, why));
      return 0;
    }
    if (sub === "query") {
      const id = positional[1];
      if (!id) {
        console.error("usage: agent-harness trace query <runId> [--tool <name>] [--errors]");
        return 2;
      }
      const db = openDatabase(defaultDbPath());
      try {
        const run = new RunRepo(db).get(id);
        if (!run) {
          console.error(`unknown run: ${id}`);
          return 1;
        }
        const repo = new TraceEventRepo(db);
        const tool = typeof flags.tool === "string" ? flags.tool : undefined;
        const events = tool ? repo.queryToolCalls(tool, id) : flags.errors ? repo.queryErrors(id) : repo.getByRun(id);
        if (events.length === 0) console.log(`no matching events for run ${id}`);
        for (const e of events) {
          const toolName = "toolName" in e && typeof e.toolName === "string" ? ` ${e.toolName}` : "";
          console.log(`#${e.seq} ${e.ts.slice(11, 23)} ${e.type}${toolName}`);
        }
      } finally {
        db.close();
      }
      return 0;
    }
    console.error(
      "usage: agent-harness trace list | trace show <runId> [--all] | trace summary <runId> | trace replay <runId> [--until <seq>] | trace query <runId> [--tool <name>] [--errors]",
    );
    return 2;
  }

  if (command === "resume" && flags.chat === true) {
    return resumeIntoChat(flags, capabilities, positional[0]);
  }

  if (command === "resume") {
    const manager = new RunManager();
    let targetId = positional[0];
    if (!targetId) {
      const running = manager.listInterrupted();
      targetId = running.at(-1)?.id;
    }
    if (!targetId) {
      console.log("(no interrupted runs to resume)");
      manager.close();
      return 0;
    }
    const startedAt = Date.now();
    const toolsFlag = typeof flags.tools === "string" ? flags.tools : undefined;
    if (toolsFlag !== undefined && toolsFlag !== "demo" && toolsFlag !== "coding") {
      console.error(`unknown --tools "${toolsFlag}" (expected demo | coding)`);
      return 2;
    }
    const resumeApprovalMode: ApprovalMode =
      flags.yolo === true
        ? "auto-approve"
        : ((typeof flags.approval === "string" ? (flags.approval as ApprovalMode) : undefined) ?? "interactive");
    if (resumeApprovalMode === "interactive" && !process.stdin.isTTY) {
      // Same warning as run() — a scripted resume would otherwise auto-deny
      // every mutating tool with no visible explanation.
      console.warn(
        "[approval] interactive mode in a non-interactive shell: mutating tools will be auto-denied (use --yolo to override)",
      );
    }
    const result = await manager.resume(targetId, {
      reporter: new ConsoleReporter(),
      // 阶段 13: recovered tool executions go through the same approval gate AND
      // the same toolset — the toolset persisted on the run row (migration 012)
      // is restored automatically; --tools overrides it.
      tools: toolsFlag as ToolsetSpec | undefined,
      approval: {
        mode: resumeApprovalMode,
        capabilities: capabilities as readonly Capability[] | undefined,
      },
    });
    const record = result.record;
    console.log("");
    console.log(`resumed run ${record.id}`);
    console.log(`status: ${record.status}`);
    if (record.finishedAt) console.log(`duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    if (result.usage) {
      const u = result.usage;
      console.log(`tokens: in=${u.input} out=${u.output} total=${u.totalTokens} cost=$${u.cost.total.toFixed(4)}`);
    }
    if (result.tracePath) console.log(`trace: ${result.tracePath}`);
    if (record.error) console.error(`error: ${record.error}`);
    if (flags["no-distill"] !== true) {
      try {
        const outcome = await reflectRunById(record.id);
        if (outcome.action === "created" || outcome.action === "updated") {
          console.log(
            `memory: ${outcome.action} ${outcome.record.id} (rev ${outcome.record.revision}) — ${outcome.reason}`,
          );
        } else {
          console.log(`memory: ${outcome.action} — ${outcome.reason}`);
        }
      } catch (err) {
        console.error(`memory: reflection failed (${err instanceof Error ? err.message : err})`);
      }
    }
    // Run 结束 + reflect 之后的向量补全：CLI 短生命周期，退出前 drain 完成。
    if (await manager.drainMemoryBackfill()) {
      console.log("memory: embedding backfill complete (vector recall now effective)");
    }
    manager.close();
    return record.status === "completed" ? 0 : 1;
  }

  if (command === "prune") {
    // 加固期 (P2) retention: checkpoints of finished runs are dead weight;
    // traces/evidence are kept for the newest keep-runs finished runs.
    if (flags["keep-runs"] !== undefined && parseKeepRunsFlag(flags["keep-runs"]) === undefined) return 2;
    const keepFlag = parseKeepRunsFlag(flags["keep-runs"]);
    const db = openDatabase(defaultDbPath());
    try {
      const plan = planPrune(db, { keepRuns: keepFlag, deep: flags.deep === true });
      console.log(
        `prune plan: keep newest ${plan.keepRuns} finished run(s) — ` +
          `${plan.beyond.length} beyond window, ${plan.checkpointRows} checkpoint row(s) + ${plan.watermarkRows} context watermark(s) across ${plan.checkpointRuns} finished run(s)${plan.deep ? ", deep (ledger rows + VACUUM)" : ""}`,
      );
      if (flags["dry-run"] === true) {
        console.log("(dry run — nothing deleted)");
        return 0;
      }
      const result = applyPrune(db, plan, {
        tracesDir: tracesDir(),
        evidenceDir: path.join(harnessDataDir(process.cwd()), "evidence"),
      });
      console.log(
        `pruned: ${result.checkpointsDeleted} checkpoint row(s), ${result.watermarksDeleted} context watermark(s), ` +
          `${result.tracesDeleted} trace file(s), ${result.evidenceDeleted} evidence dir(s), ${result.eventRowsDeleted} ledger row(s), ${(result.bytesFreed / 1024).toFixed(1)} KiB freed`,
      );
    } finally {
      db.close();
    }
    return 0;
  }

  if (command !== "run") {
    console.log(HELP);
    return command === "help" ? 0 : 2;
  }

  const task = positional.join(" ").trim();
  if (!task) {
    console.error('usage: agent-harness run "<task>" [--model provider/model-id]');
    return 2;
  }
  const flagModel = typeof flags.model === "string" ? flags.model : undefined;
  const spec = flagModel ?? defaultModelSpec();
  if (!spec) {
    console.error("no model selected: pass --model provider/model-id or set HARNESS_MODEL (see: agent-harness models)");
    return 2;
  }

  const model = resolveModel(spec);

  const noDistill = flags["no-distill"] === true;
  const toolsFlag = typeof flags.tools === "string" ? flags.tools : undefined;
  if (toolsFlag !== undefined && toolsFlag !== "demo" && toolsFlag !== "coding") {
    console.error(`unknown --tools "${toolsFlag}" (expected demo | coding)`);
    return 2;
  }
  const manager = new RunManager();
  const startedAt = Date.now();
  // 阶段 13 (P0): the shell is a real one — the CLI defaults to interactive
  // approval (non-TTY auto-denies everything mutating) and --yolo is the
  // explicit opt-in to full autonomy. The LIBRARY default (auto-approve all)
  // is unchanged for backwards compatibility; scripts must opt in explicitly.
  const approvalMode: ApprovalMode =
    flags.yolo === true ? "auto-approve" : ((approvalFlag as ApprovalMode | undefined) ?? "interactive");
  if (approvalMode === "interactive" && !process.stdin.isTTY) {
    console.warn(
      "[approval] interactive mode in a non-interactive shell: mutating tools will be auto-denied (use --yolo to override)",
    );
  }
  const result = await manager.run({
    task,
    model,
    reporter: new ConsoleReporter(),
    tools: toolsFlag as ToolsetSpec | undefined,
    approval: {
      mode: approvalMode,
      capabilities: capabilities as readonly Capability[] | undefined,
    },
    fault: typeof flags.fault === "string" ? flags.fault : undefined,
    // --no-skills: manual baseline for hand-run A/B demos (阶段 10 eval does this itself)
    skills: flags["no-skills"] === true ? false : undefined,
  });

  const record = result.record;
  console.log("");
  console.log(`run ${record.id}`);
  console.log(`status: ${record.status}`);
  if (record.finishedAt) console.log(`duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (result.usage) {
    const u = result.usage;
    console.log(`tokens: in=${u.input} out=${u.output} total=${u.totalTokens} cost=$${u.cost.total.toFixed(4)}`);
  }
  if (result.tracePath) console.log(`trace: ${result.tracePath}`);
  if (record.error) console.error(`error: ${record.error}`);
  if (noDistill) {
    console.log("memory: skipped (--no-distill)");
  } else {
    try {
      const outcome = await reflectRunById(record.id);
      if (outcome.action === "created" || outcome.action === "updated") {
        console.log(
          `memory: ${outcome.action} ${outcome.record.id} (rev ${outcome.record.revision}) — ${outcome.reason}`,
        );
      } else {
        console.log(`memory: ${outcome.action} — ${outcome.reason}`);
      }
    } catch (err) {
      console.error(`memory: reflection failed (${err instanceof Error ? err.message : err})`);
    }
  }
  // Run 结束 + reflect 之后的向量补全：CLI 短生命周期，退出前 drain 完成。
  if (await manager.drainMemoryBackfill()) {
    console.log("memory: embedding backfill complete (vector recall now effective)");
  }
  manager.close();
  return record.status === "completed" ? 0 : 1;
}

// 加固期第三轮: run only when EXECUTED (the bin), never when imported — the
// module was previously import-hostile (any importer triggered main()).
// `import.meta.main` is authoritative where the runtime provides it; the
// realpath fallback covers Node 22.19 (the engines floor) defensively and
// resolves bin symlinks on POSIX.
const invokedDirectly: boolean =
  (import.meta as { main?: boolean }).main ??
  (() => {
    const entry = process.argv[1];
    if (entry === undefined) return false;
    try {
      return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
    } catch {
      return false;
    }
  })();

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      // HarnessError carries a polished message; anything else is a bug — keep
      // the stack so unexpected TypeErrors are debuggable at all.
      if (err instanceof HarnessError) console.error(err.message);
      else if (err instanceof Error) console.error(err.stack ?? err.message);
      else console.error(err);
      process.exit(1);
    });
}
