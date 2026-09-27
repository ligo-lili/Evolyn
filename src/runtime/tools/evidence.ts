import fs from "node:fs";
import path from "node:path";
import type { AnyAgentTool } from "./index.js";

/**
 * 阶段 9.5 evidence capture: persists each tool result's full text to
 * <dir>/<toolCallId>.md so the per-request tidy can condense old tool results
 * without losing information. Best-effort by design — a failed evidence write
 * must never break tool execution.
 */
export function withEvidenceCapture(tools: readonly AnyAgentTool[], dir: string): AnyAgentTool[] {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return [...tools];
  }
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      const result = await tool.execute(toolCallId, params, signal, onUpdate);
      try {
        const text = result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        fs.writeFileSync(
          path.join(dir, `${toolCallId}.md`),
          `# ${tool.name}\n\nargs: ${JSON.stringify(params)}\n\n${text}\n`,
          "utf8",
        );
      } catch {
        // best-effort: evidence loss is acceptable, tool failure is not
      }
      return result;
    },
  }));
}
