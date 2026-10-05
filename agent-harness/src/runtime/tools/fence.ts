import fs from "node:fs";
import path from "node:path";
import { harnessDataDir, resolveWorkspacePath } from "../paths.js";
import { permissionsFor } from "../permissions.js";
import type { AnyAgentTool } from "./index.js";

/**
 * 加固期 (P0) path fence for tool arguments. pi's coding tools accept any
 * absolute path, so a prompt-injected model could read/write outside the
 * workspace (including .harness/ itself). Two checks per candidate path:
 *   1. lexical — resolveWorkspacePath refuses `..`/absolute escapes;
 *   2. symlink — realpath the deepest EXISTING ancestor (the target itself may
 *      not exist yet for writes) and refuse anything that lands outside the
 *      realpathed root.
 * Best-effort TOCTOU caveat is accepted: the fence runs at every execution.
 *
 * 加固期复核 additions:
 *   - NTFS alternate data streams ("file.txt:ads") cannot escape the root
 *     directory, but they hide payloads inside workspace files invisible to
 *     normal listings — a colon beyond the drive specifier is rejected
 *     outright (Windows only; POSIX filenames legally contain colons).
 *   - Known NON-goals (documented posture): shell tools are NOT fenced (the
 *     capability gate + approval own `process:exec`), and a pnpm-style
 *     node_modules junction into a store outside the root is REJECTED
 *     fail-closed (reading installed deps there requires lifting the fence
 *     for that prefix explicitly — a policy decision, not a silent default).
 *
 * 加固期第二轮: structured file writers (fs:write WITHOUT process:exec — i.e.
 * write/edit/write_file, not shell-class tools) additionally refuse paths that
 * resolve INTO the harness state dir (.harness): memory files, traces and the
 * db were otherwise writable with a plain write tool, bypassing the memory
 * store's cross-process locks, history snapshots, INDEX projection and the
 * three write gates. The check is lexical + realpath-based (a junction alias
 * into .harness cannot dodge it, and the lexical layer also holds before the
 * dir exists) and one-directional: readers are unaffected, the sanctioned
 * memory tools write through the store (their args are ids, not paths), and
 * shell-class tools stay the documented non-goal above.
 */

function assertNoStreamSpecifier(resolved: string, raw: string): void {
  if (process.platform !== "win32") return;
  const withoutDrive = resolved.replace(/^[A-Za-z]:/, "");
  if (withoutDrive.includes(":")) {
    throw new Error(`path contains an NTFS stream specifier (colon): ${raw}`);
  }
}

function assertInsideRealRoot(root: string, resolved: string): void {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return; // no root, no fence — the tool will surface its own error
  }
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(probe);
  } catch {
    return; // unreadable ancestor — let the tool surface its own error
  }
  const rel = path.relative(realRoot, real);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace root through a symlink: ${resolved}`);
  }
}

const FENCED_KEYS = ["path", "cwd", "dir"] as const;

/**
 * 加固期第二轮: structured writers are tools that require fs:write but NOT
 * process:exec. Shell-class tools can reach .harness by exec anyway, so
 * fencing their path arguments would buy nothing and imply a boundary that
 * does not exist; the structured writers are the ones where a path argument is
 * the actual write mechanism.
 */
function isStructuredWriter(toolName: string): boolean {
  const caps = permissionsFor(toolName).capabilities;
  return caps.includes("fs:write") && !caps.includes("process:exec");
}

/**
 * Refuse a structured WRITE whose target resolves into the harness state dir.
 * Two layers: a LEXICAL check that also holds before the dir exists (a writer
 * must never be the thing that creates `.harness` — 加固期第五轮), and a
 * realpath probe (mirroring assertInsideRealRoot) so `alias -> .harness`
 * junctions and dot-segment spellings normalize correctly.
 *
 * Known non-goals (documented scope): hard links are invisible to realpath
 * (they require a same-volume link created outside the run); the guard covers
 * the DEFAULT state location only — state relocated via the programmatic
 * API's custom database/traceDir is out of scope; and a new structured writer
 * must be registered in TOOL_PERMISSIONS to be recognized as one.
 */
function assertNotHarnessStateWrite(root: string, resolved: string, raw: string): void {
  const refuse = (): never => {
    throw new Error(
      `refusing to write into the harness state directory (${raw}) — it holds the memory store, traces and the ledger; ` +
        `use the memory tools for memory files`,
    );
  };
  const lexicalRel = path.relative(path.resolve(root), resolved);
  if (lexicalRel === ".harness" || lexicalRel.startsWith(".harness" + path.sep)) refuse();
  let realState: string;
  try {
    realState = fs.realpathSync(harnessDataDir(root));
  } catch {
    return; // dir absent — the lexical layer already covered the literal path
  }
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(probe);
  } catch {
    return; // unreadable ancestor — let the tool surface its own error
  }
  const rel = path.relative(realState, real);
  const inside = rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
  if (inside) refuse();
}

/** Wrap every tool so path-like arguments must stay inside the workspace root. */
export function withPathFence(tools: readonly AnyAgentTool[], root: string = process.cwd()): AnyAgentTool[] {
  return tools.map((tool) => {
    const stateDirGuarded = isStructuredWriter(tool.name);
    return {
      ...tool,
      execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
        if (params && typeof params === "object") {
          for (const key of FENCED_KEYS) {
            const value = (params as Record<string, unknown>)[key];
            if (typeof value !== "string" || !value.trim()) continue;
            const resolved = resolveWorkspacePath(root, value); // throws on lexical escape
            assertNoStreamSpecifier(resolved, value);
            assertInsideRealRoot(root, resolved);
            if (stateDirGuarded) assertNotHarnessStateWrite(root, resolved, value);
          }
        }
        return tool.execute(toolCallId, params, signal, onUpdate);
      },
    };
  });
}
