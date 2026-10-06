export { HarnessError } from "./errors.js";
export { DEFAULT_SYSTEM_PROMPT, defaultModelSpec } from "./config.js";
export { getModelRegistry, listProviderIds, resolveModel } from "./providers.js";
export { createAgent, harnessStreamFn, type CreateAgentOptions } from "./runtime/agent-factory.js";
export {
  RunManager,
  type RunOptions,
  type ResumeOptions,
  type RunRecord,
  type RunResult,
  type RunSessionHandle,
  type RunStatus,
} from "./runtime/run-manager.js";
export { InteractiveSession, type CycleOutcome, type SessionPhase } from "./runtime/session.js";
export { ConsoleReporter, CollectingReporter, type RunReporter } from "./runtime/reporter.js";
export {
  createPermissionGate,
  defaultApproveFn,
  type ApprovalMode,
  type ApprovalOptions,
  type ApprovalRequest,
  type ApproveFn,
} from "./runtime/approval.js";
export {
  assessRisk,
  hasAllCapabilities,
  permissionsFor,
  ALL_CAPABILITIES,
  type Capability,
  type RiskAssessment,
  type RiskClass,
  type ToolPermissions,
} from "./runtime/permissions.js";
export {
  applyFaultToTools,
  FaultController,
  formatFaultSpec,
  parseFaultSpec,
  type FaultPoint,
  type FaultSpec,
} from "./execution/fault.js";
export {
  CheckpointWriter,
  type CheckpointState,
  type ToolCallState,
  type TrackedToolCall,
} from "./execution/checkpoint.js";
export { withEvidenceCapture } from "./runtime/tools/evidence.js";
export {
  assembleSystemPrompt,
  renderExperienceBlock,
  renderSkillBlock,
  type ExperienceEntry,
  type PromptSections,
  type SkillEntry,
} from "./context/assembler.js";
export { partitionMessages, blockStats, type Block } from "./context/blocks.js";
export {
  computeContextBudget,
  DEFAULT_BUDGET_OPTIONS,
  type BudgetOptions,
  type ContextBudget,
} from "./context/budget.js";
export {
  tokenCoefficient,
  tokenCoefficientFor,
  TOKEN_COEFFICIENTS,
  DEFAULT_TOKEN_COEFFICIENT,
  estimateContextTokens,
  estimateMessagesTokens,
  estimateMessageTokens,
  type ContextUsageEstimate,
} from "./context/tokens.js";
export {
  reduceToolResults,
  compactionMarker,
  jsonArraySemanticTrim,
  type SemanticTrimmer,
  type ToolReducerOptions,
  type ToolReduction,
} from "./context/reducers/tool.js";
export {
  summaryCutoffBlockIndex,
  countUnsummarizedConversationBlocks,
  coveredBoundaryIndex,
  replaceCoveredPrefix,
  advanceWatermark,
  buildSummaryCandidate,
  type SummaryWatermark,
} from "./context/reducers/conversation.js";
export {
  generateRollingSummary,
  renderSummaryText,
  validateSummary,
  summaryCaps,
  serializeMaterial,
  SummaryGenerationError,
  SUMMARY_SYSTEM_PROMPT,
  BIG_FOLD_SPAN_TOKENS,
  type RollingConversationSummary,
  type SummaryCaps,
} from "./context/summarizer.js";
export { createContextTransformer, type ContextManagementOptions } from "./context/compaction.js";
export { type ContextDecision, type PrefixDecisionKind } from "./context/decision.js";
export {
  buildRunDigest,
  shouldReflect,
  parseReflectionDecision,
  reflectRunById,
  REFLECTION_SCHEMA,
  REFLECTION_SYSTEM_PROMPT,
  type GateDecision,
  type ReflectOptions,
  type ReflectOutcome,
  type ReflectionAction,
  type ReflectionCandidate,
  type ReflectionDecision,
  type RunDigest,
} from "./memory/reflection.js";
export { createMemoryTools, type MemoryToolDeps } from "./memory/tools.js";
export { MAX_ACTIVE_MEMORIES, MemoryConflictError, MemoryStore } from "./memory/store.js";
export { MemorySearchIndex, MIN_VECTOR_SIMILARITY, RRF_K, type MemoryHit, type SearchMode } from "./memory/search.js";
export { chunkMemory, parseMemory, serializeMemory, type MemoryRecord, type MemoryStatus } from "./memory/model.js";
export { parseCore, renderCore, upsertCoreEntry, type CoreEntry, type CoreFile } from "./memory/core.js";
export {
  completeStructured,
  defaultChat,
  type ChatFn,
  type ChatTurn,
  type SchemaTool,
  type StructuredOptions,
  type StructuredResult,
} from "./llm/structured.js";
export { isTransientError, withRetry, type RetryPolicy } from "./runtime/retry.js";
export { DEFAULT_RUN_LIMITS, LimitEnforcer, type LimitViolation, type RunLimits } from "./runtime/limits.js";
export { withToolTimeout } from "./runtime/tools/timeout.js";
export {
  cosineSimilarity,
  localEmbedder,
  rrfCombine,
  sharedEmbedder,
  E5_PREFIXES,
  EMBEDDING_MODEL_ID,
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
export {
  createExploreTool,
  EXPLORE_CHILD_TOOLS,
  type ExploreToolDeps,
  type ExploreDetails,
} from "./runtime/tools/explore.js";
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
