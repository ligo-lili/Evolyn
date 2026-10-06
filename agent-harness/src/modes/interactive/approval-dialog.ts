import {
  decodeKittyPrintable,
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ApproveFn } from "../../runtime/approval.js";
import { bold, t } from "./theme.js";

export type ApprovalDecision = "allow" | "always" | "deny";

/**
 * Modal approval dialog (TUI overlay). The permission gate's interactive
 * approveFn resolves through this — keyboard goes to the dialog while it is
 * visible because the app-level input listener yields when an overlay exists.
 */
export class ApprovalDialog implements Component, Focusable {
  focused = false;

  private resolve!: (decision: ApprovalDecision) => void;
  private readonly settled: Promise<ApprovalDecision>;

  constructor(
    private readonly toolName: string,
    private readonly risk: string,
    private readonly argsPreview: string | undefined,
  ) {
    this.settled = new Promise<ApprovalDecision>((resolve) => {
      this.resolve = resolve;
    });
  }

  wait(): Promise<ApprovalDecision> {
    return this.settled;
  }

  handleInput(data: string): void {
    // Kitty CSI-u encodes even plain letters as sequences — decode before
    // matching (mirrors how the editor reads printable input).
    const key = decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined);
    if (key === "y") this.resolve("allow");
    else if (key === "a") this.resolve("always");
    else if (key === "n" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.resolve("deny");
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const inner = Math.max(20, width - 4);
    const pad = (text: string): string => {
      // Visible width (ANSI-aware, CJK double-width) — string length would
      // misalign the box for non-ASCII previews.
      const w = visibleWidth(text);
      const filler = " ".repeat(Math.max(0, inner - w));
      return ` ${text}${filler} `;
    };
    const top = `┌─ ${bold("approval requested")} ${"─".repeat(Math.max(0, inner - " approval requested ".length + 2))}┐`;
    const bottom = `└${"─".repeat(inner + 2)}┘`;
    lines.push(top);
    lines.push(`│${pad(`${bold(this.toolName)} · risk: ${this.risk}`)}│`);
    if (this.argsPreview) {
      const visible = this.argsPreview.replace(/\x1b\[[0-9;]*m/g, "");
      const chunks = visible.match(new RegExp(`.{1,${Math.max(10, inner - 2)}}`, "g")) ?? [];
      for (const chunk of chunks) lines.push(`│${pad(t.muted(chunk))}│`);
    }
    lines.push(`│${pad("")}│`);
    lines.push(
      `│${pad(`${bold("y")} allow once   ${bold("a")} always this session   ${bold("n")}/${bold("Esc")} deny`)}│`,
    );
    lines.push(bottom);
    return lines;
  }
}

/**
 * Interactive ApproveFn backed by the dialog. "always" keeps a per-session
 * allowlist INSIDE the UI layer — the capability hard-check and the audit
 * trail in the permission gate are untouched.
 */
export function createTuiApproveFn(tui: TUI): ApproveFn {
  const sessionAllowed = new Set<string>();
  return async ({ toolName, assessment, argsPreview }) => {
    if (sessionAllowed.has(toolName)) return true;
    const dialog = new ApprovalDialog(toolName, assessment.risk, argsPreview);
    const width = Math.min(80, Math.max(40, tui.terminal.columns - 8));
    const handle = tui.showOverlay(dialog, { anchor: "center", width });
    try {
      const decision = await dialog.wait();
      if (decision === "always") sessionAllowed.add(toolName);
      return decision !== "deny";
    } finally {
      handle.hide();
    }
  };
}
