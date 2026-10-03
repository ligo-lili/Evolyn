import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AgentEvent, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ChatFn } from "../../llm/structured.js";
import { createContextTransformer } from "../../context/compaction.js";
import type { HarnessAuditEvent } from "../../trace/schema.js";
import { composeRuntime, sumAgentUsage } from "../compose.js";
import { DEFAULT_RUN_LIMITS, type RunLimits } from "../limits.js";
import type { ApprovalOptions } from "../approval.js";
import type { RetryPolicy } from "../retry.js";
import { createAgent, harnessStreamFn } from "../agent-factory.js";
import { safeEvidenceName } from "./evidence.js";
import type { AnyAgentTool } from "./index.js";

/**
 * Phase-1 read-only subagent (Claude-style context isolation): the `explore`
 * tool spawns a full child Agent with its OWN context window, a restricted
 * readonly toolset and its own (tighter) limits. The child's final assistant
 * message becomes the tool result — its intermediate tool calls never enter
 * the parent's context, which is the preventive complement to compaction.
 *
 * Recovery semantics: the child is a pure function of (task, workspace), so
 * the parent call is declared `replay: "safe"` — a crash mid-child re-executes
 * the WHOLE subagent on resume through the existing recovery path. No nested
 * checkpointing; that constraint is exactly why this generation is readonly.
 */

/** The child toolset — readonly, no shell, no explore (no recursion). Must
 * mirror pi's `createReadOnlyTools()` output; locked by a unit test. */
export const EXPLORE_CHILD_TOOLS = ["read", "grep", "ls", "find"] as const;

const EXPLORE_SYSTEM_PROMPT =
  "You are a read-only code explorer working inside a workspace directory. " +
  "Investigate the task with the provided tools — you cannot and must not modify anything. " +
  "Work efficiently: use grep/ls to locate, then read selectively; do not read entire large files " +
  "when a targeted range answers the question. " +
  "Conclude with the ANSWER FIRST, then the supporting evidence as file:line references. " +
  "If the task cannot be answered, say exactly what information is missing.";

export interface ExploreToolDeps {
  model: Model<Api>;
  /** Injectable for tests; defaults to the pi-ai registry stream function. */
  streamFn?: StreamFn;
  /** The child's own permission gate (readonly tools pass interactive mode). */
  approval?: ApprovalOptions;
  retryPolicy?: RetryPolicy;
  /** Parent's evidence dir — the child transcript lands in explore-<callId>/. */
  parentEvidenceDir: string;
  /** Subagent usage lands on the parent run's money fuses (cost/token). */
  charge: (usage: Usage) => void;
  /** Audit channel (parent trace recorder). */
  audit: (event: HarnessAuditEvent) => void;
  /** Injectable summarizer for the child's own context management (tests). */
  summaryChat?: ChatFn;
  /** Child limits. Default: tighter than a run (20 turns / 60 calls). */
  limits?: Partial<RunLimits>;
}

export interface ExploreDetails {
  task: string;
  status: "completed" | "failed";
  turns: number;
  tokens: number;
  durationMs: number;
  transcriptFile: string;
}

const parameters = Type.Object({
  task: Type.String({
    description:
      "Self-contained investigation task. The subagent sees NOTHING else from this conversation — " +
      "include every path, symbol and constraint it needs.",
  }),
});

