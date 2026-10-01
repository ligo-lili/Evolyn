import type { AnyAgentTool } from "./index.js";

/**
 * 阶段 9.8 tool-level timeout, 加固期 (P1) semantics:
 *  - TIMEOUT: the wrapper's own timer fires → reject with ToolTimeoutError
 *    (NOT in the retry vocabulary — the first execution may still be running
 *    in the background, so an automatic retry would run it CONCURRENTLY) and
 *    abort the child signal so signal-honoring tools stop.
 *  - ABORT: the OUTER signal (the run is shutting down) → reject with an
 *    AbortError, also never retried.
 * The race guarantees the wrapper never hangs longer than the timeout either
 * way; tools that ignore the signal still resolve the race.
 */
export class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`tool ${toolName} timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

export function isToolTimeoutError(error: unknown): error is ToolTimeoutError {
  return error instanceof ToolTimeoutError;
}

export function withToolTimeout(tools: readonly AnyAgentTool[], timeoutMs: number): AnyAgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener("abort", onOuterAbort);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        return await Promise.race([
          tool.execute(toolCallId, params, controller.signal, onUpdate),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () => {
              if (timedOut) reject(new ToolTimeoutError(tool.name, timeoutMs));
              else reject(new Error(`tool ${tool.name} aborted`));
            });
          }),
        ]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    },
  }));
}
