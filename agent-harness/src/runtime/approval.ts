import type { BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { HarnessAuditEvent } from "../trace/schema.js";
import {
  assessRisk,
  hasAllCapabilities,
  ALL_CAPABILITIES,
  type Capability,
  type RiskAssessment,
} from "./permissions.js";

export type ApprovalMode = "auto-approve" | "auto-deny" | "interactive";

/**
 * Narrow view of pi's `BeforeToolCallContext` containing only what harness
 * gates actually read. Gates are declared against THIS type, not pi's full
 * context: pi's callback satisfies it (BeforeToolCallContext is structurally
 * assignable), and the recovery path can call the gate with a hand-built
 * `{ toolCall, args }` — no structural casts anywhere.
 */
export interface GateContext {
  toolCall: { id: string; name: string };
  args: unknown;
}

export type Gate = (context: GateContext) => Promise<BeforeToolCallResult | undefined>;

export interface ApprovalRequest {
  toolName: string;
  assessment: RiskAssessment;
  /** One-line truncated view of the actual call arguments (加固期 P0). */
  argsPreview?: string;
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

/** One-line, truncated view of the call's actual arguments for approval prompts. */
export function argsPreview(args: unknown, max = 160): string | undefined {
  let text: string;
  try {
    text = JSON.stringify(args) ?? "";
  } catch {
    return undefined;
  }
  text = text.replace(/\s+/g, " ");
  if (!text || text === "{}") return undefined;
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export function defaultApproveFn(): ApproveFn {
  return async ({ toolName, assessment, argsPreview: preview }) => {
    if (!process.stdin.isTTY) return false; // non-interactive: never approve
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const args = preview ? ` ${preview}` : "";
      const answer = await rl.question(`[approval] ${assessment.risk} ${toolName}${args} — approve? (y/N) `);
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
): Gate {
  // Mode is read PER CALL, not captured at gate creation: the interactive
  // session's slash commands (/yolo, /approval) mutate the SAME options object
  // to flip the live gate without rebuilding the run.
  const modeOf = (): ApprovalMode => options?.mode ?? "auto-approve";
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
    const mode = modeOf();
    if (mode === "auto-approve" || assessment.risk === "readonly") {
      allowed = true;
      reason = `mode=${mode} risk=${assessment.risk}`;
    } else if (mode === "auto-deny") {
      allowed = false;
      reason = `mode=auto-deny risk=${assessment.risk}`;
    } else {
      allowed = await approver({ toolName, assessment, argsPreview: argsPreview(context.args) });
      reason = allowed
        ? `approved interactively (risk=${assessment.risk})`
        : `rejected interactively (risk=${assessment.risk})`;
    }

    const auditReason = [...assessment.reasons, reason].join("; ");
    audit({
      type: "permission",
      toolName,
      decision: allowed ? "allow" : "deny",
      risk: assessment.risk,
      reason: auditReason,
    });
    if (!allowed) return { block: true, reason };
    return undefined;
  };
}

export { ALL_CAPABILITIES };
export type { Capability, RiskAssessment };
