import { exec } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const MAX_OUTPUT_CHARS = 8_000;

const parameters = Type.Object({
  command: Type.String({ description: "Shell command to run in the workspace root" }),
  timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default 30000)" })),
});

export type ExecDetails = { exitCode: number | null; timedOut: boolean };

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
  execute: async (_toolCallId, args) => {
    const timeout = args.timeout_ms ?? 30_000;
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>(
      (resolve) => {
        const child = exec(
          args.command,
          { cwd: process.cwd(), timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const timedOut = Boolean(err && err.killed);
            const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
            resolve({ stdout: String(stdout), stderr: String(stderr), code, timedOut });
          },
        );
        child.on("error", () => {
          resolve({ stdout: "", stderr: "failed to spawn process", code: 127, timedOut: false });
        });
      },
    );
    const clip = (s: string) => (s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n…(truncated)" : s);
    const text = [
      `exit code: ${result.code}${result.timedOut ? " (timed out)" : ""}`,
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
