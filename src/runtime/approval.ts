import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { HarnessAuditEvent } from "../trace/schema.js";
import {
  assessRisk,
  hasAllCapabilities,
  ALL_CAPABILITIES,
  type Capability,
  type RiskAssessment,
} from "./permissions.js";

export type ApprovalMode = "auto-approve" | "auto-deny" | "interactive";

export interface ApprovalRequest {
  toolName: string;
  assessment: RiskAssessment;
}

/** Decision function for interactive mode; the default prompts on stderr. */
export type ApproveFn = (request: ApprovalRequest) => Promise<boolean> | boolean;

export interface ApprovalOptions {
  mode?: ApprovalMode;
  /** Granted capabilities for this run (least privilege). Default: all. */
  capabilities?: readonly Capability[];
  /** Injectable decision function for interactive mode (tests); default is a stdin Y/N prompt. */
  approveFn?: ApproveFn;
}

export function defaultApproveFn(): ApproveFn {
  return async ({ toolName, assessment }) => {
    if (!process.stdin.isTTY) return false; // non-interactive: never approve
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(`[approval] ${assessment.risk} ${toolName} — approve? (y/N) `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

/**
 * 阶段 9.7 permission gate (beforeToolCall). Decision pipeline per call:
 *   1. capabilities — hard check against the run's granted set; least
 *      privilege is not subject to approval.
 *   2. risk/mode — readonly always passes; everything else follows the mode
 *      (auto-approve / auto-deny / interactive).
 * Every decision is audited as a `permission` event with risk and reason.
 */
export function createPermissionGate(
  options: ApprovalOptions | undefined,
  audit: (event: HarnessAuditEvent) => void,
): NonNullable<AgentOptions["beforeToolCall"]> {
  const mode = options?.mode ?? "auto-approve";
  const granted: readonly Capability[] = options?.capabilities ?? ALL_CAPABILITIES;
  const approver = options?.approveFn ?? defaultApproveFn();

  return async (context) => {
    const toolName = context.toolCall.name;
    const assessment = assessRisk(toolName, context.args);

    if (!hasAllCapabilities(granted, assessment.capabilities)) {
      const missing = assessment.capabilities.filter((c) => !granted.includes(c));
      const reason = `capabilities not granted: ${missing.join(", ")}`;
      audit({ type: "permission", toolName, decision: "deny", risk: assessment.risk, reason });
      return { block: true, reason };
    }

    let allowed: boolean;
    let reason: string;
    if (mode === "auto-approve" || assessment.risk === "readonly") {
      allowed = true;
      reason = `mode=${mode} risk=${assessment.risk}`;
    } else if (mode === "auto-deny") {
      allowed = false;
      reason = `mode=auto-deny risk=${assessment.risk}`;
    } else {
      allowed = await approver({ toolName, assessment });
      reason = allowed ? `approved interactively (risk=${assessment.risk})` : `rejected interactively (risk=${assessment.risk})`;
    }

    const auditReason = [...assessment.reasons, reason].join("; ");
    audit({ type: "permission", toolName, decision: allowed ? "allow" : "deny", risk: assessment.risk, reason: auditReason });
    if (!allowed) return { block: true, reason };
    return undefined;
  };
}

export { ALL_CAPABILITIES };
export type { Capability, RiskAssessment };
