import type { AgentEvent, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { HarnessAuditEvent } from "../trace/schema.js";

/**
 * 阶段 9.8 runaway guards: turn/tool-call budgets, repeated identical calls,
 * cost ceiling and consecutive-failure strike-out. The enforcer observes agent
 * events (to count turns/cost/errors) and sits in front of the permission gate
 * in beforeToolCall; a violation denies the call with terminate:true so the
 * loop stops cleanly, audits a `limit_exceeded` event, and flags the run.
 */

export interface RunLimits {
  maxTurns?: number;
  maxToolCalls?: number;
  /** Same tool + same arguments, counted per run. */
  maxRepeatedToolCalls?: number;
  maxCostUsd?: number;
  /**
   * Cumulative total tokens across the run (加固期). The cost fuse is blind on
   * models that report cost.total = 0 (e.g. DashScope qwen registrations), so
   * the token count is the reliable runaway backstop.
   */
  maxTotalTokens?: number;
  /** Per-execution timeout in ms. */
  toolTimeoutMs?: number;
}

export const DEFAULT_RUN_LIMITS: Required<RunLimits> = {
  maxTurns: 40,
  maxToolCalls: 120,
  maxRepeatedToolCalls: 3,
  maxCostUsd: Number.POSITIVE_INFINITY,
  maxTotalTokens: 2_000_000,
  toolTimeoutMs: 120_000,
};

export interface LimitViolation {
  kind: "turns" | "tool_calls" | "repeat" | "cost" | "tokens" | "consecutive_errors";
  reason: string;
}

function stableHash(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === "string" && v.length > 500 ? v.slice(0, 500) : v));
}

export class LimitEnforcer {
  private turns = 0;
  private toolCalls = 0;
  private costUsd = 0;
  private totalTokens = 0;
  private consecutiveErrors = 0;
  private readonly callHashes = new Map<string, number>();

  constructor(
    private readonly limits: Required<RunLimits>,
    private readonly audit: (event: HarnessAuditEvent) => void,
    private readonly onViolation: (violation: LimitViolation) => void,
  ) {}

  onAgentEvent(event: AgentEvent): void {
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.turns++;
      this.charge(event.message.usage);
      this.consecutiveErrors = 0; // a fresh assistant turn resets the strike counter
    } else if (event.type === "tool_execution_end") {
      this.consecutiveErrors = event.isError ? this.consecutiveErrors + 1 : 0;
    }
  }

  /**
   * Subagent (and other internal LLM work) usage lands on the SAME money
   * fuses (cost / total tokens) as the parent's own turns — an unaccounted
   * subagent would bypass the runaway backstop — but never touches the turn
   * budget or the consecutive-error strike counter.
   */
  charge(usage: Usage): void {
    this.costUsd += usage.cost.total;
    this.totalTokens += usage.totalTokens;
  }

  /**
   * Interactive sessions (src/runtime/session.ts) call this on every user
   * submit: turns / tool-calls / repeats / error-strikes measure ONE prompt
   * cycle, while the money fuses (cost / total tokens) stay cumulative for
   * the whole session — a long conversation must not trip the turn budget,
   * but runaway spend must still be capped.
   */
  resetCycle(): void {
    this.turns = 0;
    this.toolCalls = 0;
    this.consecutiveErrors = 0;
    this.callHashes.clear();
  }

  beforeToolCall(toolName: string, args: unknown): BeforeToolCallResult | undefined {
    const deny = (kind: LimitViolation["kind"], reason: string): BeforeToolCallResult => {
      this.audit({ type: "limit_exceeded", kind, reason });
      this.onViolation({ kind, reason });
      return { block: true, reason, terminate: true };
    };

    if (this.turns > this.limits.maxTurns) {
      return deny("turns", `turn budget exhausted (${this.limits.maxTurns} turns)`);
    }
    this.toolCalls++;
    if (this.toolCalls > this.limits.maxToolCalls) {
      return deny("tool_calls", `tool-call budget exhausted (${this.limits.maxToolCalls} calls)`);
    }
    if (this.costUsd > this.limits.maxCostUsd) {
      return deny(
        "cost",
        `cost budget exhausted ($${this.costUsd.toFixed(4)} > $${this.limits.maxCostUsd.toFixed(4)})`,
      );
    }
    if (this.totalTokens > this.limits.maxTotalTokens) {
      return deny("tokens", `token budget exhausted (${this.totalTokens} > ${this.limits.maxTotalTokens} tokens)`);
    }
    if (this.consecutiveErrors >= 5) {
      return deny("consecutive_errors", `${this.consecutiveErrors} consecutive tool failures — degrading`);
    }
    const hash = `${toolName}|${stableHash(args)}`;
    const repeats = (this.callHashes.get(hash) ?? 0) + 1;
    this.callHashes.set(hash, repeats);
    if (repeats > this.limits.maxRepeatedToolCalls) {
      return deny(
        "repeat",
        `tool ${toolName} called with identical arguments ${repeats} times (limit ${this.limits.maxRepeatedToolCalls})`,
      );
    }
    return undefined;
  }
}
