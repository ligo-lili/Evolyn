import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { HarnessError } from "../errors.js";
import type { AnyAgentTool } from "../runtime/tools/index.js";

export type FaultPoint = "after_tool_call" | "mid_tool_execution";

export interface FaultSpec {
  point: FaultPoint;
  toolName: string;
}

/** Parse "--fault after_tool_call:send_notification" style specs. */
export function parseFaultSpec(spec: string | undefined): FaultSpec | undefined {
  if (!spec) return undefined;
  const sep = spec.indexOf(":");
  const point = sep === -1 ? spec : spec.slice(0, sep);
  const toolName = sep === -1 ? "" : spec.slice(sep + 1);
  if (point !== "after_tool_call" && point !== "mid_tool_execution") {
    throw new HarnessError(`unknown fault point "${point}" (expected after_tool_call | mid_tool_execution)`);
  }
  if (!toolName) throw new HarnessError("fault spec needs a tool name: --fault <point>:<toolName>");
  return { point, toolName };
}

export function formatFaultSpec(fault: FaultSpec): string {
  return `${fault.point}:${fault.toolName}`;
}

/**
 * mid_tool_execution: the tool's side effect happens, then the process dies
 * before the result reaches the loop — the trace ends with tool_execution_start
 * and no end. This is the exact state the Crash Recovery demo must handle for
 * a replay:"never" tool.
 */
export function applyFaultToTools(tools: readonly AnyAgentTool[], fault: FaultSpec | undefined, kill: () => void = killProcess): AnyAgentTool[] {
  if (!fault || fault.point !== "mid_tool_execution") return [...tools];
  return tools.map((tool) => {
    if (tool.name !== fault.toolName) return tool;
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        kill();
        return result; // unreachable in production (kill exits); keeps types honest in tests
      },
    };
  });
}

/**
 * after_tool_call: fire from the dispatch path AFTER the matched event is
 * durably recorded, so the trace ends exactly at the chosen point.
 */
export class FaultController {
  constructor(
    readonly spec: FaultSpec,
    private readonly kill: () => void = killProcess,
  ) {}

  onEvent(event: AgentEvent): void {
    if (this.spec.point === "after_tool_call" && event.type === "tool_execution_end" && event.toolName === this.spec.toolName) {
      this.kill();
    }
  }
}

function killProcess(): never {
  process.stderr.write(`[harness] FAULT INJECTED — killing process (simulated crash)\n`);
  process.exit(137);
}
