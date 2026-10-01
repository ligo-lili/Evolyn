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
// module, so the harness carries its own equivalent. The structure pins the
// current goal and key state so rolling summaries never lose the thread.
const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Read the conversation material and produce a " +
  "structured summary with EXACTLY these sections: Goal (the user's current objective), Done " +
  "(completed steps and their outcomes), Pending (unresolved threads and next actions), Key facts " +
  "(file paths, decisions, constraints worth keeping). Do NOT continue the conversation — ONLY output the summary.";

export interface CompactionOptions {
  contextWindow: number;
  /** Summarization model. Defaults to the run's own model. */
  model: Model<Api>;
  /** Models registry used by the default summary function. */
  models?: Models;
  settings?: Partial<CompactionSettings>;
  /**
   * Injectable summarizer for tests. previousSummary is set when rolling:
   * the new summary must fold it together with the new material.
   */
  summaryFn?: (prefix: readonly AgentMessage[], previousSummary?: string) => Promise<string>;
  onEvent?: (event: HarnessAuditEvent) => void;
  /** Per-request tidy: condense old tool results, pointing at their evidence files. */
  tidy?: { evidenceBase?: string; keepChars?: number };
}

const SUMMARY_WRAPPER = (summary: string) =>
  `<context-summary>\nThe earlier conversation was compacted into the following summary to stay within the context window:\n${summary}\n</context-summary>\nContinue the task from here.`;

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function serializePrefix(messages: readonly AgentMessage[]): string {
  return messages
    .map((m) =>
      JSON.stringify(m, (_, v) => (typeof v === "string" && v.length > 2_000 ? v.slice(0, 2_000) + "…(truncated)" : v)),
    )
    .join("\n");
}

async function defaultSummary(
  options: CompactionOptions,
  prefix: readonly AgentMessage[],
  previousSummary?: string,
): Promise<string> {
  const models = options.models ?? getModelRegistry();
  const material = [
    previousSummary
      ? `<previous_summary>\n${previousSummary}\n</previous_summary>\nFold the material below into it, keeping every section current.`
      : "",
    `Summarize this conversation material (JSON lines, one per message):\n${serializePrefix(prefix)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const assistant = await models.completeSimple(options.model, {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: material, timestamp: Date.now() } as never],
  });
  const text = textOf(assistant.content).trim();
  return text || "(empty summary)";
}

/**
 * 阶段 9.5 tidy: condense tool results from earlier turns to keepChars with a
 * pointer to the evidence file (full output captured at execution time). The
 * current turn's results stay verbatim — the model is actively using them.
 * Model-view only: the transcript and trace are untouched.
 */
export function tidyToolResults(
  messages: readonly AgentMessage[],
  opts: { evidenceBase?: string; keepChars?: number } = {},
): AgentMessage[] {
  const keep = opts.keepChars ?? 200;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  return messages.map((m, i) => {
    if (m.role !== "toolResult" || i >= lastUser) return m;
    const text = textOf(m.content);
    if (text.length <= keep) return m;
    const pointer = opts.evidenceBase ? `; full output: ${opts.evidenceBase}/${m.toolCallId}.md` : "";
    return {
      ...m,
      content: [{ type: "text", text: `${text.slice(0, keep)}…(truncated${pointer})` }],
    } as AgentMessage;
  });
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
  // Mid-turn fallback: the slice must never START with a toolResult whose
  // assistant caller is above the cut (an orphaned toolResult gets the next
  // request rejected). Find the LAST toolResult of the contiguous block and
  // cut after it — an assistant keeps all of its toolResults together. When
  // the block reaches the transcript end, the cut is the array length (empty
  // tail is legal; capping it back into the block would orphan its head).
  for (let j = boundary; j > 1; j--) {
    if (messages[j]?.role === "toolResult") {
      let end = j;
      while (end + 1 < messages.length && messages[end + 1]?.role === "toolResult") end++;
      return end + 1;
    }
  }
  // Final fallback (加固期 P1): no user message, no toolResult inside the
  // window. Keep the last message ONLY if it is not a toolResult — a tail
  // starting with a toolResult whose assistant is summarized away is exactly
  // the orphan this function exists to prevent. An empty tail is always legal.
  if (messages[messages.length - 1]?.role === "toolResult") return messages.length;
  return messages.length - 1;
}

function splice(messages: readonly AgentMessage[], cutIndex: number, summary: string): AgentMessage[] {
  const head = messages[0]?.role === "system" ? [messages[0]!] : [];
  const summaryMessage = { role: "user", content: SUMMARY_WRAPPER(summary), timestamp: Date.now() } as AgentMessage;
  return [...head, summaryMessage, ...messages.slice(cutIndex)];
}

/**
 * Builds a pi `transformContext` hook implementing 阶段 9.5 context management:
 * per-request tidy of old tool results, threshold compaction with structured
 * goal-preserving summaries, and ROLLING re-summarization when the tail grows
 * past the budget again (folding the previous summary). The in-memory
 * transcript and the trace are never rewritten — this only shapes what the
 * model sees, and every summary generation emits a compaction audit event.
 */
export function createContextTransformer(
  options: CompactionOptions,
): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
  const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.settings };
  let cache: { forLength: number; summary: string; cutIndex: number } | undefined;
  const summarize: (prefix: readonly AgentMessage[], previous?: string) => Promise<string> = options.summaryFn
    ? (prefix, previous) => options.summaryFn!(prefix, previous)
    : (prefix, previous) => defaultSummary(options, prefix, previous);

  return async (messages) => {
    if (messages.length <= 2) return messages;
    const view = tidyToolResults(messages, options.tidy);
    const estimate = estimateContextTokens(view);
    if (!shouldCompact(estimate.tokens, options.contextWindow, settings)) return view;

    // Transcript only grows within a run: a cached summary stays positionally valid.
    if (cache && view.length >= cache.forLength) {
      const spliced = splice(view, cache.cutIndex, cache.summary);
      const after = estimateContextTokens(spliced);
      if (!shouldCompact(after.tokens, options.contextWindow, settings)) return spliced;
      // Rolling: the tail outgrew the budget again — fold it into the previous summary.
      const newCut = Math.max(cache.cutIndex + 1, findCutIndex(view, settings.keepRecentTokens));
      if (newCut <= cache.cutIndex || newCut >= view.length) return spliced;
      const material = view.slice(cache.cutIndex, newCut);
      const summary = await summarize(material, cache.summary);
      cache = { forLength: view.length, summary, cutIndex: newCut };
      options.onEvent?.({
        type: "compaction",
        trigger: "rolling",
        tokensBefore: after.tokens,
        summaryChars: summary.length,
        cutIndex: newCut,
      });
      return splice(view, newCut, summary);
    }

    const cutIndex = findCutIndex(view, settings.keepRecentTokens);
    if (cutIndex <= 1) return view;
    const prefix = view.slice(1, cutIndex); // exclude the system message
    const summary = await summarize(prefix);
    cache = { forLength: view.length, summary, cutIndex };
    options.onEvent?.({
      type: "compaction",
      trigger: "threshold",
      tokensBefore: estimate.tokens,
      summaryChars: summary.length,
      cutIndex,
    });
    return splice(view, cutIndex, summary);
  };
}
