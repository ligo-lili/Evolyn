export { HarnessError } from "./errors.js";
export { DEFAULT_SYSTEM_PROMPT, defaultModelSpec } from "./config.js";
export { getModelRegistry, listProviderIds, resolveModel } from "./providers.js";
export { createAgent, harnessStreamFn, type CreateAgentOptions } from "./runtime/agent-factory.js";
export { RunManager, type RunOptions, type ResumeOptions, type RunRecord, type RunResult, type RunStatus } from "./runtime/run-manager.js";
export { ConsoleReporter, CollectingReporter, type RunReporter } from "./runtime/reporter.js";
export { createApprovalHook, DEFAULT_APPROVAL_POLICY, type ApprovalMode, type ApprovalOptions, type ApprovalPolicy } from "./runtime/approval.js";
export { applyFaultToTools, FaultController, formatFaultSpec, parseFaultSpec, type FaultPoint, type FaultSpec } from "./execution/fault.js";
export { CheckpointWriter, type CheckpointState, type ToolCallState, type TrackedToolCall } from "./execution/checkpoint.js";
export { withEvidenceCapture } from "./runtime/tools/evidence.js";
export {
  assembleSystemPrompt,
  renderExperienceBlock,
  renderSkillBlock,
  type ExperienceEntry,
  type PromptSections,
  type SkillEntry,
} from "./context/assembler.js";
export { createContextTransformer, findCutIndex, type CompactionOptions } from "./context/compaction.js";
export {
  buildRunDigest,
  distillExperience,
  distillRunById,
  fallbackDraft,
  parseExperienceDraft,
  type CompleteFn,
  type DistillOptions,
  type DistillOutcome,
  type ExperienceDraft,
  type RunDigest,
} from "./memory/distiller.js";
export { MemoryStore } from "./memory/store.js";
export { MemorySearchIndex, passageText } from "./memory/search.js";
export { parseMemory, serializeMemory, type MemoryRecord } from "./memory/model.js";
export {
  cosineSimilarity,
  localEmbedder,
  rrfCombine,
  E5_PREFIXES,
  type LocalEmbedderOptions,
  type PassageEmbedder,
} from "./memory/embedding.js";
export {
  loadCrashedRun,
  planRecovery,
  toolResultMessage,
  type CrashedRun,
  type RecoveryAction,
  type UnresolvedState,
  type UnresolvedToolCall,
} from "./execution/recovery.js";
export { DEMO_TOOLS, type AnyAgentTool } from "./runtime/tools/index.js";
export { harnessDataDir, resolveWorkspacePath, tracesDir } from "./runtime/paths.js";
export { TRACE_SCHEMA_VERSION, type RunLifecycleEvent, type TraceEnvelope, type TraceEvent } from "./trace/schema.js";
export { TraceRecorder, JsonlTraceSink, type TraceSink } from "./trace/recorder.js";
export { listTraces, readTraceFile, type ParsedTrace, type TraceFileInfo } from "./trace/read.js";
export { renderTimeline, renderSummary, renderReplay } from "./trace/show.js";
export { ReplayMachine, explain, type ReplayState, type ReplayToolCall } from "./trace/replay.js";
export { summarize, collectErrors, type TraceSummary, type ToolCallStat } from "./trace/query.js";
export { openDatabase, defaultDbPath } from "./storage/db.js";
export { MIGRATIONS, migrate } from "./storage/migrations.js";
export { RunRepo } from "./storage/repos/runs.js";
export { TraceEventRepo } from "./storage/repos/trace-events.js";
export { CheckpointRepo, type CheckpointRow } from "./storage/repos/checkpoints.js";
