import type { TraceEvent } from "./schema.js";

export interface ToolCallStat {
  toolName: string;
  calls: number;
  errors: number;
}

export interface TraceSummary {
  runId: string;
  task: string;
  modelSpec: string;
  /** Absent when the log has no run_end (interrupted run). */
  status?: string;
  durationMs?: number;
  interrupted: boolean;
  fault?: string;
  assistantTurns: number;
  toolCalls: ToolCallStat[];
  tokens: { input: number; output: number; total: number; cost: number };
  errorCount: number;
  permissionDenials: number;
  recoveryActions: number;
  eventCount: number;
}

/** Aggregate answer to "这个 run 里发生了什么" — works on finished and interrupted runs alike. */
export function summarize(events: readonly TraceEvent[]): TraceSummary {
  const summary: TraceSummary = {
    runId: "",
    task: "",
    modelSpec: "",
    interrupted: true,
    assistantTurns: 0,
    toolCalls: [],
    tokens: { input: 0, output: 0, total: 0, cost: 0 },
    errorCount: 0,
    permissionDenials: 0,
    recoveryActions: 0,
    eventCount: events.length,
  };
  const stats = new Map<string, ToolCallStat>();
  for (const event of events) {
    switch (event.type) {
      case "run_start":
        summary.runId = event.runId;
        summary.task = event.task;
        summary.modelSpec = event.modelSpec;
        summary.fault = event.fault;
        break;
      case "run_end":
        summary.status = event.status;
        summary.durationMs = event.durationMs;
        summary.interrupted = false;
        break;
      case "message_end": {
        const m = event.message;
        if (m.role === "assistant") {
          summary.assistantTurns++;
          // 加固期复核: usage (and cost.total) can be missing on messages
          // from providers without pricing — NaN would poison the summary and
          // JSON.stringify would silently emit null.
          const usage = m.usage ?? { input: 0, output: 0, totalTokens: 0 };
          summary.tokens.input += usage.input ?? 0;
          summary.tokens.output += usage.output ?? 0;
          summary.tokens.total += usage.totalTokens ?? 0;
          summary.tokens.cost += usage.cost?.total ?? 0;
          if (m.errorMessage) summary.errorCount++;
        } else if (m.role === "toolResult") {
          // Authoritative call stats: every call — real execution OR recovery-
          // synthesized — ends with exactly one toolResult message, whereas
          // tool_execution_end only exists for executions that finished.
          const stat = stats.get(m.toolName) ?? { toolName: m.toolName, calls: 0, errors: 0 };
          stat.calls++;
          if (m.isError) stat.errors++;
          stats.set(m.toolName, stat);
          if (m.isError) summary.errorCount++;
        }
        break;
      }
      case "tool_execution_end": {
        if (event.isError) summary.errorCount++;
        break;
      }
      case "permission":
        if (event.decision === "deny") summary.permissionDenials++;
        break;
      case "recovery_action":
        summary.recoveryActions++;
        break;
      default:
        break;
    }
  }
  summary.toolCalls = [...stats.values()];
  return summary;
}

/** Every error-bearing event: failed tool executions, error toolResults, assistant errors. */
export function collectErrors(events: readonly TraceEvent[]): TraceEvent[] {
  return events.filter(
    (e) =>
      (e.type === "tool_execution_end" && e.isError) ||
      (e.type === "message_end" &&
        ((e.message.role === "toolResult" && e.message.isError) ||
          (e.message.role === "assistant" && Boolean(e.message.errorMessage)))),
  );
}
