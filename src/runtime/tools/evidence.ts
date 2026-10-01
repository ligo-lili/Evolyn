import fs from "node:fs";
import path from "node:path";
import type { AnyAgentTool } from "./index.js";

/**
 * 阶段 9.5 evidence capture: persists each tool result's full text to
 * <dir>/<toolCallId>.md so the per-request tidy can condense old tool results
 * without losing information. Best-effort by design — a failed evidence write
 * must never break tool execution.
 *
 * 加固期 (P0/P1): the toolCallId is model-controlled, so the filename is
 * sanitized to a flat safe token (no traversal, no separators); FAILED
 * executions are captured too — the tidy pointer must never dangle.
 */

function safeEvidenceName(toolCallId: string): string {
  const cleaned = toolCallId
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^_+/, "")
    .slice(0, 120);
  return cleaned || "unknown-call";
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export function withEvidenceCapture(tools: readonly AnyAgentTool[], dir: string): AnyAgentTool[] {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return [...tools];
  }
  const write = (tool: AnyAgentTool, toolCallId: string, params: unknown, body: string): void => {
    try {
      fs.writeFileSync(
        path.join(dir, `${safeEvidenceName(toolCallId)}.md`),
        `# ${tool.name}\n\nargs: ${JSON.stringify(params)}\n\n${body}\n`,
        "utf8",
      );
    } catch {
      // best-effort: evidence loss is acceptable, tool failure is not
    }
  };
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      try {
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        write(tool, toolCallId, params, textOf(result.content));
        return result;
      } catch (err) {
        write(tool, toolCallId, params, `EXECUTION ERROR: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  }));
}
