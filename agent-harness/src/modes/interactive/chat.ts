import type { Api, Model } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  matchesKey,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { reflectRunById } from "../../memory/reflection.js";
import { MemoryStore } from "../../memory/store.js";
import { type ApprovalMode, type ApprovalOptions, ALL_CAPABILITIES, type Capability } from "../../runtime/approval.js";
import { harnessDataDir } from "../../runtime/paths.js";
import { type RunManager, type RunOptions, type RunStatus, type ToolsetSpec } from "../../runtime/run-manager.js";
import { InteractiveSession } from "../../runtime/session.js";
import { createTuiApproveFn } from "./approval-dialog.js";
import { editorTheme, t } from "./theme.js";
import { TuiReporter } from "./tui-reporter.js";
import { TuiChatView } from "./tui-view.js";

export interface ChatAppOptions {
  manager: RunManager;
  model: Model<Api>;
  tools?: ToolsetSpec;
  approvalMode: ApprovalMode;
  capabilities?: readonly Capability[];
  /**
   * Resume-into-chat: recover this run and continue the SAME conversation in
   * the TUI. The TUI (and its approval dialog) starts BEFORE the recovery so
   * recovered re-executions can prompt interactively.
   */
  resumeRunId?: string;
}

export interface ChatExitSummary {
  runId?: string;
  status?: RunStatus;
  error?: string;
  cycles: number;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "show this list" },
  { name: "model", description: "show or hot-switch the model", argumentHint: "[provider/model-id]" },
  { name: "yolo", description: "toggle auto-approve for the session" },
  { name: "approval", description: "set approval mode", argumentHint: "<auto-approve|auto-deny|interactive>" },
  { name: "tools", description: "show the toolset and approval mode" },
  { name: "memory", description: "experience memory summary" },
  { name: "trace", description: "show the run id and trace path" },
  { name: "clear", description: "end this run and start a fresh one" },
  { name: "compact", description: "fold the context at the next request" },
  { name: "quit", description: "exit (Ctrl+D on empty input)" },
];

/** Below this estimate there is nothing worth folding (summarizer material floor). */
const COMPACT_MIN_TOKENS = 2000;

/** A queued steering chip: the raw text plus its rendered placeholder. */
interface SteeringChip {
  text: string;
  component: Text;
}

/**
 * The interactive coding-agent app: pi-tui rendering + the durable session.
 * The session is created lazily on the FIRST user message so memory recall
 * and skill retrieval run against the user's actual intent, not a placeholder
 * (unless resuming, where the recovered run is attached at startup).
 */
export class ChatApp {
  private readonly manager: RunManager;
  /** The model for the NEXT session — /model and /clear keep it current. */
  private model: Model<Api>;
  private readonly tools: ToolsetSpec | undefined;
  private readonly capabilities: readonly Capability[];
  private readonly resumeRunId: string | undefined;

  private session: InteractiveSession | undefined;
  /** Mutable holder — /yolo and /approval mutate `mode`; the gate re-reads it per call. */
  private readonly approvalOptions: ApprovalOptions;
  private cycles = 0;
  private quitResolve: (() => void) | undefined;
  private quitting = false;
  private chips: SteeringChip[] = [];

  private view!: TuiChatView;
  private editor!: Editor;
  private pendingContainer!: Container;
  private footer!: Text;

  constructor(options: ChatAppOptions) {
    this.manager = options.manager;
    this.model = options.model;
    this.tools = options.tools;
    this.capabilities = options.capabilities ?? ALL_CAPABILITIES;
    this.resumeRunId = options.resumeRunId;
    this.approvalOptions = {
      mode: options.approvalMode,
      capabilities: this.capabilities,
      approveFn: undefined,
    };
  }

