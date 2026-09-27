import type { AnyAgentTool } from "./index.js";

/**
 * 阶段 9.8 tool-level timeout: wraps every execution with an AbortSignal that
 * fires after `timeoutMs`. Tools that honor the signal abort promptly (their
 * error flows back through the normal retry/model-feedback tiers); the race
 * guarantees the wrapper never hangs longer than the timeout either way.
 */
export function withToolTimeout(tools: readonly AnyAgentTool[], timeoutMs: number): AnyAgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener("abort", onOuterAbort);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await Promise.race([
          tool.execute(toolCallId, params, controller.signal, onUpdate),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () =>
              reject(new Error(`tool ${tool.name} timed out after ${timeoutMs}ms`)),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    },
  }));
}
