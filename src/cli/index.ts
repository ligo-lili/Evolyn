#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { HarnessError } from "../errors.js";
import { defaultModelSpec } from "../config.js";
import { getModelRegistry, listProviderIds, resolveModel } from "../providers.js";
import { listTraces } from "../trace/read.js";
import { explain } from "../trace/replay.js";
import { summarize } from "../trace/query.js";
import { renderReplay, renderSummary, renderTimeline } from "../trace/show.js";
import { defaultDbPath, openDatabase } from "../storage/db.js";
import { TraceEventRepo } from "../storage/repos/trace-events.js";
import { tracesDir } from "../runtime/paths.js";
import { ConsoleReporter } from "../runtime/reporter.js";
import { RunManager } from "../runtime/run-manager.js";
import { createPermissionGate, type ApprovalMode, type ApprovalOptions } from "../runtime/approval.js";
import { ALL_CAPABILITIES, type Capability } from "../runtime/permissions.js";
import type { ToolsetSpec } from "../runtime/run-manager.js";
import type { TraceEvent } from "../trace/schema.js";
import { distillRunById } from "../memory/distiller.js";
import { MemoryStore } from "../memory/store.js";
import { MemorySearchIndex } from "../memory/search.js";
import { localEmbedder } from "../memory/embedding.js";
import { minePatternsFromDb } from "../learning/miner.js";
import { draftSkillFromPattern } from "../learning/candidate.js";
import {
  defaultEvalRunner,
  loadTaskSet,
  renderEvalReport,
  runEvalAgainstBaseline,
  runEvalArm,
  runEvalComparison,
} from "../learning/eval.js";
import { EvalBaselineRepo, SkillEvalRepo, skillEvalRowFromReport } from "../storage/repos/evals.js";
import { promoteCandidate } from "../skills/promote.js";
import { SkillIndex, toAssemblerEntries } from "../skills/retrieve.js";
import { verifyPromotedSkills } from "../skills/verify.js";
import { PatternRepo } from "../storage/repos/patterns.js";
import { SkillCandidateRepo } from "../storage/repos/candidates.js";
import { promotedSkillsDir, skillsDir } from "../runtime/paths.js";
import { DEMO_TOOLS } from "../runtime/tools/index.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }
  return { command: command ?? "help", positional, flags };
}

