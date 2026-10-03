import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { sendNotificationTool } from "./send-notification.js";
import { createExploreTool, type ExploreToolDeps } from "./explore.js";

/**
 * 阶段 13 coding toolset: pi's own coding tools (read/edit/write/grep/ls/find
 * + a shell tool) wrapped into harness AgentTools. pi's `AgentTool` type
 * defines `replay?: "never" | "safe"`, but its coding-tool factories leave it
 * unset — the marker is attached HERE so crash recovery and retry tiering
 * share one vocabulary; capabilities live in permissions.ts keyed by tool name.
 *
 * Windows reality (verified 2026-09-27): pi's bash tool resolves to WSL on
 * this machine (no distro → execvpe /bin/bash fails), so win32 defaults to
 * createPowerShellTool; `shell: "bash"` overrides for git-bash/WSL setups.
 * send_notification stays in the set: the fault-injection demo depends on it.
 */

export type HarnessTool = AgentTool<any, any>;

function withReplay<T extends HarnessTool>(tool: T, replay: "safe" | "never"): T {
  return { ...tool, replay } as T;
}

export interface CodingToolsetOptions {
  /** Shell tool for the set. Default: powershell on win32, bash elsewhere. */
  shell?: "bash" | "powershell";
  /**
   * Phase-1 read-only subagent. Provided → the `explore` tool joins the set
   * (it needs run-level deps: model/streamFn/evidence/charge/audit). Omitted
   * → the toolset stays exactly as before (eval baselines comparable).
   */
  explore?: ExploreToolDeps;
}

export function createCodingToolset(cwd: string = process.cwd(), options: CodingToolsetOptions = {}): HarnessTool[] {
  const shell = options.shell ?? (process.platform === "win32" ? "powershell" : "bash");
  const shellTool = shell === "powershell" ? createPowerShellTool(cwd) : createBashTool(cwd);
  const tools: HarnessTool[] = [
    withReplay(createReadTool(cwd), "safe"),
    // edit/write are "safe" by argument: write overwrites the whole file
    // (idempotent); a re-executed edit whose first pass already landed fails
    // its oldText match and surfaces an error result — noisy, never corrupting.
    withReplay(createEditTool(cwd), "safe"),
    withReplay(createWriteTool(cwd), "safe"),
    withReplay(createGrepTool(cwd), "safe"),
    withReplay(createLsTool(cwd), "safe"),
    withReplay(createFindTool(cwd), "safe"),
    withReplay(shellTool, "never"), // shell commands can double side effects (git commit, npm install, …)
    sendNotificationTool, // replay: "never" — the fault-injection demo depends on it
  ];
  if (options.explore) tools.push(createExploreTool(options.explore));
  return tools;
}
