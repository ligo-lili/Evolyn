import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { computeContextBudget } from "../context/budget.js";
import { estimateContextTokens, tokenCoefficientFor } from "../context/tokens.js";
import { HarnessError } from "../errors.js";
import { resolveModel } from "../providers.js";
import { sumAgentUsage } from "./compose.js";
import {
  type RunManager,
  type RunOptions,
  type ResumeOptions,
  type RunSessionHandle,
  type RunStatus,
} from "./run-manager.js";

export type SessionPhase = "idle" | "streaming";

export interface CycleOutcome {
  status: RunStatus;
  error?: string;
}

export interface SessionContextUsage {
  /** Estimated tokens of the projection the NEXT request would send. */
  usedTokens: number;
  /** Soft line — past it the system defers (keeps appending) while the cache stays valid. */
  triggerTokens: number;
  /** Forced line — past it the next request compacts. */
  ceilingTokens: number;
  /** Hard input budget for the provider window. */
  inputBudgetTokens: number;
}

/**
 * A long-lived conversation on top of ONE durable run. The setup pipeline is
 * exactly RunManager's (createRunSession) — memory recall, skill injection,
 * composed tool chain, compaction, trace + checkpoints — so a session is a
 * first-class durable run: the trace bracket stays open for the whole
 * conversation and a crashed session is recovered by the plain
 * `agent-harness resume <runId>` with zero extra machinery.
 *
 * Driving difference vs run(): the agent stays alive across many submit
 * cycles. Per cycle the runaway counters reset (turns/tool-calls/repeats —
 * they measure ONE user request); the money fuses (cost/tokens) stay
 * cumulative for the whole session. finalize (run_end) lands only at end().
 *
 * Per-cycle refresh: each submit batches a `<session_refresh>` system message
 * (fresh workspace map + newly promoted skills, only when they changed) ahead
 * of the user message — appended at the transcript tail, so the prompt-cache
 * prefix stays intact.
 */
export class InteractiveSession {
  private currentPhase: SessionPhase = "idle";
  private ended = false;

  private constructor(private readonly handle: RunSessionHandle) {}

  /** Assemble a fresh session (new durable run) on the given manager. */
  static async start(manager: RunManager, options: RunOptions): Promise<InteractiveSession> {
    return new InteractiveSession(await manager.createRunSession(options));
  }

  /**
   * Attach to a RECOVERED run (same run id, trace seq continues). The
   * recovery (reconcile → rebuild → resolve unresolved calls) runs first,
   * then the transcript is driven to a clean idle state with resume's rules —
   * the conversation simply continues in the UI.
   */
  static async resume(manager: RunManager, runId: string, options: ResumeOptions = {}): Promise<InteractiveSession> {
    const recovered = await manager.recoverRunSession(runId, options);
    if (recovered.kind === "zombie") {
      throw new HarnessError(
        `run "${runId}" already finished (${recovered.record.status}) — nothing to resume into an interactive session`,
      );
    }
    const session = new InteractiveSession(recovered.handle);
    await session.settle(recovered.synthetic, recovered.initialMessages);
    return session;
  }

  get id(): string {
    return this.handle.record.id;
  }

  get tracePath(): string | undefined {
    return this.handle.tracePath;
  }

  get phase(): SessionPhase {
    return this.currentPhase;
  }

  get isStreaming(): boolean {
    return this.currentPhase === "streaming";
  }

  get modelSpec(): string {
    const model = this.handle.agent.state.model;
    return `${model.provider}/${model.id}`;
  }

  /** The live model object (for seeding the NEXT session after a hot-switch). */
  get model(): Model<Api> {
    return this.handle.agent.state.model;
  }

  get task(): string {
    return this.handle.record.task;
  }

  /** Cumulative session usage (all cycles). */
  usage(): ReturnType<typeof sumAgentUsage> {
    return sumAgentUsage(this.handle.agent.state.messages);
  }

  /** Estimated context-window usage for the NEXT request (footer / /compact). */
  contextUsage(): SessionContextUsage {
    const model = this.handle.agent.state.model;
    const coeff = tokenCoefficientFor(model);
    const usedTokens = estimateContextTokens(this.handle.agent.state.messages, coeff).tokens;
    const budget = computeContextBudget(model);
    return {
      usedTokens,
      triggerTokens: budget.triggerTokens,
      ceilingTokens: budget.compactCeiling,
      inputBudgetTokens: budget.inputBudget,
    };
  }

