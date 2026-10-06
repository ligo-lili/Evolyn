import { renderDiff } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { t } from "./theme.js";

/**
 * One tool execution card in the transcript: a compact header line
 * (`● Edit src/a.ts`) plus an optional body (edit diff / shell output tail).
 * Claude Code-style: running shows a spinner glyph, done collapses to the
 * header + a short result tail, error shows the tail in red.
 */

const MAX_BODY_LINES = 8;
const MAX_LINE_LENGTH = 400;

/** Text content of an AgentToolResult-shaped value (or message content array). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    } else if (block && typeof block === "object" && (block as { type?: string }).type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("");
}

interface EditArgs {
  path?: unknown;
  edits?: ReadonlyArray<{ oldText?: unknown; newText?: unknown }>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One-line human summary of the call arguments for the header. */
function argsSummary(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const path = str(a.path) ?? str(a.file_path) ?? str(a.cwd);
  const command = str(a.command) ?? str(a.script);
  const query = str(a.pattern) ?? str(a.query);
  const parts: string[] = [];
  if (command !== undefined) parts.push(command.split("\n")[0] ?? command);
  if (path !== undefined) parts.push(path);
  if (query !== undefined) parts.push(query);
  if (parts.length === 0) {
    const lower = toolName.toLowerCase();
    if (lower.startsWith("memory_")) parts.push(str(a.id) ?? str(a.key) ?? "");
    else if (lower === "explore") parts.push(str(a.task) ?? "");
    else if (lower === "send_notification") parts.push(str(a.message) ?? "");
  }
  if (parts.length === 0) {
    try {
      const json = JSON.stringify(args) ?? "";
      parts.push(json === "{}" ? "" : json);
    } catch {
      return "";
    }
  }
  const joined = parts.filter((p) => p.length > 0).join(" ");
  return joined.length > MAX_LINE_LENGTH ? joined.slice(0, MAX_LINE_LENGTH) + "…" : joined;
}

/** Fabricated +/- diff text for the edit tool's args (pre-execution preview). */
function previewEditDiff(args: EditArgs): string {
  const chunks: string[] = [];
  for (const edit of args.edits ?? []) {
    const oldText = str(edit.oldText);
    const newText = str(edit.newText);
    if (oldText !== undefined)
      chunks.push(
        oldText
          .split("\n")
          .map((l) => `- ${l}`)
          .join("\n"),
      );
    if (newText !== undefined)
      chunks.push(
        newText
          .split("\n")
          .map((l) => `+ ${l}`)
          .join("\n"),
      );
  }
  return chunks.join("\n");
}

function limitLines(lines: string[], max = MAX_BODY_LINES): { lines: string[]; hidden: number } {
  if (lines.length <= max) return { lines, hidden: 0 };
  return { lines: lines.slice(lines.length - max), hidden: lines.length - max };
}

/**
 * pi's renderDiff gives intra-line highlighting but needs its theme global
 * (initTheme); degrade to plain +/- coloring rather than crash when the
 * theme was never initialized.
 */
function renderDiffLines(diffText: string): string[] {
  try {
    return renderDiff(diffText).split("\n");
  } catch {
    return diffText
      .split("\n")
      .map((line) => (line.startsWith("+") ? t.added(line) : line.startsWith("-") ? t.removed(line) : t.dim(line)));
  }
}

export class ToolCard implements Component {
  private status: "running" | "done" | "error" = "running";
  private outputText = "";
  private resultText = "";
  private detailsDiff: string | undefined;
  private isError = false;

  constructor(
    readonly toolCallId: string,
    private readonly toolName: string,
    private readonly args: unknown,
  ) {}

  update(partialResult: unknown): void {
    const next = textOf((partialResult as { content?: unknown })?.content ?? partialResult);
    if (next.length > 0) this.outputText = next;
  }

  finish(result: unknown, isError: boolean): void {
    this.status = isError ? "error" : "done";
    this.isError = isError;
    this.resultText = textOf((result as { content?: unknown })?.content ?? result);
    const details = (result as { details?: unknown })?.details;
    if (details && typeof details === "object") {
      const diff = (details as { diff?: unknown }).diff;
      if (typeof diff === "string") this.detailsDiff = diff;
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const icon = this.status === "running" ? t.accent("✻") : this.isError ? t.error("✗") : t.success("●");
    const summary = argsSummary(this.toolName, this.args);
    const header = `${icon} ${this.toolName}${summary ? ` ${summary}` : ""}`;
    lines.push(truncateToWidth(header, width));

    // Body: prefer the settled diff, then the result/output tail.
    let body: string[] = [];
    if (this.status === "done" && this.detailsDiff !== undefined) {
      body = renderDiffLines(this.detailsDiff);
    } else if (this.status === "running" && this.toolName === "edit") {
      body = renderDiffLines(previewEditDiff(this.args as EditArgs));
    } else {
      const tailSource = this.resultText.length > 0 ? this.resultText : this.outputText;
      if (tailSource.trim().length > 0) {
        const flat = tailSource.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
        body = flat.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l.trim() === ""));
      }
    }
    if (body.length > 0) {
      const { lines: kept, hidden } = limitLines(body);
      const indent = "  ⎿ ";
      for (const line of kept) {
        const prefixWidth = visibleWidth(indent);
        const truncated = truncateToWidth(line, Math.max(8, width - prefixWidth - 2));
        // Lines that already carry ANSI (renderDiff output) keep their own
        // coloring; plain result/output lines get the dim (or error) style.
        const styled = /\x1b\[/u.test(truncated)
          ? truncated
          : this.status === "error"
            ? t.removed(truncated)
            : t.dim(truncated);
        lines.push(truncateToWidth(`${indent}${styled}`, width));
      }
      if (hidden > 0) lines.push(truncateToWidth(`  ${t.dim(`… ${hidden} more line(s)`)}`, width));
    }
    return lines;
  }
}
