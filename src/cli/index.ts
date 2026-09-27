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
import { createPermissionGate, type ApprovalMode } from "../runtime/approval.js";
import { ALL_CAPABILITIES, type Capability } from "../runtime/permissions.js";
import type { TraceEvent } from "../trace/schema.js";
import { distillRunById } from "../memory/distiller.js";
import { MemoryStore } from "../memory/store.js";
import { MemorySearchIndex } from "../memory/search.js";
import { localEmbedder } from "../memory/embedding.js";

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
  agent-harness run "<task>" [--model provider/model-id] [--yolo]
                    [--approval auto-approve|auto-deny|interactive]
                    [--capabilities fs:read,fs:write,...] [--fault point:tool]
  agent-harness resume [runId]           recover an interrupted run (default: latest)
  agent-harness memory core              show/create the always-resident Core Memory file
  agent-harness memory list              list Ordinary Memory files (authoritative markdown)
  agent-harness memory search <query> [--limit <n>] [--hybrid]   FTS5, or FTS+embeddings fused (RRF)
  agent-harness memory rebuild [--vector]      rebuild indexes from the .md files (--vector embeds)
  agent-harness memory distill <runId>   distill a run manually
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
  const approvalFlag = typeof flags.approval === "string" ? flags.approval : undefined;
  if (approvalFlag && approvalFlag !== "auto-approve" && approvalFlag !== "auto-deny" && approvalFlag !== "interactive") {
    console.error(`unknown --approval mode "${approvalFlag}" (expected auto-approve | auto-deny | interactive)`);
    return 2;
  }
  const capabilitiesFlag = typeof flags.capabilities === "string" ? flags.capabilities : undefined;
  let capabilities: readonly string[] | undefined;
  if (capabilitiesFlag) {
    const requested = capabilitiesFlag.split(",").map((c) => c.trim()).filter(Boolean);
    const invalid = requested.filter((c) => !ALL_CAPABILITIES.includes(c as never));
    if (invalid.length > 0) {
      console.error(`unknown capabilities: ${invalid.join(", ")} (available: ${ALL_CAPABILITIES.join(", ")})`);
      return 2;
    }
    capabilities = requested;
  }
  const noDistill = flags["no-distill"] === true;
  const manager = new RunManager();
  const startedAt = Date.now();
  const result = await manager.run({
    task,
    model,
    reporter: new ConsoleReporter(),
    approval: {
      mode: flags.yolo === true ? "auto-approve" : (approvalFlag as ApprovalMode | undefined),
      capabilities: capabilities as readonly Capability[] | undefined,
    },
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
