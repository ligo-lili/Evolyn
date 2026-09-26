import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TraceEvent } from "./schema.js";

export interface ReplayToolCall {
  toolCallId: string;
  toolName: string;
  state: "planned" | "executing" | "executed";
  args?: unknown;
  /** toolResult message recorded in the log. */
  resolved: boolean;
  isError?: boolean;
}

export interface ReplayState {
  runId?: string;
  /** seq of the last consumed event (0 = nothing consumed). */
  seq: number;
  consumed: number;
  lastEvent?: TraceEvent;
  task?: string;
  modelSpec?: string;
  fault?: string;
  runEnd?: { status: string; error?: string; durationMs: number };
  /** Transcript rebuilt from message_end events — no system message (pi never emits one). */
  messages: AgentMessage[];
  /** seq of each message in `messages`, index-aligned. */
  messageSeqs: number[];
  /** Every tool call seen, with its latest state machine position. */
  calls: Map<string, ReplayToolCall>;
  /** approval / recovery_action / compaction audit events seen so far. */
  audits: TraceEvent[];
}

/**
 * Offline re-driver of a run's event log: consume events one by one and
 * rebuild the exact state the run was in at any point — transcript, tool-call
 * state machine, audit trail — without touching a model or executing anything.
 * This is the "replay" half of Demo 2; the recovery module (阶段 6) shares its
 * state-machine semantics, so the two implementations cross-check each other.
 */
export class ReplayMachine {
  private readonly _state: ReplayState = {
    seq: 0,
    consumed: 0,
    messages: [],
    messageSeqs: [],
    calls: new Map(),
    audits: [],
  };

  static replay(events: readonly TraceEvent[]): ReplayMachine {
    const machine = new ReplayMachine();
    for (const event of events) machine.consume(event);
    return machine;
  }

  /** State at (and including) seq — events with a larger seq are ignored. */
  static at(events: readonly TraceEvent[], seq: number): ReplayMachine {
    return ReplayMachine.replay(events.filter((e) => e.seq <= seq));
  }

  consume(event: TraceEvent): void {
    const s = this._state;
    switch (event.type) {
      case "run_start":
        s.runId = event.runId;
        s.task = event.task;
        s.modelSpec = event.modelSpec;
        s.fault = event.fault;
        break;
      case "run_end":
        s.runEnd = { status: event.status, error: event.error, durationMs: event.durationMs };
        break;
      case "message_end": {
        const m = event.message;
        s.messages.push(m);
        s.messageSeqs.push(event.seq);
        if (m.role === "assistant") {
          for (const block of m.content) {
            if (block.type === "toolCall" && !s.calls.has(block.id)) {
              s.calls.set(block.id, {
                toolCallId: block.id,
                toolName: block.name,
                state: "planned",
                args: block.arguments,
                resolved: false,
              });
            }
          }
        } else if (m.role === "toolResult") {
          const call = s.calls.get(m.toolCallId);
          if (call) {
            call.resolved = true;
            call.isError = m.isError;
            if (call.state === "planned") call.state = "executed";
          }
        }
        break;
      }
      case "tool_execution_start": {
        const call = s.calls.get(event.toolCallId);
        if (call) {
          call.state = "executing";
          call.args = event.args;
        }
        break;
      }
      case "tool_execution_end": {
        const call = s.calls.get(event.toolCallId);
        if (call) {
          call.state = "executed";
          call.isError = event.isError;
        }
        break;
      }
      case "approval":
      case "recovery_action":
      case "compaction":
        s.audits.push(event);
        break;
      default:
        break;
    }
    s.seq = event.seq;
    s.consumed++;
    s.lastEvent = event;
  }

  get state(): ReplayState {
    return this._state;
  }

  /** Tool calls whose toolResult never made it into the log at this position. */
  pendingCalls(): ReplayToolCall[] {
    return [...this.state.calls.values()].filter((c) => !c.resolved);
  }
}

/**
 * "为什么走到当前状态" — rebuild the state at a position and derive the
 * human-readable causal chain: what the log ends with, which tool calls are
 * in flight and what recovery would do with them, the last assistant
 * stopReason/error, and the recent audit decisions.
 */
export function explain(
  events: readonly TraceEvent[],
  untilSeq?: number,
): { state: ReplayState; why: string[] } {
  const machine = untilSeq === undefined ? ReplayMachine.replay(events) : ReplayMachine.at(events, untilSeq);
  const st = machine.state;
  const why: string[] = [];

  if (st.runEnd) {
    why.push(
      `run 已结束：status=${st.runEnd.status}` +
        (st.runEnd.error ? `，error="${st.runEnd.error}"` : "") +
        `，耗时 ${(st.runEnd.durationMs / 1000).toFixed(1)}s`,
    );
  } else {
    why.push(`日志停在 seq ${st.seq}（${st.lastEvent?.type ?? "无事件"}），没有 run_end —— run 中断，可 resume 恢复`);
  }

  for (const call of machine.pendingCalls()) {
    why.push(
      call.state === "executing"
        ? `工具 ${call.toolName}(${call.toolCallId}) 正在执行——崩溃时结果未知；恢复时按 replay 安全性重执行或合成"结果未知"`
        : `工具 ${call.toolName}(${call.toolCallId}) 已被请求但尚未开始执行；恢复时将直接执行`,
    );
  }
  if (!st.runEnd && machine.pendingCalls().length === 0) {
    why.push("没有在途工具调用——中断点落在消息边界之间");
  }

  for (let i = st.messages.length - 1; i >= 0; i--) {
    const m = st.messages[i];
    if (m?.role === "assistant") {
      why.push(
        `最近的 assistant 消息：stopReason=${m.stopReason}` + (m.errorMessage ? `，error="${m.errorMessage}"` : ""),
      );
      break;
    }
  }

  for (const audit of st.audits.slice(-3)) {
    if (audit.type === "approval") why.push(`审批：${audit.decision} ${audit.toolName}${audit.reason ? ` (${audit.reason})` : ""}`);
    else if (audit.type === "recovery_action") why.push(`恢复动作：${audit.action} ${audit.toolName}`);
    else if (audit.type === "compaction") why.push(`上下文已压缩（seq ${audit.seq}，压缩前 ${audit.tokensBefore} tokens）——模型看到的是摘要 + 近期消息`);
  }

  return { state: st, why };
}
