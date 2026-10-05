import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { DatabaseSync } from "node:sqlite";
import { CODING_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT } from "../config.js";
import { HarnessError } from "../errors.js";
import { resolveModel } from "../providers.js";
import { openDatabase, defaultDbPath } from "../storage/db.js";
import { RunRepo } from "../storage/repos/runs.js";
import { TraceEventRepo } from "../storage/repos/trace-events.js";
import { CheckpointRepo } from "../storage/repos/checkpoints.js";
import { CheckpointWriter } from "../execution/checkpoint.js";
import { loadCrashedRun, planRecovery, toolResultMessage } from "../execution/recovery.js";
import {
  assembleSystemPrompt,
  renderExperienceBlock,
  renderSkillBlock,
  renderWorkspaceBlock,
  escapeStructuralTags,
} from "../context/assembler.js";
import { buildWorkspaceTree } from "../context/workspace.js";
import { SkillIndex, toAssemblerEntries } from "../skills/retrieve.js";
import { createContextTransformer, type ContextManagementOptions } from "../context/compaction.js";
import { DEFAULT_RUN_LIMITS, type LimitViolation, type RunLimits } from "./limits.js";
import type { RetryPolicy } from "./retry.js";
import { composeRuntime, sumAgentUsage } from "./compose.js";
import { MemorySearchIndex } from "../memory/search.js";
import { MemoryStore } from "../memory/store.js";
import { createMemoryTools } from "../memory/tools.js";
import { EMBEDDING_MODEL_ID, sharedEmbedder, type PassageEmbedder } from "../memory/embedding.js";
import { TraceRecorder, JsonlTraceSink, type TraceSink } from "../trace/recorder.js";
import { reconcileJsonlTrace } from "../trace/reconcile.js";
import { FaultController, formatFaultSpec, parseFaultSpec } from "../execution/fault.js";
import type { ApprovalOptions } from "./approval.js";
import { ALL_CAPABILITIES } from "./permissions.js";
import { harnessDataDir } from "./paths.js";
import { createAgent } from "./agent-factory.js";
import { ConsoleReporter, type RunReporter } from "./reporter.js";
import { DEMO_TOOLS, type AnyAgentTool } from "./tools/index.js";
import { createCodingToolset } from "./tools/coding.js";
import type { ExploreToolDeps } from "./tools/explore.js";
import type { HarnessAuditEvent } from "../trace/schema.js";

export type RunStatus = "running" | "completed" | "failed";

/** 阶段 10 skill injection: FTS top-k by default, forced names via `only`. */
export interface SkillInjection {
  limit?: number;
  /** Force specific skill names (eval A/B, demos); bypasses retrieval ranking. */
  only?: readonly string[];
}

const DEFAULT_SKILL_LIMIT = 2;

/** Tool source: the demo set (default — keeps existing eval baselines
 * comparable) or pi's coding toolset (阶段 13), or an explicit array. */
export type ToolsetSpec = AnyAgentTool[] | "demo" | "coding";

function resolveTools(tools: ToolsetSpec | undefined, explore?: ExploreToolDeps): AnyAgentTool[] {
  if (tools === "coding") return createCodingToolset(process.cwd(), { explore });
  if (tools === "demo" || tools === undefined) return DEMO_TOOLS;
  return tools;
}

/**
 * Coding runs legitimately repeat identical commands (npm test after every
 * edit), so the same-tool+same-args guard default is relaxed for the coding
 * toolset unless the caller set it explicitly. Degenerate-loop protection
 * stays on at the higher cap.
 */
function defaultLimitsFor(tools: ToolsetSpec | undefined, overrides: RunLimits | undefined): Required<RunLimits> {
  const coding = tools === "coding";
  return {
    maxTurns: overrides?.maxTurns ?? DEFAULT_RUN_LIMITS.maxTurns,
    maxToolCalls: overrides?.maxToolCalls ?? DEFAULT_RUN_LIMITS.maxToolCalls,
    maxRepeatedToolCalls: overrides?.maxRepeatedToolCalls ?? (coding ? 12 : DEFAULT_RUN_LIMITS.maxRepeatedToolCalls),
    maxCostUsd: overrides?.maxCostUsd ?? DEFAULT_RUN_LIMITS.maxCostUsd,
    maxTotalTokens: overrides?.maxTotalTokens ?? DEFAULT_RUN_LIMITS.maxTotalTokens,
    toolTimeoutMs: overrides?.toolTimeoutMs ?? DEFAULT_RUN_LIMITS.toolTimeoutMs,
  };
}

export interface RunRecord {
  id: string;
  task: string;
  modelSpec: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Persisted for recovery: the trace never contains the synthesized system message. */
  systemPrompt?: string;
  /**
   * Persisted for recovery: resume rebuilds the SAME toolset (a crashed coding
   * run resumed with the demo default would synthesize "not registered" errors
   * for every unresolved call). Only the named presets are persistable —
   * explicit tool arrays stay undefined and fall back to the demo default.
   */
  toolset?: "demo" | "coding";
}