  messages(): AgentMessage[] {
    return this.handle.messages();
  }

  hasQueuedMessages(): boolean {
    return this.handle.agent.hasQueuedMessages();
  }

  peekQueuedMessages(): AgentMessage[] {
    return this.handle.agent.peekQueuedMessages();
  }

  /**
   * One user turn. Resolves when the agent settles (the UI streams via the
   * RunReporter events meanwhile). Throws only on misuse (already streaming
   * or already ended) — model/provider failures come back as the outcome.
   */
  async submit(text: string): Promise<CycleOutcome> {
    if (this.ended) throw new HarnessError("session has ended — start a new one (/clear or restart)");
    if (this.currentPhase === "streaming")
      throw new HarnessError("session is busy — use steer() while the agent works");
    this.handle.beginCycle();
    this.currentPhase = "streaming";
    try {
      // Refresh block first (workspace map / new skills), then the user
      // message — one prompt batch, one run.
      const refresh = await this.handle.buildRefreshBlock(text);
      const batch: AgentMessage[] = refresh ? [refresh, userMessage(text)] : [userMessage(text)];
      await this.handle.agent.prompt(batch);
      await this.handle.agent.waitForIdle();
      return this.handle.classify();
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.currentPhase = "idle";
    }
  }

  /** Queue a message into the RUNNING agent (injected at the next drain point). */
  steer(text: string): void {
    if (this.ended) throw new HarnessError("session has ended");
    if (this.currentPhase !== "streaming") {
      throw new HarnessError("nothing to steer — the agent is idle; use submit() instead");
    }
    this.handle.agent.steer(userMessage(text));
  }

  /** Abort the current cycle. The transcript keeps everything settled so far. */
  interrupt(): void {
    this.handle.agent.abort();
  }

  /** Hot-switch the model for the NEXT cycle. Throws on an unresolvable spec. */
  setModel(spec: string): void {
    if (this.ended) throw new HarnessError("session has ended");
    this.handle.agent.state.model = resolveModel(spec);
  }

  /**
   * Manual /compact: the NEXT request folds the context regardless of the
   * budget lines (one-shot trigger consumed by the context transformer).
   */
  requestCompact(): void {
    if (this.ended) throw new HarnessError("session has ended");
    this.handle.requestCompact();
  }

  /**
   * Close the session: aborts an in-flight cycle, classifies the transcript,
   * lands run_end + the durable status, and kicks the memory backfill. The
   * CLI epilogue (reflection + drain) runs after this, on the caller side.
   */
  async end(): Promise<CycleOutcome> {
    if (this.ended) return this.handle.classify();
    this.ended = true;
    if (this.currentPhase === "streaming") {
      this.handle.agent.abort();
      await this.handle.agent.waitForIdle();
      this.currentPhase = "idle";
    }
    const outcome = this.handle.classify();
    this.handle.finalize(outcome.status, outcome.error);
    this.handle.beginMemoryBackfill();
    return outcome;
  }

  /**
   * Drive a RECOVERED transcript to a clean idle state — the same rules
   * resume() uses, but without finalizing: the session stays open.
   */
  private async settle(synthetic: AgentMessage[], initialMessages: AgentMessage[]): Promise<void> {
    this.handle.beginCycle();
    this.currentPhase = "streaming";
    try {
      if (synthetic.length > 0) {
        await this.handle.agent.prompt(synthetic);
        await this.handle.agent.waitForIdle();
      } else if (!initialMessages.some((m) => m.role === "assistant")) {
        // A crash before any assistant output — the task still needs driving.
        // continue() handles a transcript ending on the persisted user message.
        if (initialMessages.some((m) => m.role === "user")) {
          await this.handle.agent.continue();
        } else {
          await this.handle.agent.prompt(this.handle.record.task);
        }
        await this.handle.agent.waitForIdle();
      } else if (initialMessages.at(-1)?.role === "toolResult") {
        await this.handle.agent.continue();
        await this.handle.agent.waitForIdle();
      }
      // Transcript already ends complete — nothing to drive.
    } finally {
      this.currentPhase = "idle";
    }
  }
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}
