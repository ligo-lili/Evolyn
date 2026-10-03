import fs from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "../paths.js";
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

/** Wrap every tool so path-like arguments must stay inside the workspace root. */
export function withPathFence(tools: readonly AnyAgentTool[], root: string = process.cwd()): AnyAgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      if (params && typeof params === "object") {
        for (const key of FENCED_KEYS) {
          const value = (params as Record<string, unknown>)[key];
          if (typeof value !== "string" || !value.trim()) continue;
          const resolved = resolveWorkspacePath(root, value); // throws on lexical escape
          assertNoStreamSpecifier(resolved, value);
          assertInsideRealRoot(root, resolved);
        }
      }
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  }));
}