  async run(): Promise<ChatExitSummary> {
    // pi's theme (used by renderDiff for intra-line highlighting); on failure
    // the tool card degrades to plain +/- coloring.
    try {
      initTheme();
    } catch {
      // fall back to the plain palette
    }
    const terminal = new ProcessTerminal();
    const tui = new TuiMainScreen(terminal, true);

    // The TUI approval dialog MUST be wired — leaving approveFn unset would
    // fall back to a readline prompt on the same stdin the TUI owns.
    this.approvalOptions.approveFn = createTuiApproveFn(tui);

    const transcript = new Container();
    const status = new Container();
    this.pendingContainer = new Container();
    const editorContainer = new Container();
    this.footer = new Text("");
    this.view = new TuiChatView(transcript, status, tui);

    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    editorContainer.addChild(this.editor);
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd(), null));

    tui.addChild(transcript);
    tui.addChild(this.pendingContainer);
    tui.addChild(status);
    tui.addChild(editorContainer);
    tui.addChild(this.footer);

    this.view.onUserMessageRendered = (text) => this.retireChip(text);
    this.editor.onSubmit = (text) => this.handleSubmit(text);

    tui.setFocus(this.editor);
    const removeKeyListener = tui.addInputListener((data) => this.handleGlobalKey(tui, data));
    tui.start();

    // Resume-into-chat: recover + attach BEFORE accepting input, with the TUI
    // already running so recovered re-executions can prompt via the dialog.
    if (this.resumeRunId) {
      try {
        this.session = await InteractiveSession.resume(this.manager, this.resumeRunId, {
          tools: this.tools,
          approval: this.approvalOptions,
        });
        this.model = this.session.model;
        this.cycles = this.session.messages().filter((m) => m.role === "user").length;
        this.replayTranscript(this.session.messages());
        this.view.info(`resumed run ${this.session.id} — trace continued (${this.cycles} earlier cycle(s) on record)`);
      } catch (err) {
        this.view.error(`resume failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.updateFooter();

    await new Promise<void>((resolve) => {
      this.quitResolve = resolve;
    });

    const outcome = this.session ? await this.session.end() : undefined;
    removeKeyListener();
    tui.stop();

    return {
      runId: this.session?.id,
      status: outcome?.status,
      error: outcome?.error,
      cycles: this.cycles,
    };
  }

  /** Replay a recovered transcript into the TUI (user + assistant text only). */
  private replayTranscript(messages: readonly AgentMessage[]): void {
    for (const message of messages) {
      if (message.role === "user") {
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("");
        if (text.trim()) this.view.addUserMessage(text);
      } else if (message.role === "assistant") {
        const text = message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text.trim()) this.view.addAssistantMessage(text);
      }
      // system / toolResult: carried by the system prompt and the trace — not replayed.
    }
  }

  private handleGlobalKey(tui: TuiMainScreen, data: string): { consume: boolean } | undefined {
    // An overlay (approval dialog) owns the keyboard while it is visible.
    if (tui.hasOverlay()) return undefined;
    if (matchesKey(data, "escape")) {
      // Let the editor cancel its own autocomplete menu before we treat
      // Esc as "clear input" / "interrupt".
      if (this.editor.isShowingAutocomplete()) return undefined;
      if (this.session?.isStreaming) {
        this.session.interrupt();
        this.view.info("· interrupted");
      } else {
        this.editor.setText("");
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (this.session?.isStreaming) {
        this.session.interrupt();
        this.view.info("· interrupted");
      } else if (this.editor.getText().length > 0) {
        this.editor.setText("");
      } else {
        this.requestQuit();
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && !this.session?.isStreaming) {
      this.requestQuit();
      return { consume: true };
    }
    return undefined;
  }

  private requestQuit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.quitResolve?.();
  }

  private handleSubmit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.quitting) return;
    this.editor.addToHistory(trimmed);
    if (trimmed.startsWith("/")) {
      void this.handleCommand(trimmed);
      return;
    }
    if (this.session?.isStreaming) {
      try {
        this.session.steer(trimmed);
        this.addChip(trimmed);
      } catch (err) {
        this.view.error(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    void this.runCycle(trimmed);
  }

  private async runCycle(text: string): Promise<void> {
    if (!this.session) {
      try {
        this.session = await InteractiveSession.start(this.manager, this.sessionOptions(text));
      } catch (err) {
        this.view.error(`failed to start the session: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.view.info(`durable run ${this.session.id} started (trace: ${this.session.tracePath ?? "disabled"})`);
    }
    this.cycles++;
    this.updateFooter();
    const outcome = await this.session.submit(text);
    this.updateFooter();
    if (outcome.error) this.view.error(`cycle ended with an error: ${outcome.error}`);
  }

  /** Options for a session. `task` is the first user message — memory recall and skill retrieval key off it. */
  private sessionOptions(firstTask: string): RunOptions {
    return {
      task: firstTask,
      model: this.model,
      tools: this.tools,
      reporter: new TuiReporter(this.view),
      approval: this.approvalOptions,
      interactive: true,
    };
  }

  private async handleCommand(input: string): Promise<void> {
    const parts = input.slice(1).split(/\s+/);
    const name = (parts[0] ?? "").toLowerCase();
    const arg = parts.slice(1).join(" ").trim();
    const session = this.session;
    switch (name) {
      case "help":
        for (const command of SLASH_COMMANDS) {
          this.view.info(
            `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""} — ${command.description}`,
          );
        }
        break;
      case "model": {
        if (!session) {
          this.view.error("no session yet — send a message first");
          break;
        }
        if (!arg) {
          this.view.info(`model: ${session.modelSpec}`);
          break;
        }
        try {
          session.setModel(arg);
          this.model = session.model; // the next session (after /clear) keeps the switch
          this.view.info(`model switched → ${session.modelSpec}`);
          this.updateFooter();
        } catch (err) {
          this.view.error(err instanceof Error ? err.message : String(err));
        }
        break;
      }
      case "yolo": {
        this.approvalOptions.mode = this.approvalOptions.mode === "auto-approve" ? "interactive" : "auto-approve";
        this.view.info(`approval mode: ${this.approvalOptions.mode}`);
        this.updateFooter();
        break;
      }
      case "approval": {
        if (arg === "auto-approve" || arg === "auto-deny" || arg === "interactive") {
          this.approvalOptions.mode = arg;
          this.view.info(`approval mode: ${arg}`);
          this.updateFooter();
        } else {
          this.view.error("usage: /approval auto-approve | auto-deny | interactive");
        }
        break;
      }
      case "tools":
        this.view.info(`tools: ${this.tools ?? "demo (default)"} · approval: ${this.approvalOptions.mode}`);
        break;
      case "memory": {
        try {
          const store = new MemoryStore(this.memoryDir());
          const active = store.list("active");
          this.view.info(
            `memory: ${active.length} active record(s)${store.readCore() ? " · core memory resident" : ""} — manage via agent-harness memory <subcommand>`,
          );
        } catch (err) {
          this.view.error(`memory: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "trace":
        if (!session) this.view.info("no durable run yet — send a message first");
        else this.view.info(`run ${session.id} — trace: ${session.tracePath ?? "disabled"}`);
        break;
      case "clear": {
        if (!session) {
          this.view.info("no run to clear — send a message first");
          break;
        }
        this.model = session.model; // keep a /model switch across the clear
        const outcome = await session.end();
        this.cycles = 0;
        if (outcome.error) this.view.error(`previous run ended with an error: ${outcome.error}`);
        // Reflection of the closed run runs in the background — it makes an
        // LLM call and must not block the next conversation.
        void reflectRunById(session.id).catch(() => undefined);
        this.session = undefined;
        this.view.info("run closed — the next message starts a fresh one");
        this.updateFooter();
        break;
      }
      case "compact": {
        if (!session) {
          this.view.info("no run to compact — send a message first");
          break;
        }
        const usage = session.contextUsage();
        if (usage.usedTokens < COMPACT_MIN_TOKENS) {
          this.view.info(
            `context is small (~${usage.usedTokens} tok vs ${usage.ceilingTokens} forced line) — nothing worth folding`,
          );
          break;
        }
        session.requestCompact();
        this.view.info(
          `compact requested — the context (~${usage.usedTokens} tok) folds at the next request (forced line ${usage.ceilingTokens})`,
        );
        break;
      }
      case "quit":
      case "exit":
        this.requestQuit();
        break;
      default:
        this.view.error(`unknown command /${name} — try /help`);
    }
  }

  /** Same convention as RunManager: memory lives beside the default database. */
  private memoryDir(): string {
    return path.join(harnessDataDir(process.cwd()), "memory");
  }

  private addChip(text: string): void {
    const component = new Text(t.dim(`↳ ${text.replace(/\s+/g, " ")}  (queued)`));
    this.pendingContainer.addChild(component);
    this.chips.push({ text: text.replace(/\s+/g, " "), component });
  }

  private retireChip(text: string): void {
    const normalized = text.replace(/\s+/g, " ").trim();
    const index = this.chips.findIndex((chip) => chip.text === normalized);
    if (index === -1) return;
    const [chip] = this.chips.splice(index, 1);
    if (chip) this.pendingContainer.removeChild(chip.component);
  }

  private updateFooter(): void {
    const session = this.session;
    const usage = session?.usage();
    const parts = [
      session ? session.modelSpec : `${this.model.provider}/${this.model.id}`,
      `approval ${this.approvalOptions.mode}`,
      this.cycles > 0 ? `${this.cycles} cycle(s)` : "no run yet",
    ];
    if (session) {
      const ctx = session.contextUsage();
      parts.push(`ctx ~${(ctx.usedTokens / 1000).toFixed(1)}k/${(ctx.inputBudgetTokens / 1000).toFixed(0)}k`);
    }
    if (usage) {
      parts.push(`${(usage.totalTokens / 1000).toFixed(1)}k tok`, `$${usage.cost.total.toFixed(4)}`);
    }
    parts.push("Esc interrupt", "Ctrl+D exit", "/help");
    this.footer.setText(t.dim(parts.join(" · ")));
  }
}
