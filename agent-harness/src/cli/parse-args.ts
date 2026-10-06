/**
 * CLI argument parsing, extracted from index.ts so it can be unit-tested
 * (the CLI entry file auto-runs main() on import, so it cannot be imported
 * by tests). 加固期 fix: `--yolo true` used to store the STRING "true", which
 * failed every `flags.yolo === true` check and silently downgraded to
 * interactive approval. Switch flags now coerce "true"/"1"/"false"/"0".
 *
 * 加固期 fix 2 (值吞没): switch flags used to swallow the NEXT TOKEN as their
 * value, so `resume --yolo <runId>` consumed the runId into flags.yolo —
 * the command silently resumed "the latest interrupted run" instead of the
 * requested one, while the string value ALSO failed the `flags.yolo === true`
 * check and downgraded approval to interactive. Switch flags now consume only
 * a boolean literal; unknown flags are rejected outright so a mistyped safety
 * switch (`--dryrun` for `--dry-run`) fails loudly instead of falling through
 * to the destructive default.
 */

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that are pure switches — `--flag` alone is the intended usage. */
const SWITCH_FLAGS = new Set([
  "yolo",
  "chat",
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
  "json",
  "no-skills",
]);

/** Flags that take a value — the next non-`--` token is consumed as the value. */
const VALUE_FLAGS = new Set([
  "approval",
  "capabilities",
  "fault",
  "keep-runs",
  "limit",
  "min-support",
  "model",
  "repeats",
  "skill",
  "tool",
  "tools",
  "until",
]);

function coerceSwitch(value: string): string | boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const eq = name.indexOf("=");
      if (eq > 0) {
        const key = name.slice(0, eq);
        if (SWITCH_FLAGS.has(key)) flags[key] = coerceSwitch(name.slice(eq + 1));
        else if (VALUE_FLAGS.has(key)) flags[key] = name.slice(eq + 1);
        else throw new Error(`unknown option --${key}`);
        continue;
      }
      if (SWITCH_FLAGS.has(name)) {
        const next = argv[i + 1];
        // A switch consumes the next token only when it is a boolean literal
        // (`--yolo true`); anything else stays positional — `--yolo <runId>`
        // must never eat the runId.
        if (next === "true" || next === "1" || next === "false" || next === "0") {
          flags[name] = coerceSwitch(next);
          i++;
        } else {
          flags[name] = true;
        }
      } else if (VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true; // bare value flag — callers treat non-strings as absent
        }
      } else {
        throw new Error(`unknown option --${name}`);
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }
  return { command: command ?? "help", positional, flags };
}
