import type { AnyAgentTool } from "./tools/index.js";
import { isToolTimeoutError } from "./tools/timeout.js";
import type { HarnessAuditEvent } from "../trace/schema.js";

/**
 * 阶段 9.8 tiered retry: transient failures of IDEMPOTENT tools are retried
 * automatically with backoff; non-idempotent tools are never auto-retried
 * (their failures flow back to the model, which chooses another approach —
 * the "换方案" tier). Retries are audited as `tool_retry` events.
 *
 * 加固期 (P1): timeouts and aborts are NEVER retried — a timeout means the
 * previous execution may still be running in the background, and a retry
 * would execute the tool concurrently with itself.
 */

export interface RetryPolicy {
  /** Total attempts (1 = no retry). Default 2. */
  maxAttempts?: number;
  /** Backoff between attempts in ms. Default 250. */
  backoffMs?: number;
}

const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /timed?\s*out/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /eai_again/i,
  /enotfound/i,
  /socket hang up/i,
  /fetch failed/i,
  /\b429\b/,
  /\b50[234]\b/,
  /temporar/i,
  /rate limit/i,
];

export function isTransientError(error: unknown): boolean {
  // A wrapper-level timeout is NEVER transient regardless of its message
  // (加固期 P1): the first execution may still be running in the background.
  if (isToolTimeoutError(error)) return false;
  const message = error instanceof Error ? `${error.message}` : String(error);
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

export function withRetry(
  tools: readonly AnyAgentTool[],
  options: { policy?: RetryPolicy; audit?: (event: HarnessAuditEvent) => void } = {},
): AnyAgentTool[] {
  const maxAttempts = options.policy?.maxAttempts ?? 2;
  const backoffMs = options.policy?.backoffMs ?? 250;
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      const attempts = tool.replay === "safe" ? maxAttempts : 1;
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await tool.execute(toolCallId, params, signal, onUpdate);
        } catch (err) {
          lastError = err;
          const transient = !isToolTimeoutError(err) && !signal?.aborted && isTransientError(err);
          if (attempt >= attempts || !transient) break;
          options.audit?.({
            type: "tool_retry",
            toolCallId,
            toolName: tool.name,
            attempt: attempt + 1,
            error: err instanceof Error ? err.message : String(err),
          });
          await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
          // 加固期复核: the abort may land DURING the backoff sleep — re-check
          // before starting the next attempt, or an aborted run would still
          // execute the tool again.
          if (signal?.aborted) break;
        }
      }
      throw lastError;
    },
  }));
}
