import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_SYSTEM_PROMPT } from "../config.js";
import { HarnessError } from "../errors.js";
import { resolveModel } from "../providers.js";
import { openDatabase, defaultDbPath } from "../storage/db.js";
import { RunRepo } from "../storage/repos/runs.js";
import { TraceEventRepo } from "../storage/repos/trace-events.js";
import { CheckpointRepo } from "../storage/repos/checkpoints.js";
import { CheckpointWriter } from "../execution/checkpoint.js";
import { loadCrashedRun, planRecovery, toolResultMessage } from "../execution/recovery.js";
import { createContextTransformer } from "../context/compaction.js";
import type { CompactionSettings } from "@earendil-works/pi-agent-core";
import { TraceRecorder, JsonlTraceSink, type TraceSink } from "../trace/recorder.js";
import { applyFaultToTools, FaultController, formatFaultSpec, parseFaultSpec } from "../execution/fault.js";
import { createApprovalHook, type ApprovalOptions } from "./approval.js";
import { harnessDataDir } from "./paths.js";
import { createAgent } from "./agent-factory.js";
import { ConsoleReporter, type RunReporter } from "./reporter.js";
import { DEMO_TOOLS, type AnyAgentTool } from "./tools/index.js";

export type RunStatus = "running" | "completed" | "failed";

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
  tools?: AnyAgentTool[];
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
  /** Context compaction overrides; defaults to pi's threshold math on the run's model. */
  compaction?: {
    settings?: Partial<CompactionSettings>;
    /** Injectable summarizer for tests; default calls models.completeSimple. */
    summaryFn?: (prefix: readonly AgentMessage[]) => Promise<string>;
  };
}

export interface ResumeOptions {
  /** Model for the resumed agent; defaults to resolving the run's model_spec. */
  model?: Model<Api>;
  tools?: AnyAgentTool[];
  streamFn?: StreamFn;
  reporter?: RunReporter;
  database?: string | false;
  traceDir?: string;
  /** Context compaction overrides for the resumed agent. */
  compaction?: {
    settings?: Partial<CompactionSettings>;
    summaryFn?: (prefix: readonly AgentMessage[]) => Promise<string>;
  };
}

