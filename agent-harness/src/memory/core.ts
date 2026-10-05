import fs from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writeFileAtomic } from "./atomic.js";

/**
 * Core Memory: 用户身份、稳定偏好、全局约束——每 Run 常驻
 * system prompt。
 *
 * - CORE.md 是权威文件：frontmatter 里的 `entries` 是结构化条目，正文是
 *   自由备注；
 * - 模型不能覆盖整份 CORE.md，只能按 key upsert 单条（core_memory_update）；
 * - 每条 entry 强制携带 reason（为什么改）与 source_statement（用户原话
 *   证据）——修改可追溯到证据（设计 P5）;
 * - 注入按 2000 token 预算裁剪（≈4 chars/token；超限时从最旧更新的条目
 *   开始舍弃，至少保留一条）。
 */

export const CORE_MAX_TOKENS = 2000;
/** Conservative chars-per-token for budget arithmetic (consistent with the
 * calibrated estimator's openai floor). */
const CHARS_PER_TOKEN = 4;

export interface CoreEntry {
  key: string;
  content: string;
  /** Why this entry was written/changed (强制). */
  reason: string;
  /** Verbatim user evidence backing the entry (强制). */
  sourceStatement: string;
  updated: string;
}

export interface CoreFile {
  entries: CoreEntry[];
  /** Freeform notes below the frontmatter (injected after entries). */
  notes: string;
}

const CORE_FRONTMATTER_KEYS = ["reason", "sourceStatement"] as const;

function entryKey(value: unknown): string {
  return String(value ?? "").trim();
}

function entryField(entry: Omit<CoreEntry, "updated">, field: (typeof CORE_FRONTMATTER_KEYS)[number]): string {
  return String(entry[field] ?? "").trim();
}

export function parseCore(raw: string, _source = "CORE.md"): CoreFile {
  if (!raw.startsWith("---")) return { entries: [], notes: raw.trim() };
  const end = raw.indexOf("\n---", 3);
  // 加固期修复: an unterminated frontmatter used to be silently re-interpreted
  // as freeform notes — a hand-edited broken CORE.md then got clobbered by the
  // next core_update. Fail loudly: reads degrade to "no core" (readCoreFile
  // catches), writes refuse via the store's broken-file guard.
  if (end === -1) throw new Error(`${_source}: unterminated frontmatter`);
  const meta = (parseYaml(raw.slice(3, end)) ?? {}) as Record<string, unknown>;
  const list = Array.isArray(meta.entries) ? meta.entries : [];
  const entries: CoreEntry[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    const key = entryKey(m.key);
    if (!key) continue;
    entries.push({
      key,
      content: String(m.content ?? "").trim(),
      reason: String(m.reason ?? "").trim(),
      sourceStatement: String(m.source_statement ?? m.sourceStatement ?? "").trim(),
      updated: String(m.updated ?? ""),
    });
  }
  return { entries, notes: raw.slice(raw.indexOf("\n", end + 1) + 1).trim() };
}

export function serializeCore(file: CoreFile): string {
  const frontmatter = stringifyYaml({
    entries: file.entries.map((e) => ({
      key: e.key,
      content: e.content,
      reason: e.reason,
      source_statement: e.sourceStatement,
      updated: e.updated,
    })),
  });
  return `---\n${frontmatter}---\n${file.notes ? `${file.notes}\n` : ""}`;
}

/**
 * 按 key upsert 单条（禁整份覆盖）。reason 与 source_statement 必填——
 * 程序硬校验，不信任调用方自觉。
 */
export function upsertCoreEntry(file: CoreFile, entry: Omit<CoreEntry, "updated">): CoreFile {
  const key = entryKey(entry.key);
  if (!key) throw new Error("core memory entry requires a key");
  if (!entry.content.trim()) throw new Error(`core memory entry "${key}" requires content`);
  for (const field of CORE_FRONTMATTER_KEYS) {
    if (!entryField(entry, field)) {
      throw new Error(`core memory entry "${key}" requires "${field}" (修改必须可追溯)`);
    }
  }
  const now = new Date().toISOString();
  const next = file.entries.filter((e) => e.key !== key);
  next.push({
    key,
    content: entry.content.trim(),
    reason: entry.reason.trim(),
    sourceStatement: entry.sourceStatement.trim(),
    updated: now,
  });
  return { ...file, entries: next };
}

function renderedEntry(entry: CoreEntry): string {
  return `- ${entry.key}: ${entry.content}`;
}

/** Render entries + notes for system-prompt injection within the token budget. */
export function renderCore(file: CoreFile, maxTokens = CORE_MAX_TOKENS): string {
  const budgetChars = maxTokens * CHARS_PER_TOKEN;
  const parts: string[] = [];
  let used = 0;
  const notes = file.notes ? `# Notes\n${file.notes}` : "";
  // Entries first (they are the contract); oldest-updated dropped first when
  // the budget overflows. At least one entry always survives.
  const ordered = [...file.entries].sort((a, b) => a.updated.localeCompare(b.updated));
  const kept: CoreEntry[] = [];
  for (let i = ordered.length - 1; i >= 0; i--) {
    const entry = ordered[i]!;
    const text = renderedEntry(entry);
    if (kept.length > 0 && used + text.length + 1 > budgetChars) break;
    kept.unshift(entry);
    used += text.length + 1;
  }
  if (kept.length > 0) parts.push(kept.map(renderedEntry).join("\n"));
  if (notes) {
    if (used + notes.length + 2 <= budgetChars) {
      parts.push(notes);
    } else if (kept.length === 0) {
      // 没有条目可保时 notes 是唯一内容——按预算硬裁剪并标注，绝不整体超限注入。
      parts.push(`${notes.slice(0, Math.max(budgetChars, 0))}…(trimmed to the injection budget)`);
    }
  }
  return parts.join("\n\n");
}

/** Load CORE.md; undefined when the file does not exist yet. */
export function readCoreFile(corePath: string): CoreFile | undefined {
  try {
    return parseCore(fs.readFileSync(corePath, "utf8"), corePath);
  } catch {
    return undefined;
  }
}

export function writeCoreFile(corePath: string, file: CoreFile): void {
  // 与记忆文件同一原子写原语（§10）：CORE.md 绝不因写中途崩溃而截断。
  writeFileAtomic(corePath, serializeCore(file));
}

/** A fresh CORE.md skeleton (CLI bootstrap; entries start empty). */
export function defaultCoreFile(): CoreFile {
  return {
    entries: [],
    notes:
      "<项目级事实、用户偏好、长期约束。每轮 run 都会注入 system prompt。条目由 core_memory_update 按 key 维护，须携带 reason 与 source_statement。>",
  };
}
