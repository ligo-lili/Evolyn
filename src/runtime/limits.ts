import type { AgentEvent, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
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
  /** Per-execution timeout in ms. */
  toolTimeoutMs?: number;
}

export const DEFAULT_RUN_LIMITS: Required<RunLimits> = {
  maxTurns: 40,
  maxToolCalls: 120,
  maxRepeatedToolCalls: 3,
  maxCostUsd: Number.POSITIVE_INFINITY,
  toolTimeoutMs: 120_000,
};

export interface LimitViolation {
  kind: "turns" | "tool_calls" | "repeat" | "cost" | "consecutive_errors";
  reason: string;
}

function stableHash(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === "string" && v.length > 500 ? v.slice(0, 500) : v));
}

export class LimitEnforcer {
  private turns = 0;
  private toolCalls = 0;
  private costUsd = 0;
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
      this.costUsd += event.message.usage.cost.total;
      this.consecutiveErrors = 0; // a fresh assistant turn resets the strike counter
    } else if (event.type === "tool_execution_end") {
      this.consecutiveErrors = event.isError ? this.consecutiveErrors + 1 : 0;
    }
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