const HELP = `agent-harness — durable execution harness on top of Pi Agent Runtime

Usage:
  agent-harness run "<task>" [--model provider/model-id] [--tools demo|coding]
                    [--yolo] [--approval auto-approve|auto-deny|interactive]
                    [--capabilities fs:read,fs:write,...] [--fault point:tool]
  agent-harness resume [runId]           recover an interrupted run (default: latest)
                    [--yolo] — approval gates apply to recovered tool executions too
  agent-harness memory core              show/create the always-resident Core Memory file
  agent-harness memory list              list Ordinary Memory files (authoritative markdown)
  agent-harness memory search <query> [--limit <n>] [--hybrid]   FTS5, or FTS+embeddings fused (RRF)
  agent-harness memory rebuild [--vector]      rebuild indexes from the .md files (--vector embeds)
  agent-harness memory distill <runId>   distill a run manually
  agent-harness skill mine [--min-support <n>]
                                           mine tool-sequence / error-repair patterns from finished runs
  agent-harness skill patterns             list mined patterns
  agent-harness skill draft <patternId> [--model <spec>]
                                           distill a draft SKILL.md from a pattern (hard rule: support>=3)
  agent-harness skill candidates           list skill candidates
  agent-harness skill show <candidateId>   print a candidate's SKILL.md
  agent-harness skill promote <candidateId> [--force]
                                           promote a candidate to .harness/skills/promoted/<name>/SKILL.md
  agent-harness skill list                 list promoted skills
  agent-harness skill retrieve "<task>"    preview which skills a run would inject
  agent-harness skill rebuild              rebuild the skill index from the promoted SKILL.md files
  agent-harness skill eval <taskset.json> --skill <name> [--model <spec>] [--repeats <n>] [--against-baseline]
                                           scripted A/B: no-skill baseline vs skill-injected (report persisted)
  agent-harness skill baseline <taskset.json> [--model <spec>] [--repeats <n>]
                                           record the no-skill regression baseline for a task set + model
  agent-harness skill evals [limit]        list persisted eval reports (the iteration ledger)
  agent-harness skill verify               check the promoted root loads via pi loadSkillsFromDir
  agent-harness models [provider]          list providers, or a provider's models
  agent-harness trace list                 list recorded runs
  agent-harness trace show <runId> [--all] render a run's execution timeline
  agent-harness trace summary <runId>      aggregate stats for a run
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

function isTracePath(id: string): boolean {
  return id.endsWith(".jsonl") || id.includes("/") || id.includes("\\");
}

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

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  // Shared flag parsing (run and resume both gate on these).
  const approvalFlag = typeof flags.approval === "string" ? flags.approval : undefined;
  if (approvalFlag !== undefined && approvalFlag !== "auto-approve" && approvalFlag !== "auto-deny" && approvalFlag !== "interactive") {
    console.error(`unknown --approval mode "${approvalFlag}" (expected auto-approve | auto-deny | interactive)`);
    return 2;
  }
  const capabilitiesFlag = typeof flags.capabilities === "string" ? flags.capabilities : undefined;
  let capabilities: readonly Capability[] | undefined;
  if (capabilitiesFlag) {
    const requested = capabilitiesFlag.split(",").map((c) => c.trim()).filter(Boolean) as readonly Capability[];
    const invalid = requested.filter((c) => !ALL_CAPABILITIES.includes(c as never));
    if (invalid.length > 0) {
      console.error(`unknown capabilities: ${invalid.join(", ")} (available: ${ALL_CAPABILITIES.join(", ")})`);
      return 2;
    }
    capabilities = requested;
  }

  if (command === "models") {
    const provider = positional[0];
    if (!provider) {
      console.log(listProviderIds().join("\n"));
      return 0;
    }
    const models = getModelRegistry().getModels(provider).map((m) => `${provider}/${m.id}`);
    console.log(models.length ? models.join("\n") : `(no models registered for "${provider}")`);
    return 0;
  }

  if (command === "memory") {
    const sub = positional[0];
    const dbPath = defaultDbPath();
    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    if (sub === "core") {
      const existing = store.readCore();
      if (existing !== undefined && flags.edit !== true) {
        console.log(existing);
      } else {
        if (existing === undefined) {
          store.writeCore("# Core Memory\n\n<项目级事实、用户偏好、长期约束。每轮 run 都会注入 system prompt。>\n");
          console.log(`created ${store.corePath} — edit it freely; it is injected into every run.`);
        } else {
          console.log(`core memory file: ${store.corePath}`);
        }
      }
      return 0;
    }
    if (sub === "list") {
      const records = store.list();
      if (records.length === 0) {
        console.log("(no memory yet — runs are distilled automatically unless --no-distill)");
        return 0;
      }
      for (const m of records) {
        console.log(`[${m.taskType}] ${m.outcome} ×${m.confirmations} — ${m.summaryZh}`);
        console.log(`    ${path.relative(process.cwd(), store.pathOf(m.id))}`);
      }
      return 0;
    }
    if (sub === "search") {
      const query = positional.slice(1).join(" ").trim();
      if (!query) {
        console.error("usage: agent-harness memory search <query> [--limit <n>] [--hybrid]");
        return 2;
      }
      const db = openDatabase(dbPath);
      try {
        const index = new MemorySearchIndex(db);
        const limit = typeof flags.limit === "string" ? Number(flags.limit) : 3;
        const capped = Number.isFinite(limit) && limit > 0 ? limit : 3;
        const hits = flags.hybrid === true ? await index.searchHybrid(query, capped, localEmbedder()) : index.searchFts(query, capped);
        if (hits.length === 0) {
          console.log("(no matching memory — try `memory rebuild` if you edited the .md files)");
          return 0;
        }
        if (flags.hybrid === true) console.log("(hybrid: FTS5 + local embeddings, fused with RRF)");
        hits.forEach((h, i) => {
          console.log(`#${i + 1} [${h.taskType}] ${h.outcome} ×${h.confirmations} — ${h.summaryZh}`);
          console.log(`    approach: ${h.approach}`);
          console.log(`    pitfalls: ${h.pitfalls}`);
          console.log(`    file: ${path.relative(process.cwd(), store.pathOf(h.id))} (run ${h.runId})`);
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
        let vectors = 0;
        if (flags.vector === true) {
          vectors = await index.rebuildVectors(store, localEmbedder());
        }
        console.log(`index rebuilt from ${n} memory file(s)${flags.vector === true ? `, ${vectors} vector(s) embedded` : ""}`);
      } finally {
        db.close();
      }
      return 0;
    }
    if (sub === "distill") {
      const id = positional[1];
      if (!id) {
        console.error("usage: agent-harness memory distill <runId>");
        return 2;
      }
      const outcome = await distillRunById(id);
      console.log(
        outcome.merged
          ? `memory: confirmed existing ${outcome.record.id} (×${outcome.record.confirmations})`
          : `memory: created ${outcome.record.id} (${outcome.record.taskType}, ${outcome.record.outcome})`,
      );
      console.log(`    ${outcome.file}`);
      return 0;
    }
    console.error("usage: agent-harness memory core | memory list | memory search <query> | memory rebuild | memory distill <runId>");
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
          console.log(`[${p.kind}] ${p.signature} — support ${p.support}, replay ${p.replaySafety} (${p.traceRefs.length} trace(s)) id=${p.id}`);
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
      const outcome = promoteCandidate(id, { skillsRoot: skillsDir(), force: flags.force === true });
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
        console.error("usage: agent-harness skill eval <taskset.json> --skill <name> [--model <spec>] [--repeats <n>] [--against-baseline]");
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
      const repeatsFlag = typeof flags.repeats === "string" ? Number(flags.repeats) : 1;
      const repeats = Number.isFinite(repeatsFlag) && repeatsFlag >= 1 ? Math.floor(repeatsFlag) : 1;
      const runner = defaultEvalRunner(spec);
      let report;
      if (flags["against-baseline"] === true) {
        const db2 = openDatabase(dbPath);
        let stored;
        try {
          stored = new EvalBaselineRepo(db2).latest(taskSet.name, spec);
        } finally {
          db2.close();
        }
        if (!stored) {
          console.error(`no recorded baseline for "${taskSet.name}" + ${spec} — run: agent-harness skill baseline ${file} --model ${spec}`);
          return 1;
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
          repeats,
          stored: { arm: stored.arm, repeats: stored.repeats },
        });
      } else {
        console.log(`running ${taskSet.tasks.length} task(s) × ${repeats} repeat(s) × 2 arms (baseline / +skill "${skillName}")…`);
        report = await runEvalComparison(taskSet, { runner, skillName, skillVersion: registered.version, repeats });
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
      const repeatsFlag = typeof flags.repeats === "string" ? Number(flags.repeats) : 1;
      const repeats = Number.isFinite(repeatsFlag) && repeatsFlag >= 1 ? Math.floor(repeatsFlag) : 1;
      const taskSet = loadTaskSet(file);
      const runner = defaultEvalRunner(spec);
      console.log(`recording no-skill baseline: ${taskSet.tasks.length} task(s) × ${repeats} repeat(s) with ${spec}…`);
      const arm = await runEvalArm(taskSet, runner, false, { repeats });
      const db = openDatabase(dbPath);
      let recorded;
      try {
        recorded = new EvalBaselineRepo(db).record({ evalSet: taskSet.name, modelSpec: spec, repeats, arm });
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
        console.warn(`⚠ ${failures.length}/${runs} run(s) failed (infra: ${arm.infraFailures}) — first reason: ${failures[0]?.reason}`);
        if (arm.infraFailures === failures.length && failures.length === runs) {
          console.warn("  every run died to infrastructure — check the API key env var for this shell before trusting this baseline");
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
      for (const d of verification.diagnostics) console.error(`diagnostic [${d.type}] ${d.message}${d.path ? ` (${d.path})` : ""}`);
      console.log(verification.ok ? "verification OK" : "verification FAILED");
      return verification.ok ? 0 : 1;
    }

    console.error(
      "usage: agent-harness skill mine | patterns | draft <patternId> | candidates | show <id> | promote <id> | list | retrieve \"<task>\" | rebuild | verify | eval <taskset.json> --skill <name> | baseline <taskset.json> | evals",
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
      console.log(renderSummary(summarize(loadRunEvents(id))));
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
        const repo = new TraceEventRepo(db);
        const tool = typeof flags.tool === "string" ? flags.tool : undefined;
        const events = tool
          ? repo.queryToolCalls(tool, id)
          : flags.errors
            ? repo.queryErrors(id)
            : repo.getByRun(id);
        if (events.length === 0) console.log("(no matching events)");
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
    const result = await manager.resume(targetId, {
      reporter: new ConsoleReporter(),
      // 阶段 13: recovered tool executions go through the same approval gate AND
      // the same toolset — resume with --tools coding when the crashed run used it.
      tools: toolsFlag as ToolsetSpec | undefined,
      approval: {
        mode: flags.yolo === true ? "auto-approve" : ((typeof flags.approval === "string" ? (flags.approval as ApprovalMode) : undefined) ?? "interactive"),
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
        const outcome = await distillRunById(record.id);
        console.log(
          outcome.merged
            ? `memory: confirmed existing ${outcome.record.id} (×${outcome.record.confirmations})`
            : `memory: created (${outcome.record.taskType}, ${outcome.record.outcome}) — ${outcome.record.summaryZh}`,
        );
      } catch (err) {
        console.error(`memory: distill failed (${err instanceof Error ? err.message : err})`);
      }
    }
    manager.close();
    return record.status === "completed" ? 0 : 1;
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
  const approvalMode: ApprovalMode = flags.yolo === true ? "auto-approve" : ((approvalFlag as ApprovalMode | undefined) ?? "interactive");
  if (approvalMode === "interactive" && !process.stdin.isTTY) {
    console.warn("[approval] interactive mode in a non-interactive shell: mutating tools will be auto-denied (use --yolo to override)");
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
      const outcome = await distillRunById(record.id);
      console.log(
        outcome.merged
          ? `memory: confirmed existing ${outcome.record.id} (×${outcome.record.confirmations})`
          : `memory: created (${outcome.record.taskType}, ${outcome.record.outcome}) — ${outcome.record.summaryZh}`,
      );
    } catch (err) {
      console.error(`memory: distill failed (${err instanceof Error ? err.message : err})`);
    }
  }
  manager.close();
  return record.status === "completed" ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof HarnessError || err instanceof Error ? err.message : err);
    process.exit(1);
  });
