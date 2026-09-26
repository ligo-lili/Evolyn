#!/usr/bin/env node
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
import type { ApprovalMode } from "../runtime/approval.js";
import type { TraceEvent } from "../trace/schema.js";
import { distillRunById } from "../memory/distiller.js";
import { ExperienceRepo } from "../memory/store.js";

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
  agent-harness run "<task>" [--model provider/model-id]
  agent-harness resume [runId]           recover an interrupted run (default: latest)
  agent-harness experience search <query> [--limit <n>]   search stored experience
  agent-harness experience list          show recent experience records
  agent-harness experience distill <runId>                distill a run manually
  agent-harness models [provider]          list providers, or a provider's models
  agent-harness trace list                 list recorded runs
  agent-harness trace show <runId> [--all] render a run's execution timeline
  agent-harness trace summary <runId>      aggregate stats for a run
  agent-harness trace replay <runId> [--until <seq>]
                                           rebuild the run's state at any point + explain why
  agent-harness trace query <runId> [--tool <name>] [--errors]
                                           query a run's events in SQLite
  agent-harness help

Model providers: openai, anthropic, deepseek (built into pi-ai) and qwen
(DashScope compatible-mode, registered by this harness).
API keys are read from the environment:
  OPENAI_API_KEY  ANTHROPIC_API_KEY  DEEPSEEK_API_KEY  DASHSCOPE_API_KEY|QWEN_API_KEY
Default model comes from HARNESS_MODEL. Traces land in .harness/traces/<runId>.jsonl.`;

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

  if (command === "experience") {
    const sub = positional[0];
    const db = openDatabase(defaultDbPath());
    try {
      const repo = new ExperienceRepo(db);
      if (sub === "search") {
        const query = positional.slice(1).join(" ").trim();
        if (!query) {
          console.error("usage: agent-harness experience search <query> [--limit <n>]");
          return 2;
        }
        const limit = typeof flags.limit === "string" ? Number(flags.limit) : 3;
        const hits = repo.search(query, Number.isFinite(limit) && limit > 0 ? limit : 3);
        if (hits.length === 0) {
          console.log("(no matching experience yet)");
          return 0;
        }
        hits.forEach((h, i) => {
          console.log(`#${i + 1} [${h.taskType}] ${h.outcome} — ${h.summaryZh}`);
          console.log(`    approach: ${h.approach}`);
          console.log(`    pitfalls: ${h.pitfalls}`);
          console.log(`    run: ${h.runId}`);
        });
        return 0;
      }
      if (sub === "list") {
        const items = repo.listRecent(20);
        if (items.length === 0) {
          console.log("(no experience stored yet — runs are distilled automatically unless --no-distill)");
          return 0;
        }
        for (const e of items) console.log(`[${e.taskType}] ${e.outcome} — ${e.summaryZh}  (${e.createdAt.slice(0, 19)}, run ${e.runId})`);
        return 0;
      }
      if (sub === "distill") {
        const id = positional[1];
        if (!id) {
          console.error("usage: agent-harness experience distill <runId>");
          return 2;
        }
        const record = await distillRunById(id);
        console.log(`experience: stored (${record.taskType}, ${record.outcome}) — ${record.summaryZh}`);
        return 0;
      }
      console.error("usage: agent-harness experience search <query> | experience list | experience distill <runId>");
      return 2;
    } finally {
      db.close();
    }
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
    const result = await manager.resume(targetId, { reporter: new ConsoleReporter() });
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
        const stored = await distillRunById(record.id);
        console.log(`experience: stored (${stored.taskType}, ${stored.outcome}) — ${stored.summaryZh}`);
      } catch (err) {
        console.error(`experience: distill failed (${err instanceof Error ? err.message : err})`);
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
  const approvalFlag = typeof flags.approval === "string" ? flags.approval : undefined;
  if (approvalFlag && approvalFlag !== "auto-approve" && approvalFlag !== "auto-deny") {
    console.error(`unknown --approval mode "${approvalFlag}" (expected auto-approve | auto-deny)`);
    return 2;
  }
  const noDistill = flags["no-distill"] === true;
  const manager = new RunManager();
  const startedAt = Date.now();
  const result = await manager.run({
    task,
    model,
    reporter: new ConsoleReporter(),
    approval: approvalFlag ? { mode: approvalFlag as ApprovalMode } : undefined,
    fault: typeof flags.fault === "string" ? flags.fault : undefined,
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
    console.log("experience: skipped (--no-distill)");
  } else {
    try {
      const stored = await distillRunById(record.id);
      console.log(`experience: stored (${stored.taskType}, ${stored.outcome}) — ${stored.summaryZh}`);
    } catch (err) {
      console.error(`experience: distill failed (${err instanceof Error ? err.message : err})`);
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