export interface RunResult {
  record: RunRecord;
  messages: AgentMessage[];
  usage?: Usage;
  /** Set when tracing is enabled (default): .harness/traces/<runId>.jsonl */
  tracePath?: string;
}

export interface RunOptions {
  task: string;
  model: Model<Api>;
  /** Tool source: "demo" (default), "coding" (阶段 13 pi toolset), or explicit tools. */
  tools?: ToolsetSpec;
  /** Explicit system prompt. Default: the coding prompt for tools:"coding", else the demo prompt. */
  systemPrompt?: string;
  streamFn?: StreamFn;
  reporter?: RunReporter;
  /** Write a JSONL trace for this run. Default true. */
  trace?: boolean;
  /** Override the trace output directory (tests). */
  traceDir?: string;
  /** SQLite file for durable persistence; false disables. Default .harness/harness.db */
  database?: string | false;
  /** Tool approval gate. Undefined = no gate (all tools run). */
  approval?: ApprovalOptions;
  /** Fault injection spec "point:toolName" for crash demos/tests, e.g. "after_tool_call:send_notification". */
  fault?: string;
  /**
   * Context management overrides (blocks / budget lines / two-layer reduction).
   * Defaults derive the six budget lines from the run model's window.
   */
  context?: Omit<ContextManagementOptions, "model" | "onEvent" | "historyCount" | "evidenceBase">;
  /**
   * Ordinary-memory recall + tool surface (记忆设计 v3：召回是 cue、显式读取
   * 才授权更新). Default: 5 cue hits injected at run start (snapshot, no side
   * effects). `tools` adds the model tool surface (memory_read/search/create/
   * update/archive + core_memory_update) — default true for the coding
   * toolset, opt-in otherwise. `hybrid` (default true) enables the vector
   * retrieval path; `embedder` injects a fake for tests — the production
   * default is the process-wide sharedEmbedder, zero-cost until vectors
   * actually exist (vectorCount() === 0 never touches the model).
   */
  memory?: { limit?: number; tools?: boolean; hybrid?: boolean; embedder?: PassageEmbedder };
  /**
   * 阶段 10 skill injection for <available_skills>. Default: FTS top-2 from
   * the promoted skill index when a database is attached; `false` disables
   * (eval baseline arm).
   */
  skills?: SkillInjection | false;
  /** Runaway guards (turns/tool calls/repeats/cost). Defaults are always enforced. */
  limits?: RunLimits;
  /** Tiered retry policy for idempotent tools (transient errors only). */
  retry?: RetryPolicy;
}

export interface ResumeOptions {
  /** Model for the resumed agent; defaults to resolving the run's model_spec. */
  model?: Model<Api>;
  /** Tool source: "demo" (default), "coding" (阶段 13), or explicit tools. */
  tools?: ToolsetSpec;
  streamFn?: StreamFn;
  reporter?: RunReporter;
  database?: string | false;
  traceDir?: string;
  /** Context management overrides for the resumed agent. */
  context?: Omit<ContextManagementOptions, "model" | "onEvent" | "historyCount" | "evidenceBase">;
  /** Approval gate for the resumed run — recovery re-executions go through it (阶段 13). */
  approval?: ApprovalOptions;
  /** Runaway guards for the resumed run. Defaults are always enforced. */
  limits?: RunLimits;
  /** Tiered retry policy for the resumed run. */
  retry?: RetryPolicy;
  /** Memory tool surface + hybrid flag for the resumed segment (same default as run). */
  memory?: { tools?: boolean; hybrid?: boolean; embedder?: PassageEmbedder };
  /**
   * 加固期 (P2): fault injection for the RECOVERY segment — e.g.
   * "mid_recovery:1" kills with one call already resolved, "between_sinks"
   * kills between the JSONL and SQLite writes.
   */
  fault?: string;
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") return m;
  }
  return undefined;
}

/**
 * Owns the run lifecycle (id, status, timing, trace, durable rows) and drives
 * one Agent per run. Checkpoint/Recovery (阶段 5/6) attach here next.
 */
