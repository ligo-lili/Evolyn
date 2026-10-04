import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Memory v3 数据模型（§4.2）：
 *
 * One Ordinary Memory = one Markdown file with YAML frontmatter:
 *   id (M001…), title, summary, keywords, revision, status, provenance and
 *   access metadata; the Markdown body IS the memory content. `revision` is
 *   the optimistic-lock version (incremented on every full replacement);
 *   `status` is "active" | "archive". SQLite holds only derived, rebuildable
 *   projections (chunk index + FTS + vectors).
 */

export type MemoryStatus = "active" | "archive";

export interface MemoryRecord {
  /** M001, M002, … — allocated by the store, never model-chosen. */
  id: string;
  title: string;
  summary: string;
  /** The memory content = the Markdown body (full replacement on update). */
  content: string;
  keywords: string[];
  /** Optimistic-lock version: every full replacement increments it. */
  revision: number;
  status: MemoryStatus;
  /** Provenance: the run that created this memory (修改可追溯, 设计 P5). */
  sourceRunId?: string;
  /** Provenance: the reflection model that wrote it. */
  model?: string;
  created: string;
  updated: string;
  lastAccessed?: string;
  accessCount: number;
}

/** 自增 id（M001…）— the only legal memory id shape. */
export const MEMORY_ID_PATTERN = /^M\d{3,}$/;

export const MEMORY_FIELDS = [
  "id",
  "title",
  "summary",
  "keywords",
  "revision",
  "status",
  "sourceRunId",
  "model",
  "created",
  "updated",
  "lastAccessed",
  "accessCount",
] as const;

export function isValidMemoryId(id: string): boolean {
  return MEMORY_ID_PATTERN.test(id);
}

export function serializeMemory(record: MemoryRecord): string {
  const frontmatter = stringifyYaml({
    id: record.id,
    title: record.title,
    summary: record.summary,
    keywords: record.keywords,
    revision: record.revision,
    status: record.status,
    ...(record.sourceRunId ? { source_run_id: record.sourceRunId } : {}),
    ...(record.model ? { model: record.model } : {}),
    created: record.created,
    updated: record.updated,
    ...(record.lastAccessed ? { last_accessed: record.lastAccessed } : {}),
    access_count: record.accessCount,
  });
  return `---\n${frontmatter}---\n${record.content.trim()}\n`;
}

export function parseMemory(raw: string, source: string): MemoryRecord {
  if (!raw.startsWith("---")) throw new Error(`${source}: missing frontmatter`);
  const end = raw.indexOf("\n---", 3);
  if (end === -1) throw new Error(`${source}: unterminated frontmatter`);
  const meta = (parseYaml(raw.slice(3, end)) ?? {}) as Record<string, unknown>;
  // Validate the id BEFORE the completeness checks so a hostile id is never
  // waved through on a missing-field technicality.
  const id = String(meta.id ?? "");
  if (!MEMORY_ID_PATTERN.test(id)) {
    throw new Error(`${source}: invalid id "${id}" (must match ${MEMORY_ID_PATTERN})`);
  }
  for (const field of ["title", "summary", "revision", "status", "created", "updated"] as const) {
    if (meta[field] === undefined) throw new Error(`${source}: frontmatter missing "${field}"`);
  }
  const status = String(meta.status);
  if (status !== "active" && status !== "archive") {
    throw new Error(`${source}: invalid status "${status}"`);
  }
  const revision = Number(meta.revision);
  if (!Number.isFinite(revision) || revision < 1) {
    // NaN 会让乐观锁比较永远走冲突分支——解析期就拒绝，错误更可读。
    throw new Error(`${source}: invalid revision "${String(meta.revision)}"`);
  }
  const content = raw.slice(raw.indexOf("\n", end + 1) + 1).trim();
  return {
    id,
    title: String(meta.title).trim(),
    summary: String(meta.summary).trim(),
    content,
    keywords: Array.isArray(meta.keywords) ? meta.keywords.map(String).filter(Boolean) : [],
    revision,
    status: status as MemoryStatus,
    sourceRunId: meta.source_run_id == null ? undefined : String(meta.source_run_id),
    model: meta.model == null ? undefined : String(meta.model),
    created: String(meta.created),
    updated: String(meta.updated),
    lastAccessed: meta.last_accessed == null ? undefined : String(meta.last_accessed),
    accessCount: Number(meta.access_count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// 切块: 段落累积切块，每块携带 title|summary 语义头部，块计算
// sha256 作为内容身份。900 字符/块、180 字符重叠、每记忆 ≤16 块。
// ---------------------------------------------------------------------------

export const CHUNK_CHARS = 900;
export const CHUNK_OVERLAP = 180;
export const MAX_CHUNKS_PER_MEMORY = 16;

/** sha256 content identity of one chunk (text_sha256). */
export function chunkSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface MemoryChunk {
  index: number;
  /** The embedded/FTS text: semantic header + content slice. */
  text: string;
  sha256: string;
}

/**
 * 段落累积切块。语义头部（`title | summary`）让向量与 FTS 两路都能利用
 * Recall Cue；第 2 块起统一前置上一块尾部 ≤180 字符的重叠，保证跨块上下文
 * 连续；单记忆硬上限 16 块（超出部分截断，全文仍在权威 Markdown 里）。
 */
export function chunkMemory(record: Pick<MemoryRecord, "title" | "summary" | "content">): MemoryChunk[] {
  const header = `title: ${record.title} | summary: ${record.summary}`;
  const paragraphs = record.content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const blocks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    // A single oversized paragraph is hard-split on its own (no overlap here —
    // the uniform tail-overlap below already covers the seam).
    if (paragraph.length > CHUNK_CHARS) {
      if (current) {
        blocks.push(current);
        current = "";
      }
      for (let i = 0; i < paragraph.length; i += CHUNK_CHARS) {
        blocks.push(paragraph.slice(i, i + CHUNK_CHARS));
      }
      continue;
    }
    if (current && current.length + 2 + paragraph.length > CHUNK_CHARS) {
      blocks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) blocks.push(current);

  return blocks.slice(0, MAX_CHUNKS_PER_MEMORY).map((block, index) => {
    const overlap = index > 0 ? blocks[index - 1]!.slice(-CHUNK_OVERLAP) : "";
    const text = `${header}\n${overlap ? `${overlap}\n` : ""}${block}`;
    return { index, text, sha256: chunkSha256(text) };
  });
}