function sumUsage(messages: readonly AgentMessage[]): Usage | undefined {
  let total: Usage | undefined;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const u = m.usage;
    if (!total) {
      total = { ...u, cost: { ...u.cost } };
      continue;
    }
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead;
    total.cacheWrite += u.cacheWrite;
    total.totalTokens += u.totalTokens;
    total.cost.input += u.cost.input;
    total.cost.output += u.cost.output;
    total.cost.cacheRead += u.cost.cacheRead;
    total.cost.cacheWrite += u.cost.cacheWrite;
    total.cost.total += u.cost.total;
  }
  return total;
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

  private ensureDatabase(spec: string | false | undefined): DatabaseSync | undefined {
    if (spec === false) return undefined;
    this.db ??= openDatabase(spec ?? defaultDbPath());
    return this.db;
  }

  async run(options: RunOptions): Promise<RunResult> {
    const faultSpec = parseFaultSpec(options.fault); // validates before anything is written
    const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const record: RunRecord = {
      id: randomUUID(),
      task: options.task,
      modelSpec: `${options.model.provider}/${options.model.id}`,
      status: "running",
      startedAt: new Date().toISOString(),
      systemPrompt,
    };
    this.runs.set(record.id, record);

    const database = this.ensureDatabase(options.database);
    const runRepo = database ? new RunRepo(database) : undefined;
    runRepo?.insert(record);

    const traceEnabled = options.trace !== false;
    let traceFile: string | undefined;
    let recorder: TraceRecorder | undefined;
    if (traceEnabled) {
      const traceDir = options.traceDir ?? path.join(harnessDataDir(process.cwd()), "traces");
      mkdirSync(traceDir, { recursive: true });
      traceFile = path.join(traceDir, `${record.id}.jsonl`);
      const sinks: TraceSink[] = [new JsonlTraceSink(traceFile)];
      if (database) sinks.push(new TraceEventRepo(database));
      recorder = new TraceRecorder(record.id, sinks);
      recorder.runStart(record.task, record.modelSpec, faultSpec ? formatFaultSpec(faultSpec) : undefined);
    }

    const tools = applyFaultToTools(options.tools ?? DEMO_TOOLS, faultSpec);
    const approvalHook = options.approval ? createApprovalHook(options.approval, (event) => recorder?.record(event)) : undefined;
    const contextTransformer = createContextTransformer({
      contextWindow: options.model.contextWindow,
      model: options.model,
      settings: options.compaction?.settings,
      summaryFn: options.compaction?.summaryFn,
      onEvent: (event) => recorder?.record(event),
    });
    const agent = createAgent({
      model: options.model,
      systemPrompt,
      tools,
      streamFn: options.streamFn,
      sessionId: record.id,
      beforeToolCall: approvalHook,
      transformContext: contextTransformer,
    });
    const faultController = faultSpec ? new FaultController(faultSpec) : undefined;
    // Checkpoint AFTER the trace sinks: a checkpoint may lag the log but never lead it.
    const checkpointWriter =
      database && recorder ? new CheckpointWriter(new CheckpointRepo(database), record.id, () => recorder.lastSeq) : undefined;
    const reporter = options.reporter ?? new ConsoleReporter();
    const dispatch = (event: AgentEvent): void => {
      reporter.onEvent(event);
      recorder?.onEvent(event);
      checkpointWriter?.onEvent(event);
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
      } else {
        status = "completed";
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    } finally {
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
    }

    return { record, messages, usage: sumUsage(messages), tracePath: traceFile };
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
    const database = this.ensureDatabase(options.database);
    if (!database) throw new HarnessError("resume requires the SQLite database (do not pass database: false)");
    const tools = options.tools ?? DEMO_TOOLS;
    const crashed = loadCrashedRun(database, runId, tools);

    const record: RunRecord = { ...crashed.record, status: "running", finishedAt: undefined, error: undefined };
    this.runs.set(record.id, record);
    const runRepo = new RunRepo(database);

    const traceDir = options.traceDir ?? path.join(harnessDataDir(process.cwd()), "traces");
    mkdirSync(traceDir, { recursive: true });
    const traceFile = path.join(traceDir, `${record.id}.jsonl`);
    const recorder = new TraceRecorder(record.id, [new JsonlTraceSink(traceFile), new TraceEventRepo(database)], {
      startSeq: crashed.lastSeq,
    });

    const model = options.model ?? resolveModel(crashed.record.modelSpec);
    const startedMs = Date.now();

    // Resolve every unresolved tool call, auditing each decision into the trace.
    const synthetic: AgentMessage[] = [];
    for (const call of crashed.unresolved) {
      const action = planRecovery(call);
      if (action.kind === "synthesize_error" || !call.tool) {
        const reason = call.tool ? action.kind === "synthesize_error" ? action.reason : "" : `tool "${call.toolName}" is not registered in this session`;
        recorder.record({ type: "recovery_action", toolCallId: call.toolCallId, toolName: call.toolName, action: "synthesize_error", error: reason || undefined });
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
      // reexecute: the execution genuinely happens now — record it as such.
      recorder.onEvent({ type: "tool_execution_start", toolCallId: call.toolCallId, toolName: call.toolName, args: call.args });
      try {
        const result = await call.tool.execute(call.toolCallId, call.args, undefined, undefined);
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
      transformContext: createContextTransformer({
        contextWindow: model.contextWindow,
        model,
        summaryFn: options.compaction?.summaryFn,
        onEvent: (event) => recorder.record(event),
      }),
    });
    const checkpointWriter = new CheckpointWriter(new CheckpointRepo(database), record.id, () => recorder.lastSeq, {
      messages: transcript.length + synthetic.length,
      toolCalls: [],
    });
    const reporter = options.reporter ?? new ConsoleReporter();
    const dispatch = (event: AgentEvent): void => {
      reporter.onEvent(event);
      recorder.onEvent(event);
      checkpointWriter.onEvent(event);
    };
    const unsubscribe = agent.subscribe(dispatch);

    let status: RunStatus = "running";
    let error: string | undefined;
    let messages: AgentMessage[] = [...transcript, ...synthetic];

    try {
      if (synthetic.length > 0) {
        await agent.prompt(synthetic);
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
      } else {
        status = "completed";
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    } finally {
      record.status = status;
      if (error !== undefined) record.error = error;
      record.finishedAt = new Date().toISOString();
      recorder.runEnd(status, error, Date.now() - startedMs);
      unsubscribe();
      try {
        runRepo.updateStatus(record);
      } catch (err) {
        process.stderr.write(`[harness] failed to persist resumed run status: ${err instanceof Error ? err.message : err}\n`);
      }
    }

    return { record, messages, usage: sumUsage(messages), tracePath: traceFile };
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
