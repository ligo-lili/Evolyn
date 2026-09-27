/**
 * 阶段 9.7: permission model — capabilities, risk classes, argument-aware
 * escalation. Leaf module: no local imports, so the trace schema can reference
 * these types without cycles.
 *
 * Trust model: a run is GRANTED a set of capabilities (least privilege —
 * default is all for backwards compatibility, `RunOptions.capabilities`
 * narrows it). Every tool declares the capabilities it requires and a static
 * risk class; argument-aware rules may escalate a single call to a higher
 * risk (e.g. a destructive shell command). Enforcement lives in the
 * beforeToolCall gate (runtime/approval.ts); every decision is audited.
 */

export const ALL_CAPABILITIES = ["fs:read", "fs:write", "process:exec", "net:outbound", "notify:send"] as const;

export type Capability = (typeof ALL_CAPABILITIES)[number];

export type RiskClass = "readonly" | "mutating" | "destructive" | "external";

export interface ToolPermissions {
  capabilities: readonly Capability[];
  risk: RiskClass;
}

/** Shell command fragments that escalate an exec call to destructive. */
const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]+\s+)*-[a-z]*r[a-z]*f/i,
  /\brm\s+(-[a-z]+\s+)*-[a-z]*f[a-z]*r/i,
  /\bdel\s+(\/[sq]\s+)+/i,
  /\b(rd|rmdir)\s+\/s/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\breg\s+delete\b/i,
  /remove-item\s+.*-recurse/i,
  /\bdrop\s+(table|database)\b/i,
  /\bgit\s+push\b.*--force/i,
];

/**
 * Static permission metadata per known tool. An UNKNOWN tool is assumed to
 * need every capability and be destructive — untrusted by default.
 *
 * 阶段 13: pi's coding tools (read/edit/write/grep/ls/find/bash/powershell)
 * carry no capability metadata of their own, so they are mapped here. The
 * shell tools are destructive with process:exec + net:outbound (a command can
 * reach the network); destructive-command patterns are HEURISTICS that only
 * enrich the audit trail — they do not intercept (the gate for shell risk is
 * the approval mode, see approval.ts).
 */
export const TOOL_PERMISSIONS: Readonly<Record<string, ToolPermissions>> = {
  read_file: { capabilities: ["fs:read"], risk: "readonly" },
  write_file: { capabilities: ["fs:write"], risk: "mutating" },
  exec: { capabilities: ["fs:read", "fs:write", "process:exec", "net:outbound"], risk: "destructive" },
  send_notification: { capabilities: ["notify:send", "net:outbound"], risk: "external" },
  // pi coding tools (阶段 13)
  read: { capabilities: ["fs:read"], risk: "readonly" },
  grep: { capabilities: ["fs:read"], risk: "readonly" },
  ls: { capabilities: ["fs:read"], risk: "readonly" },
  find: { capabilities: ["fs:read"], risk: "readonly" },
  edit: { capabilities: ["fs:write", "fs:read"], risk: "mutating" },
  write: { capabilities: ["fs:write"], risk: "mutating" },
  bash: { capabilities: ["fs:read", "fs:write", "process:exec", "net:outbound"], risk: "destructive" },
  powershell: { capabilities: ["fs:read", "fs:write", "process:exec", "net:outbound"], risk: "destructive" },
};

const UNKNOWN_TOOL_PERMISSIONS: ToolPermissions = { capabilities: [...ALL_CAPABILITIES], risk: "destructive" };

export function permissionsFor(toolName: string): ToolPermissions {
  return TOOL_PERMISSIONS[toolName] ?? UNKNOWN_TOOL_PERMISSIONS;
}

export interface RiskAssessment {
  risk: RiskClass;
  capabilities: readonly Capability[];
  /** Human-readable escalation reasons (empty when the base class stands). */
  reasons: string[];
}

export function assessRisk(toolName: string, args: unknown): RiskAssessment {
  const base = permissionsFor(toolName);
  const reasons: string[] = [];
  let risk = base.risk;
  const command = (args as { command?: unknown } | null)?.command;
  if ((toolName === "exec" || toolName === "bash" || toolName === "powershell") && typeof command === "string") {
    for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        risk = "destructive";
        reasons.push(`command matches destructive pattern ${pattern.source}`);
        break;
      }
    }
  }
  return { risk, capabilities: base.capabilities, reasons };
}

export function hasAllCapabilities(granted: readonly Capability[], required: readonly Capability[]): boolean {
  return required.every((c) => granted.includes(c));
}
