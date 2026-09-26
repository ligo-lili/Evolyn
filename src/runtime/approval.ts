import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { HarnessAuditEvent } from "../trace/schema.js";

export type ApprovalMode = "auto-approve" | "auto-deny";

export interface ApprovalPolicy {
  /** Tools that never require approval; wins over requireApproval. */
  allow?: readonly string[];
  /** Tools that require approval before execution. Unlisted tools are allowed. */
  requireApproval?: readonly string[];
}

export interface ApprovalOptions {
  mode?: ApprovalMode;
  policy?: ApprovalPolicy;
}

export const DEFAULT_APPROVAL_POLICY: Required<ApprovalPolicy> = {
  allow: ["read_file", "write_file"],
  requireApproval: ["exec", "send_notification"],
};

export type AuditFn = (event: HarnessAuditEvent) => void;

/**
 * Builds a pi `beforeToolCall` gate: side-effecting tools (per policy) get an
 * approval decision, which is audited into the trace before anything executes.
 * Blocked calls surface to the model as an error tool result carrying the
 * reason — never silently.
 */
export function createApprovalHook(
  options: ApprovalOptions | undefined,
  audit: AuditFn,
): AgentOptions["beforeToolCall"] {
  const policy = { ...DEFAULT_APPROVAL_POLICY, ...(options?.policy ?? {}) };
  const mode = options?.mode ?? "auto-approve";
  return async (context) => {
    const toolName = context.toolCall.name;
    const needsApproval = policy.requireApproval.includes(toolName) && !policy.allow.includes(toolName);
    if (!needsApproval) return undefined;
    const decision: "allow" | "deny" = mode === "auto-approve" ? "allow" : "deny";
    audit({ type: "approval", toolName, decision, reason: `mode=${mode}` });
    if (decision === "allow") return undefined;
    return { block: true, reason: `tool "${toolName}" was denied by the approval policy (${mode})` };
  };
}
