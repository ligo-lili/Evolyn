/**
 * CLI argument parsing, extracted from index.ts so it can be unit-tested
 * (the CLI entry file auto-runs main() on import, so it cannot be imported
 * by tests). 加固期 fix: `--yolo true` used to store the STRING "true", which
 * failed every `flags.yolo === true` check and silently downgraded to
 * interactive approval. Switch flags now coerce "true"/"1" to boolean.
 */

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that are pure switches — `--flag true` must behave like `--flag`. */
const SWITCH_FLAGS = new Set([
  "yolo",
  "no-distill",
  "force",
  "yes",
  "all",
  "errors",
  "hybrid",
  "vector",
  "edit",
  "against-baseline",
  "deep",
  "dry-run",
]);

function coerceSwitch(name: string, value: string): string | boolean {
  return SWITCH_FLAGS.has(name) && (value === "true" || value === "1") ? true : value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        flags[arg.slice(2, eq)] = coerceSwitch(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[arg.slice(2)] = coerceSwitch(arg.slice(2), next);
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }
  return { command: command ?? "help", positional, flags };
}
