import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { HarnessError } from "../errors.js";
import type { TraceEvent } from "../trace/schema.js";
import type { AnyAgentTool } from "../runtime/tools/index.js";

/**
 * Fault points (阶段 5 + 加固期 P2 补盲区):
 *   after_tool_call:<tool>     kill after the matched tool_execution_end is durably recorded
 *   mid_tool_execution:<tool>  kill after the side effect, before the result reaches the loop
 *   between_sinks:[<eventType>]  kill between the FIRST sink write (JSONL) and the rest (SQLite)
 *                              — the exact window where the two stores diverge
 *   after_assistant_message:[<tool>]  kill right after a message_end carrying tool calls but
 *                              BEFORE any tool_execution_start — the "planned" window
 *   mid_recovery:[<n>]         kill during resume with n calls already resolved (default 1)
 *
 * `toolName` is reused as the per-point argument: an event-type filter for
 * between_sinks, a tool filter for after_assistant_message, and the step
 * count for mid_recovery. The first two points keep the original semantics
 * (tool name required); the new points make the argument optional.
 */
export type FaultPoint =
  "after_tool_call" | "mid_tool_execution" | "between_sinks" | "after_assistant_message" | "mid_recovery";

export interface FaultSpec {
  point: FaultPoint;
  /** Tool name, event-type filter, or step count — see the point list above. */
  toolName: string;
}

/** Parse "--fault after_tool_call:send_notification" style specs. */
export function parseFaultSpec(spec: string | undefined): FaultSpec | undefined {
  if (!spec) return undefined;
  const sep = spec.indexOf(":");
  const point = sep === -1 ? spec : spec.slice(0, sep);
  const arg = sep === -1 ? "" : spec.slice(sep + 1);
  switch (point) {
    case "after_tool_call":
    case "mid_tool_execution":
      if (!arg) throw new HarnessError(`fault point "${point}" needs a tool name: --fault ${point}:<toolName>`);
      break;
    case "between_sinks":
    case "after_assistant_message":
    case "mid_recovery":
      break; // argument optional
    default:
      throw new HarnessError(
        `unknown fault point "${point}" (expected after_tool_call | mid_tool_execution | between_sinks | after_assistant_message | mid_recovery)`,
      );
  }
  return { point: point as FaultPoint, toolName: arg };
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
export function applyFaultToTools(
  tools: readonly AnyAgentTool[],
  fault: FaultSpec | undefined,
  kill: () => void = killProcess,
): AnyAgentTool[] {
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
 * Fault injection controller. after_tool_call fires from the dispatch path
 * AFTER the matched event is durably recorded, so the trace ends exactly at
 * the chosen point. between_sinks / after_assistant_message / mid_recovery are
 * driven by the hooks the run/resume paths call at the corresponding moments.
 */
export class FaultController {
  private readonly stepTarget: number;

  constructor(
    readonly spec: FaultSpec,
    private readonly kill: () => void = killProcess,
  ) {
    const parsed = Number.parseInt(spec.toolName, 10);
    this.stepTarget = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  onEvent(event: AgentEvent): void {
    if (
      this.spec.point === "after_tool_call" &&
      event.type === "tool_execution_end" &&
      event.toolName === this.spec.toolName
    ) {
      this.kill();
      return;
    }
    if (
      this.spec.point === "after_assistant_message" &&
      event.type === "message_end" &&
      event.message.role === "assistant"
    ) {
      const callsTool = event.message.content.some((b) => b.type === "toolCall");
      const matches =
        !this.spec.toolName ||
        event.message.content.some((b) => b.type === "toolCall" && b.name === this.spec.toolName);
      if (callsTool && matches) this.kill();
    }
  }

  /** Fired by the recorder after the FIRST sink persisted the event. */
  onSinkBoundary(event: TraceEvent): void {
    if (this.spec.point !== "between_sinks") return;
    if (!this.spec.toolName || event.type === this.spec.toolName) this.kill();
  }

  /** Fired by resume after n unresolved calls have been resolved. */
  onRecoveryStep(resolved: number): void {
    if (this.spec.point !== "mid_recovery") return;
    if (resolved >= this.stepTarget) this.kill();
  }
}

function killProcess(): never {
  process.stderr.write(`[harness] FAULT INJECTED — killing process (simulated crash)\n`);
  process.exit(137);
}
