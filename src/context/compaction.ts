import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  shouldCompact,
  type AgentMessage,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { getModelRegistry } from "../providers.js";
import type { HarnessAuditEvent } from "../trace/schema.js";

// pi keeps SUMMARIZATION_SYSTEM_PROMPT internal to its harness compaction
// module, so the harness carries its own equivalent.
const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Read the conversation prefix provided by the user and produce a structured summary of it. Do NOT continue the conversation or answer anything in it — ONLY output the summary.";

export interface CompactionOptions {
  contextWindow: number;
  /** Summarization model. Defaults to the run's own model. */
  model: Model<Api>;
  /** Models registry used by the default summary function. */
  models?: Models;
  settings?: Partial<CompactionSettings>;
  /** Injectable for tests; default calls models.completeSimple with pi's summarization prompt. */
  summaryFn?: (prefix: readonly AgentMessage[]) => Promise<string>;
  onEvent?: (event: HarnessAuditEvent) => void;
}

const SUMMARY_WRAPPER = (summary: string) =>
  `<context-summary>\nThe earlier conversation was compacted into the following summary to stay within the context window:\n${summary}\n</context-summary>\nContinue the task from here.`;

function serializePrefix(messages: readonly AgentMessage[]): string {
  return messages
    .map((m) => JSON.stringify(m, (_, v) => (typeof v === "string" && v.length > 2_000 ? v.slice(0, 2_000) + "…(truncated)" : v)))
    .join("\n");
}

async function defaultSummary(options: CompactionOptions, prefix: readonly AgentMessage[]): Promise<string> {
  const models = options.models ?? getModelRegistry();
  const assistant = await models.completeSimple(options.model, {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Summarize the following conversation prefix (JSON lines, one per message). Preserve the task, decisions, tool results and unresolved threads.\n\n${serializePrefix(prefix)}`,
        timestamp: Date.now(),
      } as AgentMessage as never,
    ],
  });
  const text = assistant.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return text || "(empty summary)";
}

/**
 * Index of the message where the compacted transcript should start. Preferred
 * cut: a user message (always begins a turn). Mid-turn fallback: just after
 * the last toolResult before the token-budget boundary — an assistant and its
 * toolResults are never separated, and the tail keeps the toolResult the
 * pending request must answer.
 */
export function findCutIndex(messages: readonly AgentMessage[], keepRecentTokens: number): number {
  let acc = 0;
  let boundary = messages.length - 1;
  while (boundary > 1) {
    acc += estimateTokens(messages[boundary]!);
    if (acc >= keepRecentTokens) break;
    boundary--;
  }
  let cut = boundary;
  while (cut > 1 && messages[cut]?.role !== "user") cut--;
  if (cut > 1) return cut;
  for (let j = boundary; j > 1; j--) {
    if (messages[j]?.role === "toolResult") return Math.min(j + 1, messages.length - 1);
  }
  return messages.length - 1;
}

function splice(messages: readonly AgentMessage[], cutIndex: number, summary: string): AgentMessage[] {
  const head = messages[0]?.role === "system" ? [messages[0]!] : [];
  const summaryMessage = { role: "user", content: SUMMARY_WRAPPER(summary), timestamp: Date.now() } as AgentMessage;
  return [...head, summaryMessage, ...messages.slice(cutIndex)];
}

/**
 * Builds a pi `transformContext` hook that compacts the LLM-visible context
 * when pi's threshold math says so. The in-memory transcript and the trace are
 * never rewritten — the compaction only affects what the model sees, and the
 * `compaction` audit event (with the summary cached inside the run) keeps
 * replay/recovery fully faithful to what happened.
 */
export function createContextTransformer(options: CompactionOptions): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
  const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.settings };
  let cache: { forLength: number; summary: string; cutIndex: number } | undefined;

  return async (messages) => {
    if (messages.length <= 2) return messages;
    const estimate = estimateContextTokens(messages);
    if (!shouldCompact(estimate.tokens, options.contextWindow, settings)) return messages;

    // The transcript only grows within a run, so a cached summary stays valid.
    if (cache && messages.length >= cache.forLength) {
      return splice(messages, cache.cutIndex, cache.summary);
    }

    const cutIndex = findCutIndex(messages, settings.keepRecentTokens);
    if (cutIndex <= 1) return messages;
    const prefix = messages.slice(1, cutIndex); // exclude the system message
    const summary = options.summaryFn
      ? await options.summaryFn(prefix)
      : await defaultSummary(options, prefix);
    cache = { forLength: messages.length, summary, cutIndex };
    options.onEvent?.({
      type: "compaction",
      trigger: "threshold",
      tokensBefore: estimate.tokens,
      summaryChars: summary.length,
      cutIndex,
    });
    return splice(messages, cutIndex, summary);
  };
}
