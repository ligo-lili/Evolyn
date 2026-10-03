import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { applyFaultToTools, type FaultSpec } from "../execution/fault.js";
import type { HarnessAuditEvent } from "../trace/schema.js";
import { createPermissionGate, type ApprovalOptions, type Gate } from "./approval.js";
import { LimitEnforcer, type LimitViolation, type RunLimits } from "./limits.js";
import { withRetry, type RetryPolicy } from "./retry.js";
import { withToolTimeout } from "./tools/timeout.js";
import { withEvidenceCapture } from "./tools/evidence.js";
import { withPathFence } from "./tools/fence.js";
import type { AnyAgentTool } from "./tools/index.js";

/**
 * 阶段 13 (P1-3): the ONE place where tools get wrapped (fault → evidence →
 * timeout → retry) and the beforeToolCall chain is composed (limits →
 * permission gate). run() and resume() MUST share this — a resume executing
 * recovered tools outside the chain would run real shell commands in the
 * workspace without permission checks or audit (coding scenario: unacceptable).
 *
 * The explore subagent (runtime/tools/explore.ts) reuses it as "run-lite":
 * a restricted readonly toolset, its own (tighter) limits and its own
 * enforcer — a child violation ends the SUBAGENT, not the parent run.
 */
export function composeRuntime(input: {
  tools: AnyAgentTool[];
  faultSpec: FaultSpec | undefined;
  evidenceDir: string;
  limits: Required<RunLimits>;
  retryPolicy: RetryPolicy | undefined;
  approval: ApprovalOptions | undefined;
  audit: (event: HarnessAuditEvent) => void;
  onLimitViolation: (violation: LimitViolation) => void;
}): {
  tools: AnyAgentTool[];
  beforeToolCall: Gate;
  limitEnforcer: LimitEnforcer;
} {
  const tools = withRetry(
    withToolTimeout(
      withEvidenceCapture(
        // 加固期 (P0): path fence OUTSIDE the fault wrapper — every execution
        // (live or fault-injected) checks path-like args against the workspace
        // root, lexically AND through symlinks.
        withPathFence(applyFaultToTools(input.tools, input.faultSpec)),
        input.evidenceDir,
      ),
      input.limits.toolTimeoutMs,
    ),
    { policy: input.retryPolicy, audit: input.audit },
  );
  const permissionGate = createPermissionGate(input.approval, input.audit);
  const limitEnforcer = new LimitEnforcer(input.limits, input.audit, input.onLimitViolation);
  const beforeToolCall: Gate = async (context) => {
    const violation = limitEnforcer.beforeToolCall(context.toolCall.name, context.args);
    if (violation) return violation;
    return permissionGate(context);
  };
  return { tools, beforeToolCall, limitEnforcer };
}

/**
 * Sum the assistant usage across a transcript (run result & subagent
 * accounting). pi-agent-core has an internal `addUsage` under
 * harness/utils/usage, but its exports map does not expose it — this shim
 * exists until (unless) pi makes that public; the moment it does, this folds
 * into `messages.reduce((u, m) => ...)`.
 */
export function sumAgentUsage(messages: readonly AgentMessage[]): Usage | undefined {
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