export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private db?: DatabaseSync;
  /** 在途的记忆向量补全（fire-and-forget）；CLI 在退出前 drain。 */
  private memoryBackfill?: Promise<void>;
  /** 最近一次 run 的记忆检索上下文——drain 时重查 pending 用。embedder 为
   * undefined 表示 hybrid 关闭：向量补全不属于该 posture，绝不启动。 */
  private memoryBackfillContext?: {
    store: MemoryStore;
    index: MemorySearchIndex;
    embedder: PassageEmbedder | undefined;
  };

  private ensureDatabase(spec: string | false | undefined): DatabaseSync | undefined {
    if (spec === false) return undefined;
    this.db ??= openDatabase(spec ?? defaultDbPath());
    return this.db;
  }

  async run(options: RunOptions): Promise<RunResult> {
    const faultSpec = parseFaultSpec(options.fault); // validates before anything is written
    const basePrompt =
      options.systemPrompt ?? (options.tools === "coding" ? CODING_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT);
    const record: RunRecord = {
      id: randomUUID(),
      task: options.task,
      modelSpec: `${options.model.provider}/${options.model.id}`,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    // Resume restores the toolset from this field (migration 012) — named
    // presets only; explicit tool arrays are not persistable.
    if (options.tools === "demo" || options.tools === "coding") record.toolset = options.tools;
    this.runs.set(record.id, record);

    const database = this.ensureDatabase(options.database);
    const runRepo = database ? new RunRepo(database) : undefined;

    // Memory（记忆设计 v3）：Core 常驻注入；自动召回每 Run 一次、是 cue
    // 快照（id/title/revision/summary/snippet）——无副作用、不授权更新。
    // 启动对账以 Markdown 为权威同步文本投影（关键路径不做 embedding——
    // 向量路在 vectorCount() === 0 时零成本直返，建过向量才付一次 query
    // embedding）。权威目录与 reflect/CLI 同源：自定义 database 时用其所在
    // 目录下的 memory/，默认（或 database:false）回落 .harness/memory。
    const memoryDir =
      typeof options.database === "string"
        ? path.join(path.dirname(options.database), "memory")
        : path.join(harnessDataDir(process.cwd()), "memory");
    const memoryStore = new MemoryStore(memoryDir);
    const core = memoryStore.readCore();
    const memoryHybrid = options.memory?.hybrid ?? true;
    const memoryEmbedder = memoryHybrid ? (options.memory?.embedder ?? sharedEmbedder()) : undefined;
    let memoryIndex: MemorySearchIndex | undefined;
    let experienceBlock: string | undefined;
    if (database) {
      memoryIndex = new MemorySearchIndex(database);
      memoryIndex.reconcile(memoryStore);
      const hits = await memoryIndex.search(memoryStore, options.task.slice(0, 1600), {
        limit: options.memory?.limit ?? 5,
        embedder: memoryEmbedder,
        // 复查补线: only the CURRENT embedding model's vectors may take part
        // in the cosine ranking — stale-model rows from a mid-backfill window
        // are meaningless against this query's embedding.
        embeddingModel: EMBEDDING_MODEL_ID,
      });
      if (hits.length > 0) {
        experienceBlock = renderExperienceBlock(
          hits.map((h) => ({
            id: h.record.id,
            title: h.record.title,
            revision: h.record.revision,
            summary: h.record.summary,
            snippet: h.snippet,
            path: path.relative(process.cwd(), memoryStore.pathOf(h.record.id)),
          })),
        );
      }
    }
    // Memory tool surface: coding runs get it by default; explicit opt-in via
    // memory.tools for any toolset. Created BEFORE composeRuntime so the tools
    // go through the SAME wrapper chain (evidence capture / timeout / retry) —
    // a memory_read result trimmed by compaction must have a real evidence
    // file behind its pointer.
    const memoryTools =
      memoryIndex && (options.memory?.tools ?? options.tools === "coding")
        ? createMemoryTools({
            store: memoryStore,
            index: memoryIndex,
            runId: record.id,
            embedder: memoryEmbedder ? () => memoryEmbedder : undefined,
          })
        : [];
    // 阶段 10 skill injection: promoted skills enter as <available_skills> —
    // the model reads the SKILL.md body on demand, mirroring pi's mechanism.
    let skillBlock: string | undefined;
    if (database && options.skills !== false) {
      const index = new SkillIndex(database);
      const only = options.skills?.only;
      const hits = only?.length
        ? index.getByName(only)
        : index.search(options.task, options.skills?.limit ?? DEFAULT_SKILL_LIMIT);
      if (hits.length > 0) skillBlock = renderSkillBlock(toAssemblerEntries(hits, process.cwd()));
    }
    const systemPrompt = assembleSystemPrompt({
      base: basePrompt,
      // 加固期 (P1): core.md content is model-writable via the tools — escape
      // structural tags in the CONTENT; the wrapper is built here, unescaped.
      core: core ? `<core_memory>\n${escapeStructuralTags(core)}\n</core_memory>` : undefined,
      // 阶段 13: the coding toolset gets a deterministic workspace map.
      workspace: options.tools === "coding" ? renderWorkspaceBlock(buildWorkspaceTree()) : undefined,
      skills: skillBlock,
      experiences: experienceBlock,
    });
    record.systemPrompt = systemPrompt;

    const limits: Required<RunLimits> = defaultLimitsFor(options.tools, options.limits);
    let limitViolation: LimitViolation | undefined;
    const traceEnabled = options.trace !== false;
    let traceFile: string | undefined;
    let recorder: TraceRecorder | undefined;
    const grantedCapabilities = options.approval?.capabilities ?? ALL_CAPABILITIES;
    // The durable row lands after every fallible SETUP step (memory index +
    // recall, skill index, system-prompt assembly) but BEFORE the trace
    // sinks: trace_events carries an FK to runs(id), so seq 1 (run_start)
    // must never be attempted without it. Once the row exists, only trace-
    // file I/O can throw before the try — a much smaller window than the
    // network-backed setup that used to sit after the insert.
    runRepo?.insert(record);
    // The controller must exist before the recorder: the between_sinks fault
    // point fires from inside the fan-out (after the JSONL write, before SQLite).
    const faultController = faultSpec ? new FaultController(faultSpec) : undefined;
    if (traceEnabled) {
      const traceDir = options.traceDir ?? path.join(harnessDataDir(process.cwd()), "traces");
      mkdirSync(traceDir, { recursive: true });
      traceFile = path.join(traceDir, `${record.id}.jsonl`);
      const sinks: TraceSink[] = [new JsonlTraceSink(traceFile)];
      if (database) sinks.push(new TraceEventRepo(database));
      recorder = new TraceRecorder(record.id, sinks, {
        onSinkBoundary: faultController ? (event) => faultController.onSinkBoundary(event) : undefined,
      });
      recorder.runStart(
        record.task,
        record.modelSpec,
        faultSpec ? formatFaultSpec(faultSpec) : undefined,
        grantedCapabilities,
      );
    }

    // Phase-1 explore subagent: deps close over `composed` (initialized right
    // below) so the child's spend lands on the parent's money fuses — the
    // closure only fires at tool-execution time, after `composed` exists.
    const exploreDeps: ExploreToolDeps | undefined =
      options.tools === "coding"
        ? {
            model: options.model,
            streamFn: options.streamFn,
            approval: options.approval,
            retryPolicy: options.retry,
            parentEvidenceDir: path.join(harnessDataDir(process.cwd()), "evidence", record.id),
            charge: (usage) => composed.limitEnforcer.charge(usage),
            audit: (event) => recorder?.record(event),
            summaryChat: options.context?.summaryChat,
          }
        : undefined;
    const composed = composeRuntime({
      tools: [...resolveTools(options.tools, exploreDeps), ...memoryTools],
      faultSpec,
      evidenceDir: path.join(harnessDataDir(process.cwd()), "evidence", record.id),
      limits,
      retryPolicy: options.retry,
      approval: options.approval,
      audit: (event) => recorder?.record(event),
      onLimitViolation: (violation) => {
        limitViolation = violation;
      },
    });
    const tools = composed.tools;
    // 阶段 9.7: the permission gate is ALWAYS installed — capability checks are
    // not optional. Default options grant everything (backwards compatible).
    const composedBeforeToolCall = composed.beforeToolCall;
    const contextTransformer = createContextTransformer({
      ...options.context,
      model: options.model,
      models: options.context?.models,
      summaryChat: options.context?.summaryChat,
      onEvent: (event) => recorder?.record(event),
      evidenceBase: path.join(".harness", "evidence", record.id),
    });
    const agent = createAgent({
      model: options.model,
      systemPrompt,
      tools,
      streamFn: options.streamFn,
      sessionId: record.id,
      beforeToolCall: composedBeforeToolCall,
      transformContext: contextTransformer,
    });
    // Checkpoint AFTER the trace sinks: a checkpoint may lag the log but never lead it.
    const checkpointWriter =
      database && recorder
        ? new CheckpointWriter(new CheckpointRepo(database), record.id, () => recorder.lastSeq)
        : undefined;
    const reporter = options.reporter ?? new ConsoleReporter();
    const dispatch = (event: AgentEvent): void => {
      reporter.onEvent(event);
      recorder?.onEvent(event);
      checkpointWriter?.onEvent(event);
      composed.limitEnforcer.onAgentEvent(event);
      faultController?.onEvent(event);
    };
    const unsubscribe = agent.subscribe(dispatch);

    let status: RunStatus = "running";
    let error: string | undefined;
    let messages: AgentMessage[] = [];
    const startedMs = Date.now();

    try {
      await agent.prompt(options.task);
      await agent.waitForIdle();
      messages = [...agent.state.messages];
      const last = lastAssistant(messages);
      if (last && (last.stopReason === "error" || last.errorMessage)) {
        status = "failed";
        error = last.errorMessage ?? `stopReason=${last.stopReason}`;
      } else if (last?.stopReason === "toolUse") {
        // 加固期 (P0): a dangling toolUse is NOT a completion — never report
        // "completed" when the model's last tool request was never answered.
        status = "failed";
        error = "run ended with an unanswered tool call (dangling toolUse)";
      } else {
        status = "completed";
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    } finally {
      // 阶段 9.8: a limit violation degrades the run to failed with the reason
      // attached, even when the model itself finished cleanly afterwards.
      if (limitViolation) {
        status = "failed";
        error = `run stopped by limit (${limitViolation.kind}): ${limitViolation.reason}`;
      }
      record.status = status;
      if (error !== undefined) record.error = error;
      record.finishedAt = new Date().toISOString();
      recorder?.runEnd(status, error, Date.now() - startedMs);
      unsubscribe();
      try {
        runRepo?.updateStatus(record);
      } catch (err) {
        // The run itself succeeded/failed already; a persistence failure here
        // must not mask that. Surface loudly, decide policy in 加固 (阶段 14).
        process.stderr.write(`[harness] failed to persist run status: ${err instanceof Error ? err.message : err}\n`);
      }
      // 向量补全触发点：run 结束后 fire-and-forget（宿主经 drainMemoryBackfill
      // 决定是否等待——CLI 在 reflect 之后 drain，长驻宿主可以不理会）。
      this.memoryBackfillContext = memoryIndex
        ? { store: memoryStore, index: memoryIndex, embedder: memoryEmbedder }
        : undefined;
      this.beginMemoryBackfill();
    }

    return { record, messages, usage: sumAgentUsage(messages), tracePath: traceFile };
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  list(): RunRecord[] {
    return [...this.runs.values()];
  }

  /** Interrupted runs (status=running in the durable store) — resume candidates. */
  listInterrupted(database?: string): RunRecord[] {
    const db = this.ensureDatabase(database);
    return db ? new RunRepo(db).getByStatus("running") : [];
  }

  /**
   * 阶段 6: rebuild a crashed run from trace + checkpoint, resolve every
   * unresolved tool call (rebuild / re-execute / synthesize error), then drive
   * the agent to completion on the SAME run id — trace seq continues, the
   * transcript and tool-call state machine are stitched back exactly where
   * the crash left them.
   */
  async resume(runId: string, options: ResumeOptions = {}): Promise<RunResult> {
    const faultSpec = parseFaultSpec(options.fault); // validates before anything is written
    const database = this.ensureDatabase(options.database);
    if (!database) throw new HarnessError("resume requires the SQLite database (do not pass database: false)");
    const traceDir = options.traceDir ?? path.join(harnessDataDir(process.cwd()), "traces");
    const traceFile = path.join(traceDir, `${runId}.jsonl`);

    // 加固期 (P0) zombie self-heal: the trace says the run FINISHED (run_end
    // landed, but the runs-row status write was lost to a crash or a
    // persistence failure). Backfill the row from the durable trace instead of
    // rejecting — resuming would append a SECOND run_end and permanently break
    // the run_start…run_end bracket that the reader validates.
    const runRepo = new RunRepo(database);
    const storedRow = runRepo.get(runId);
    if (!storedRow) throw new HarnessError(`run "${runId}" not found`);
    mkdirSync(traceDir, { recursive: true });
    if (storedRow.status === "running") {
      const lastStoredEvent = new TraceEventRepo(database).getByRun(runId).at(-1);
      if (lastStoredEvent?.type === "run_end") {
        const healed: RunRecord = {
          ...storedRow,
          status: lastStoredEvent.status === "failed" ? "failed" : "completed",
          finishedAt: lastStoredEvent.ts,
          error: lastStoredEvent.error,
        };
        runRepo.updateStatus(healed);
        this.runs.set(runId, healed);
        process.stderr.write(
          `[harness] zombie run ${runId}: trace already ends with run_end (${healed.status}) — backfilled runs.status, nothing to recover\n`,
        );
        return { record: healed, messages: [], tracePath: traceFile };
      }
    }
    // 阶段 13 (P1-2): the two sinks are written per-event (JSONL first, SQLite
    // second) — a kill between the writes leaves a JSONL tail SQLite never saw.
    // SQLite is the resume authority; reconcile the JSONL BEFORE rebuilding, or
    // duplicated seqs would permanently fail readTraceFile. The reconcile ALSO
    // backfills mid-log SQLite holes from the JSONL copy (加固期复核) — it must
    // run BEFORE loadCrashedRun so the recovered transcript sees them.
    const sqliteEvents = new TraceEventRepo(database).getByRun(runId);
    const reconciled = reconcileJsonlTrace(traceFile, sqliteEvents, (event) => {
      new TraceEventRepo(database).append(event);
    });
    if (reconciled.truncated > 0 || reconciled.rebuilt || reconciled.backfilled > 0) {
      process.stderr.write(
        `[harness] trace JSONL reconciled with SQLite (authoritative): dropped ${reconciled.truncated} event(s) (tail/partial), rebuilt=${reconciled.rebuilt}, backfilled=${reconciled.backfilled}\n`,
      );
    }
    // Phase-1 explore subagent: the resolved toolset MUST include explore so a
    // crashed subagent call re-executes on recovery — which orders deps before
    // loadCrashedRun. The model falls back to the stored row's spec (the
    // crashed record is not loaded yet); evidence keys on runId, identical to
    // record.id once the crashed record is rebuilt. audit closes over a bridge
    // that binds to the recorder once it exists — it only fires later.
    const auditBridge: { record: (event: HarnessAuditEvent) => void } = { record: () => {} };
    const model = options.model ?? resolveModel(storedRow.modelSpec);
    const startedMs = Date.now();
    // Toolset identity: the caller's explicit choice wins; otherwise the
    // toolset persisted on the run row (migration 012) is restored so a
    // crashed coding run does not resume against the demo default.
    const toolsetSpec = options.tools ?? storedRow.toolset;
    const limits: Required<RunLimits> = defaultLimitsFor(toolsetSpec, options.limits);
    let limitViolation: LimitViolation | undefined;
    const exploreDeps: ExploreToolDeps | undefined =
      toolsetSpec === "coding"
        ? {
            model,
            streamFn: options.streamFn,
            approval: options.approval,
            retryPolicy: options.retry,
            parentEvidenceDir: path.join(harnessDataDir(process.cwd()), "evidence", runId),
            charge: (usage) => composed.limitEnforcer.charge(usage),
            audit: (event) => auditBridge.record(event),
            summaryChat: options.context?.summaryChat,
          }
        : undefined;
    // Memory tool surface for the resumed segment — same default as run(),
    // same authoritative dir convention (dirname(database)/memory), and resume
    // is a startup too: reconcile before anything resolves tools. Tools are
    // created BEFORE loadCrashedRun/composeRuntime so an interrupted memory_read
    // re-resolves and executes through the SAME wrapper chain.
    const memoryDir =
      typeof options.database === "string"
        ? path.join(path.dirname(options.database), "memory")
        : path.join(path.dirname(defaultDbPath()), "memory");
    const memoryStore = new MemoryStore(memoryDir);
    const memoryEmbedder =
      (options.memory?.hybrid ?? true) ? (options.memory?.embedder ?? sharedEmbedder()) : undefined;
    const memoryIndex = new MemorySearchIndex(database);
    memoryIndex.reconcile(memoryStore);
    const memoryTools =
      (options.memory?.tools ?? toolsetSpec === "coding")
        ? createMemoryTools({
            store: memoryStore,
            index: memoryIndex,
            runId,
            embedder: memoryEmbedder ? () => memoryEmbedder : undefined,
          })
        : [];
    const resolvedTools = resolveTools(toolsetSpec, exploreDeps);
    const crashed = loadCrashedRun(database, runId, [...resolvedTools, ...memoryTools]);
    // 加固期第二轮: durable-record contradictions (checkpoint vs trace) and the
    // empty-ledger restart are surfaced loudly — never silently repaired.
    for (const note of crashed.degradations) process.stderr.write(`[harness] recovery: ${note}\n`);

    const record: RunRecord = { ...crashed.record, status: "running", finishedAt: undefined, error: undefined };
    this.runs.set(record.id, record);

    // 加固期 (P2): resume accepts its own fault spec — mid_recovery kills with
    // N calls already resolved; between_sinks fires inside the fan-out below.
    const faultController = faultSpec ? new FaultController(faultSpec) : undefined;
    const recorder = new TraceRecorder(record.id, [new JsonlTraceSink(traceFile), new TraceEventRepo(database)], {
      startSeq: crashed.lastSeq,
      onSinkBoundary: faultController ? (event) => faultController.onSinkBoundary(event) : undefined,
    });
    auditBridge.record = (event) => recorder.record(event);
    // 加固期第二轮: an empty ledger means the run was killed before ITS OWN
    // run_start (the restart path) — open the bracket here, or readTraceFile's
    // "first event must be run_start" invariant breaks. A normal resume
    // continues the existing bracket and must NOT re-emit run_start.
    if (crashed.lastSeq === 0) {
      recorder.runStart(
        record.task,
        record.modelSpec,
        faultSpec ? formatFaultSpec(faultSpec) : undefined,
        options.approval?.capabilities ?? ALL_CAPABILITIES,
      );
    }

    const composed = composeRuntime({
      tools: [...resolvedTools, ...memoryTools],
      faultSpec: undefined,
      evidenceDir: path.join(harnessDataDir(process.cwd()), "evidence", record.id),
      limits,
      retryPolicy: options.retry,
      approval: options.approval,
      audit: (event) => recorder.record(event),
      onLimitViolation: (violation) => {
        limitViolation = violation;
      },
    });
    const tools = composed.tools;

    // Resolve every unresolved tool call, auditing each decision into the trace.
    const synthetic: AgentMessage[] = [];
    let resolvedCalls = 0;
    for (const call of crashed.unresolved) {
      // 加固期 (P2) mid_recovery fault point: kill with N calls already
      // resolved — the crash lands between recovery decisions, the next resume
      // must pick the stitched state back up cleanly.
      if (resolvedCalls > 0) faultController?.onRecoveryStep(resolvedCalls);
      resolvedCalls++;
      const action = planRecovery(call);
      if (action.kind === "synthesize_error" || !call.tool) {
        const reason = call.tool
          ? action.kind === "synthesize_error"
            ? action.reason
            : ""
          : `tool "${call.toolName}" is not registered in this session`;
        recorder.record({
          type: "recovery_action",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          action: "synthesize_error",
          error: reason || undefined,
        });
        synthetic.push(toolResultMessage(call.toolCallId, call.toolName, [{ type: "text", text: reason }], true));
        continue;
      }
      recorder.record({
        type: "recovery_action",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        action: action.kind,
      });
      if (action.kind === "rebuild_result" && call.recordedResult) {
        synthetic.push(
          toolResultMessage(call.toolCallId, call.toolName, call.recordedResult.content, call.recordedResult.isError),
        );
        continue;
      }
      // reexecute: the execution genuinely happens now — record it as such, and
      // put it through the SAME gates as a live call. composed.beforeToolCall
      // already runs limits→permission IN ORDER; calling the limit enforcer
      // separately (加固期 fix) counted every recovered call twice.
      const gateDecision = await composed.beforeToolCall({
        toolCall: { id: call.toolCallId, name: call.toolName },
        args: call.args,
      });
      recorder.onEvent({
        type: "tool_execution_start",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.args,
      });
      if (gateDecision && gateDecision.block) {
        const reason = gateDecision.reason ?? "blocked before execution";
        recorder.onEvent({
          type: "tool_execution_end",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: { content: [{ type: "text", text: reason }], details: undefined },
          isError: true,
        });
        synthetic.push(toolResultMessage(call.toolCallId, call.toolName, [{ type: "text", text: reason }], true));
        continue;
      }
      const wrapped = tools.find((t) => t.name === call.toolName) ?? call.tool;
      try {
        const result = await wrapped.execute(call.toolCallId, call.args, undefined, undefined);
        recorder.onEvent({
          type: "tool_execution_end",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result,
          isError: false,
        });
        synthetic.push(toolResultMessage(call.toolCallId, call.toolName, result.content, false, result.details));
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        recorder.onEvent({
          type: "tool_execution_end",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: { content: [{ type: "text", text }], details: undefined },
          isError: true,
        });
        synthetic.push(toolResultMessage(call.toolCallId, call.toolName, [{ type: "text", text }], true));
      }
    }
    // 加固期 (P2) mid_recovery: the loop-end check — with a single unresolved
    // call the in-loop check never fires, but killing between "recovery done"
    // and "continuation prompt sent" is exactly the window worth covering.
    faultController?.onRecoveryStep(resolvedCalls);
    const transcript = [...crashed.messages];
    // The trace never contains the synthesized system message, so the stored
    // systemPrompt is the only faithful way to rebuild the agent.
    const resumeSystemPrompt =
      transcript[0]?.role === "system" ? "" : (crashed.record.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
    const agent = createAgent({
      model,
      systemPrompt: resumeSystemPrompt,
      tools,
      streamFn: options.streamFn,
      sessionId: record.id,
      messages: transcript,
      beforeToolCall: composed.beforeToolCall,
      // 加固期 (P0): the recovered transcript is the persisted prefix —
      // historyCount marks the boundary so the current segment's messages are
      // never touched by the tool reducer or the summary watermark.
      transformContext: createContextTransformer({
        ...options.context,
        model,
        models: options.context?.models,
        summaryChat: options.context?.summaryChat,
        historyCount: transcript.length,
        onEvent: (event) => recorder.record(event),
        evidenceBase: path.join(".harness", "evidence", record.id),
      }),
    });
    const checkpointWriter = new CheckpointWriter(new CheckpointRepo(database), record.id, () => recorder.lastSeq, {
      // transcript.length only (加固期第二轮): pi emits message_end for every
      // message passed to prompt() (agent-loop emits per initial message), so
      // counting the synthetic results here AS WELL double-counted them once
      // the prompt emission landed. The count must mirror "message_end events
      // seen so far" exactly — the checkpoint cross-check compares it to the
      // trace's message count.
      messages: transcript.length,
      toolCalls: [],
    });
    const reporter = options.reporter ?? new ConsoleReporter();
    const dispatch = (event: AgentEvent): void => {
      reporter.onEvent(event);
      recorder.onEvent(event);
      checkpointWriter.onEvent(event);
      // 加固期 (P1): the resumed segment is limit-enforced like a fresh run —
      // without this the turns / token / cost / consecutive-error fuses never
      // accumulate on the resume path (beforeToolCall counters still worked).
      composed.limitEnforcer.onAgentEvent(event);
      // 加固期 (P2): after_assistant_message also covers the resumed segment.
      faultController?.onEvent(event);
    };
    const unsubscribe = agent.subscribe(dispatch);

    let status: RunStatus = "running";
    let error: string | undefined;
    let messages: AgentMessage[] = [...transcript, ...synthetic];

    try {
      if (synthetic.length > 0) {
        await agent.prompt(synthetic);
        await agent.waitForIdle();
      } else if (!messages.some((m) => m.role === "assistant")) {
        // 加固期 (P2): a crash before ANY assistant response (e.g.
        // between_sinks landing on the user message) leaves a transcript with
        // no model output — the task itself still needs driving. Finalizing
        // here would be the false completion the dangling-toolUse guard
        // exists to prevent.
        // 加固期复核: the user message itself may already be persisted (a kill
        // after its message_end) — pi's continue() handles a transcript that
        // ends on a user message, so drive WITHOUT appending the task a second
        // time; only a genuinely empty transcript gets prompt(task).
        if (messages.some((m) => m.role === "user")) {
          await agent.continue();
        } else {
          await agent.prompt(crashed.record.task);
        }
        await agent.waitForIdle();
      } else if (messages.at(-1)?.role === "toolResult") {
        await agent.continue();
        await agent.waitForIdle();
      } else {
        // Transcript already ends complete (crash between the last message and
        // run_end) — nothing to drive, just finalize below.
      }
      messages = [...agent.state.messages];
      const last = lastAssistant(messages);
      if (last && (last.stopReason === "error" || last.errorMessage)) {
        status = "failed";
        error = last.errorMessage ?? `stopReason=${last.stopReason}`;
      } else if (last?.stopReason === "toolUse") {
        // 加固期 (P0): a dangling toolUse is NOT a completion — never report
        // "completed" when the model's last tool request was never answered.
        status = "failed";
        error = "run ended with an unanswered tool call (dangling toolUse)";
      } else {
        status = "completed";
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    } finally {
      // 阶段 9.8: a limit violation degrades the run to failed with the reason
      // attached, even when the model itself finished cleanly afterwards.
      if (limitViolation) {
        status = "failed";
        error = `run stopped by limit (${limitViolation.kind}): ${limitViolation.reason}`;
      }
      record.status = status;
      if (error !== undefined) record.error = error;
      record.finishedAt = new Date().toISOString();
      recorder.runEnd(status, error, Date.now() - startedMs);
      unsubscribe();
      try {
        runRepo.updateStatus(record);
      } catch (err) {
        process.stderr.write(
          `[harness] failed to persist resumed run status: ${err instanceof Error ? err.message : err}\n`,
        );
      }
      this.memoryBackfillContext = memoryIndex
        ? { store: memoryStore, index: memoryIndex, embedder: memoryEmbedder }
        : undefined;
      this.beginMemoryBackfill();
    }

    return { record, messages, usage: sumAgentUsage(messages), tracePath: traceFile };
  }

  /**
   * Run 结束后的记忆向量补全触发点：先对账一次（工具/反思在 run 中或
   * reflect 阶段写入的记忆由此进入投影），再查 pending；有 pending 且尚未
   * 在跑时才启动，fire-and-forget——补全自身带有限退避并把失败写进
   * search_meta/stderr。没有检索 index、hybrid 关闭、或全部向量都已就绪时
   * 是零成本 no-op。
   */
  private beginMemoryBackfill(): void {
    const ctx = this.memoryBackfillContext;
    if (this.memoryBackfill || !ctx) return;
    // hybrid 关闭 = 向量路不属于本 run 的 posture：哪怕有未建向量的记忆，
    // 也绝不启动注定失败的补全（此前 embedder 缺席时这里会带着 undefined
    // 一路走进 embedPassages，用 TypeError 烧完三次退避重试，CLI 还会在
    // drain 处白等约 10s）——零成本 no-op 的承诺由此兑现。
    if (!ctx.embedder) return;
    try {
      ctx.index.reconcile(ctx.store); // Markdown 为权威的投影兜底（增量同步的保险）
    } catch (err) {
      process.stderr.write(`[memory] pre-backfill reconcile failed: ${err instanceof Error ? err.message : err}\n`);
      return;
    }
    if (ctx.index.backfillPending(EMBEDDING_MODEL_ID) === 0) return;
    this.memoryBackfill = ctx.index.startBackfill(ctx.store, ctx.embedder, EMBEDDING_MODEL_ID).promise;
  }

  /**
   * 等待在途的记忆向量补全（没有则先重查一次 pending——reflect / 工具可能在
   * run 结束后才写入记忆）。短生命周期宿主（CLI）在 reflect 之后调用，让
   * 补全在进程退出前完成；返回是否真的等待了一次。
   */
  async drainMemoryBackfill(): Promise<boolean> {
    this.beginMemoryBackfill();
    const task = this.memoryBackfill;
    if (!task) return false;
    this.memoryBackfill = undefined;
    await task.catch(() => undefined); // 失败已进 search_meta / stderr
    return true;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
