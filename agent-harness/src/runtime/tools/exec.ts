import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const MAX_OUTPUT_CHARS = 8_000;
const MAX_TIMEOUT_MS = 600_000;
/**
 * 加固期修复: the outer withToolTimeout wrapper used to fire at the run-wide
 * default (120s), so a model-requested `timeout_ms: 300000` (documented up to
 * 600000) was killed long before its own timer. exec now declares its own
 * override — the wrapper ceiling sits just above the clamp so the INNER timer
 * (the one that reports timedOut) is always the one that fires.
 */
const OUTER_TIMEOUT_MS = MAX_TIMEOUT_MS + 5_000;
/** OOM guard: a streaming command (`yes`, cat bigfile) must not accumulate
 * without bound inside the timeout window; the 8K result clip happens only
 * after the child exits. */
const MAX_ACCUMULATED_CHARS = 1_000_000;

const parameters = Type.Object({
  command: Type.String({ description: "Shell command to run in the workspace root" }),
  timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds, 1000-600000 (default 30000)" })),
});

export type ExecDetails = { exitCode: number | null; timedOut: boolean };

/**
 * 加固期 (P1): the demo exec tool is a real shell — so the child runs with a
 * MINIMAL environment whitelist (no inherited API keys or misc secrets), the
 * timeout kills the whole PROCESS TREE (a shell's grandchildren survive a
 * plain child kill), and the outer AbortSignal is honored. Windows: cmd.exe +
 `taskkill /T`; POSIX: detached process group + SIGKILL on the group.
 */

const ENV_ALLOWLIST =
  process.platform === "win32"
    ? [
        "PATH",
        "PATHEXT",
        "COMSPEC",
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "HOMEDRIVE",
        "HOMEPATH",
        "NUMBER_OF_PROCESSORS",
        "OS",
        "PROCESSOR_ARCHITECTURE",
        "WINDIR",
      ]
    : ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "USER", "LOGNAME"];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Visible marker: processes can detect they run inside a whitelisted env.
  env.HARNESS_SANDBOXED_ENV = "1";
  return env;
}

/** Kill the whole process tree; POSIX needs a detached group for that. */
function killTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Non-zero exit codes are a normal tool result (the model should see them),
 * so only thrown errors are surfaced as isError tool results.
 */
export const execTool: AgentTool<typeof parameters, ExecDetails> = {
  name: "exec",
  label: "Exec",
  description: "Run a shell command in the workspace root and return stdout/stderr and the exit code.",
  parameters,
  replay: "never",
  execute: async (_toolCallId, args, signal) => {
    const rawTimeout = args.timeout_ms ?? 30_000;
    const timeout = Math.min(Math.max(rawTimeout, 1_000), MAX_TIMEOUT_MS);

    const isWindows = process.platform === "win32";
    const shell = isWindows ? (process.env.COMSPEC ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh");
    const shellArgs = isWindows ? ["/d", "/s", "/c", args.command] : ["-c", args.command];
    const child = spawn(shell, shellArgs, {
      cwd: process.cwd(),
      env: childEnv(),
      windowsHide: true,
      detached: !isWindows, // own process group → the tree is killable
      stdio: ["ignore", "pipe", "pipe"],
    });

    const done = new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
      timedOut: boolean;
      aborted: boolean;
    }>((resolve) => {
      let stdout = "";
      let stderr = "";
      // Accumulation caps: once over the ceiling the stream is dropped (head
      // kept) — output past 1MB is useless to the model and fatal to memory.
      child.stdout?.on("data", (chunk) => {
        if (stdout.length < MAX_ACCUMULATED_CHARS) stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < MAX_ACCUMULATED_CHARS) stderr += String(chunk);
      });
      let settled = false;
      const finish = (code: number | null, timedOut: boolean, aborted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, code, timedOut, aborted });
      };
      const onAbort = () => {
        killTree(child);
        finish(null, false, true);
      };
      const timer = setTimeout(() => {
        killTree(child);
        finish(null, true, false);
      }, timeout);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", () => finish(127, false, false));
      child.on("close", (code) => finish(code, false, false));
    });

    const result = await done;
    const clip = (s: string) => (s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n…(truncated)" : s);
    const text = [
      `exit code: ${result.code}${result.timedOut ? " (timed out)" : ""}${result.aborted ? " (aborted)" : ""}`,
      result.stdout.trim() ? `stdout:\n${clip(result.stdout)}` : "stdout: (empty)",
      result.stderr.trim() ? `stderr:\n${clip(result.stderr)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      content: [{ type: "text", text }],
      details: { exitCode: result.code, timedOut: result.timedOut },
    };
  },
};

// tools/timeout.ts reads the per-tool override via a structural cast — pi's
// AgentTool has no such field, so it rides outside the typed literal above
// (same pattern as the explore subagent).
(execTool as { timeoutMs?: number }).timeoutMs = OUTER_TIMEOUT_MS;