export function createExploreTool(deps: ExploreToolDeps): AnyAgentTool {
  const tool: AgentTool<typeof parameters, Partial<ExploreDetails>> = {
    name: "explore",
    label: "Explore (read-only subagent)",
    description:
      "Delegate a READ-ONLY codebase investigation to a subagent with its own context window. " +
      "Use when the answer needs reading many files (3+) or broad searching; the subagent's final " +
      "answer arrives as the result and its intermediate reads never enter this conversation. " +
      "Do NOT use it for a single known file — a direct read is cheaper (the subagent starts with a " +
      "cold prompt cache). The task must be self-contained.",
    parameters,
    replay: "safe",
    execute: async (toolCallId, args, signal, onUpdate) => {
      const dir = path.join(deps.parentEvidenceDir, `explore-${safeEvidenceName(toolCallId)}`);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // evidence loss is acceptable; the run is not
      }
      const transcriptFile = path.join(dir, "agent.jsonl");
      // The child's own trim pointers must resolve against where the child's
      // evidence capture actually writes (this dir), not the parent's.
      const relDir = path.relative(process.cwd(), dir);

      // pi ships the canonical readonly set (read/grep/find/ls) — reused here;
      // only the idempotency marker is overlaid so the child's retry tiering
      // and this tool's `replay: "safe"` share one vocabulary. pi types these
      // as LLM-declaration `Tool[]` but the runtime objects are full AgentTools
      // (name/label/execute) — hence the cast.
      const readonlyTools = createReadOnlyTools(process.cwd()).map((t) => ({
        ...t,
        replay: "safe" as const,
      })) as unknown as AnyAgentTool[];
      let violation: string | undefined;
      const composed = composeRuntime({
        tools: readonlyTools,
        faultSpec: undefined,
        evidenceDir: dir,
        limits: { ...DEFAULT_RUN_LIMITS, maxTurns: 20, maxToolCalls: 60, ...deps.limits },
        retryPolicy: deps.retryPolicy,
        approval: deps.approval,
        audit: deps.audit,
        // The child enforcer denies with terminate:true — the child loop stops
        // and the status check below reports the failure to the parent model.
        onLimitViolation: (v) => {
          violation = `${v.kind}: ${v.reason}`;
        },
      });
      const child = createAgent({
        model: deps.model,
        systemPrompt: EXPLORE_SYSTEM_PROMPT,
        tools: composed.tools,
        streamFn: deps.streamFn ?? harnessStreamFn(),
        beforeToolCall: composed.beforeToolCall,
        transformContext: createContextTransformer({
          model: deps.model,
          // Exploration does not need the full 64k working set — a tighter
          // preference keeps the child cheap and its summaries small.
          budget: { preferenceTokens: 32_768 },
          summaryChat: deps.summaryChat,
          evidenceBase: relDir.startsWith("..") ? dir : relDir,
          onEvent: deps.audit,
        }),
      });
      let turns = 0;
      let tokens = 0;
      const unsubscribe = child.subscribe((event: AgentEvent) => {
        composed.limitEnforcer.onAgentEvent(event);
        if (event.type === "message_end" && event.message.role === "assistant") {
          turns++;
          tokens += event.message.usage.totalTokens;
          onUpdate?.({ content: [], details: { turns, tokens } });
        }
      });
      const onAbort = () => child.abort();
      signal?.addEventListener("abort", onAbort);

      const started = Date.now();
      let endEmitted = false;
      deps.audit({ type: "subagent_start", callId: toolCallId, task: args.task, tools: [...EXPLORE_CHILD_TOOLS] });
      let status: ExploreDetails["status"] = "completed";
      let error: string | undefined;
      try {
        await child.prompt(args.task);
        await child.waitForIdle();
        // The parent's money fuses see the child's spend even on failure.
        const usage = sumAgentUsage(child.state.messages);
        if (usage) deps.charge(usage);
        const messages = child.state.messages;
        try {
          fs.writeFileSync(transcriptFile, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
        } catch {
          // best-effort: evidence loss is acceptable, tool failure is not
        }
        const last = [...messages].reverse().find((m) => m.role === "assistant");
        if (last && (last.stopReason === "error" || last.errorMessage)) {
          status = "failed";
          error = last.errorMessage ?? `stopReason=${last.stopReason}`;
        } else if (last?.stopReason === "toolUse") {
          status = "failed";
          error = "subagent ended with an unanswered tool call (dangling toolUse)";
        } else if (violation) {
          status = "failed";
          error = `subagent stopped by limit (${violation})`;
        }
        const finalText =
          status === "completed"
            ? (last?.content ?? [])
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("")
                .trim()
            : "";
        deps.audit({
          type: "subagent_end",
          callId: toolCallId,
          status,
          turns,
          tokens,
          durationMs: Date.now() - started,
          error,
        });
        endEmitted = true;
        if (status === "failed") {
          throw new Error(`explore subagent failed: ${error ?? "unknown error"}`);
        }
        const rel = path.relative(process.cwd(), transcriptFile);
        const pointer = rel.startsWith("..") ? transcriptFile : rel;
        return {
          content: [
            {
              type: "text",
              text: `${finalText || "(subagent produced no text)"}\n\n[subagent transcript: ${pointer}]`,
            },
          ],
          details: {
            task: args.task,
            status,
            turns,
            tokens,
            durationMs: Date.now() - started,
            transcriptFile: pointer,
          },
        };
      } catch (err) {
        // The happy path already emitted the end event before its own throw.
        if (!endEmitted) {
          deps.audit({
            type: "subagent_end",
            callId: toolCallId,
            status: "failed",
            turns,
            tokens,
            durationMs: Date.now() - started,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
      }
    },
  };
  // tools/timeout.ts reads the per-tool override via a structural cast — pi's
  // AgentTool has no such field, so it rides outside the typed literal above.
  return { ...tool, timeoutMs: 600_000 } as AnyAgentTool;
}
