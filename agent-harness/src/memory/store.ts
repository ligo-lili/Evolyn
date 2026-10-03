import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { HarnessError } from "../errors.js";
import { writeFileAtomic } from "./atomic.js";
import {
  readCoreFile,
  writeCoreFile,
  defaultCoreFile,
  renderCore,
  serializeCore,
  upsertCoreEntry,
  type CoreFile,
} from "./core.js";
import { parseMemory, serializeMemory, isValidMemoryId, type MemoryRecord, type MemoryStatus } from "./model.js";

/**
 * MemoryStore（设计 §4.3 / §10）— Markdown 是唯一权威存储（P1）。
 *
 * 布局（.harness/memory/）:
 *   CORE.md           — Core Memory（结构化 entries，见 core.ts）
 *   INDEX.md          — active 记忆索引（投影，每次写操作后重建）
 *   active/M001.md    — 普通记忆（带 frontmatter）
 *   archive/M001.md   — 归档，默认不可检索
 *   legacy/           — v2 布局（ordinary/<slug>.md）一次性导入后的原件留存
 *
 * 写入全部采用 临时文件 + fsync + rename 原子替换（atomic.ts，CORE.md 共用）；
 * 单文件上限 512KB；并发经进程内互斥（promise 队列）串行——Windows 无 fcntl，
 * 跨进程文件锁是已知边界（设计 §14.1）。
 */

export const MAX_ACTIVE_MEMORIES = 25;
export { MAX_MEMORY_FILE_BYTES } from "./atomic.js";

/** 乐观锁冲突（设计 P6）：调用方据此降级或重读。 */
export class MemoryConflictError extends HarnessError {
  constructor(id: string, expectedRevision: number) {
    super(`memory "${id}" changed since revision ${expectedRevision} — re-read and retry`);
    this.name = "MemoryConflictError";
  }
}

export class MemoryCapacityError extends HarnessError {
  constructor(limit: number) {
    super(`active memory capacity exhausted (${limit}) — archive or update instead`);
    this.name = "MemoryCapacityError";
  }
}

export class MemoryNotFoundError extends HarnessError {
  constructor(id: string) {
    super(`memory "${id}" not found`);
    this.name = "MemoryNotFoundError";
  }
}

/** 进程内互斥（P6）：写操作串行化。跨进程锁见设计 §14.1 已知边界。 */
class MutationGuard {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class MemoryStore {
  private readonly guard = new MutationGuard();

  constructor(readonly dir: string) {
    this.ensureLayout();
  }

  private ensureLayout(): void {
    for (const sub of ["active", "archive"]) {
      try {
        fs.mkdirSync(path.join(this.dir, sub), { recursive: true });
      } catch {
        // unwritable dir surfaces on the first real write
      }
    }
    this.importLegacyLayout();
  }

  /** v2 (ordinary/<slug>.md) → v3 one-time import: convert into active/M###.md
   * and move the original into legacy/ so nothing authoritative is destroyed. */
  private importLegacyLayout(): void {
    const legacyDir = path.join(this.dir, "ordinary");
    let files: string[];
    try {
      files = fs.readdirSync(legacyDir).filter((f) => f.endsWith(".md"));
    } catch {
      return;
    }
    for (const name of files) {
      const file = path.join(legacyDir, name);
      try {
        const legacy = parseLegacyMemory(fs.readFileSync(file, "utf8"), file);
        const id = this.nextId();
        const record: MemoryRecord = {
          id,
          title: legacy.summaryEn || legacy.taskType,
          summary: legacy.summaryZh || legacy.summaryEn,
          content: [legacy.approach, legacy.pitfalls].filter(Boolean).join("\n\n"),
          keywords: legacy.keywordsEn,
          revision: 1,
          status: "active",
          sourceRunId: legacy.runId || undefined,
          model: legacy.model,
          created: legacy.created,
          updated: legacy.updated,
          accessCount: 0,
        };
        writeFileAtomic(this.pathOf(id, "active"), serializeMemory(record));
        fs.mkdirSync(path.join(this.dir, "legacy"), { recursive: true });
        fs.renameSync(file, path.join(this.dir, "legacy", name));
        process.stderr.write(`[memory] imported legacy memory ${name} as ${id}\n`);
      } catch (err) {
        process.stderr.write(
          `[memory] legacy import skipped for ${file}: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }
  }

  get corePath(): string {
    return path.join(this.dir, "CORE.md");
  }

  get indexPath(): string {
    return path.join(this.dir, "INDEX.md");
  }

  // ---- Core Memory ---------------------------------------------------------

  readCoreFile(): CoreFile | undefined {
    return readCoreFile(this.corePath);
  }

  /** Structured core within the injection budget; undefined when no CORE.md. */
  readCore(maxTokens?: number): string | undefined {
    const file = readCoreFile(this.corePath);
    if (!file) return undefined;
    return renderCore(file, maxTokens);
  }

  /** Bootstrap CORE.md (CLI); never overwrites an existing file. */
  ensureCore(): void {
    if (fs.existsSync(this.corePath)) return;
    writeFileAtomic(this.corePath, serializeCore(defaultCoreFile()));
  }

  /** 按 key upsert 单条 Core entry —— 模型唯一合法的 Core 修改方式（禁整份覆盖）。 */
  async coreUpdate(entry: { key: string; content: string; reason: string; sourceStatement: string }): Promise<void> {
    await this.guard.run(() => {
      const file = readCoreFile(this.corePath) ?? defaultCoreFile();
      writeCoreFile(this.corePath, upsertCoreEntry(file, entry));
      return undefined;
    });
  }

  // ---- Ordinary Memory -----------------------------------------------------

  /** id → path choke point: only M### ids can ever reach the filesystem. */
  pathOf(id: string, status: MemoryStatus = "active"): string {
    if (!isValidMemoryId(id)) throw new HarnessError(`invalid memory id: ${id}`);
    return path.join(this.dir, status === "archive" ? "archive" : "active", `${id}.md`);
  }

  /** Next sequential id (M001…) across active + archive. */
  nextId(): string {
    let max = 0;
    for (const status of ["active", "archive"] as const) {
      let files: string[];
      try {
        files = fs.readdirSync(path.join(this.dir, status));
      } catch {
        continue;
      }
      for (const f of files) {
        const match = /^M(\d+)\.md$/.exec(f);
        if (match) max = Math.max(max, Number(match[1]));
      }
    }
    return `M${String(max + 1).padStart(3, "0")}`;
  }

  private readAt(file: string): MemoryRecord | undefined {
    try {
      return parseMemory(fs.readFileSync(file, "utf8"), file);
    } catch {
      return undefined;
    }
  }

  get(id: string): MemoryRecord | undefined {
    if (!isValidMemoryId(id)) return undefined; // hostile ids read as absent — never a path
    return this.readAt(this.pathOf(id, "active")) ?? this.readAt(this.pathOf(id, "archive"));
  }

  list(status: MemoryStatus = "active"): MemoryRecord[] {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(this.dir, status)).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
    const records: MemoryRecord[] = [];
    for (const f of files) {
      const file = path.join(this.dir, status, f);
      const record = this.readAt(file);
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  activeCount(): number {
    return this.list("active").length;
  }

  /** Full replacement create. Capacity: active 满 25 条拒绝（P4 / §6.5）。 */
  async create(input: {
    title: string;
    summary: string;
    content: string;
    keywords: string[];
    sourceRunId?: string;
    model?: string;
  }): Promise<MemoryRecord> {
    return this.guard.run(() => {
      const active = this.activeCount();
      if (active >= MAX_ACTIVE_MEMORIES) throw new MemoryCapacityError(MAX_ACTIVE_MEMORIES);
      const now = new Date().toISOString();
      const record: MemoryRecord = {
        id: this.nextId(),
        title: input.title.trim(),
        summary: input.summary.trim(),
        content: input.content.trim(),
        keywords: input.keywords,
        revision: 1,
        status: "active",
        sourceRunId: input.sourceRunId,
        model: input.model,
        created: now,
        updated: now,
        accessCount: 0,
      };
      writeFileAtomic(this.pathOf(record.id, "active"), serializeMemory(record));
      this.rebuildIndex();
      return record;
    });
  }

  /**
   * 完整替换 + 乐观锁校验（P6 update_if_revision）：revision 不符抛冲突，
   * 永不盲目覆盖。归档条目不可更新（先恢复语义上不成立——调用方应重建）。
   */
  async updateIfRevision(
    id: string,
    expectedRevision: number,
    patch: { title: string; summary: string; content: string; keywords: string[] },
  ): Promise<MemoryRecord> {
    return this.guard.run(() => {
      const record = this.get(id);
      if (!record) throw new MemoryNotFoundError(id);
      if (record.revision !== expectedRevision) throw new MemoryConflictError(id, expectedRevision);
      if (record.status !== "active") throw new HarnessError(`memory "${id}" is archived and cannot be updated`);
      const next: MemoryRecord = {
        ...record,
        title: patch.title.trim(),
        summary: patch.summary.trim(),
        content: patch.content.trim(),
        keywords: patch.keywords,
        revision: record.revision + 1,
        updated: new Date().toISOString(),
      };
      writeFileAtomic(this.pathOf(id, "active"), serializeMemory(next));
      this.rebuildIndex();
      return next;
    });
  }

  /** 归档必须基于最新快照（P6 archive_if_unchanged）。 */
  async archiveIfUnchanged(id: string, expectedRevision: number): Promise<MemoryRecord> {
    return this.guard.run(() => {
      const record = this.get(id);
      if (!record) throw new MemoryNotFoundError(id);
      if (record.status === "archive") return record;
      if (record.revision !== expectedRevision) throw new MemoryConflictError(id, expectedRevision);
      const next: MemoryRecord = {
        ...record,
        status: "archive",
        revision: record.revision + 1,
        updated: new Date().toISOString(),
      };
      writeFileAtomic(this.pathOf(id, "archive"), serializeMemory(next));
      fs.rmSync(this.pathOf(id, "active"), { force: true });
      this.rebuildIndex();
      return next;
    });
  }

  /** 显式读取的副作用（§8）：计入 access_count / last_accessed_at。 */
  async recordAccess(id: string): Promise<void> {
    await this.guard.run(() => {
      const record = this.get(id);
      if (!record) throw new MemoryNotFoundError(id);
      if (record.status !== "active") return undefined;
      const next: MemoryRecord = {
        ...record,
        accessCount: record.accessCount + 1,
        lastAccessed: new Date().toISOString(),
      };
      writeFileAtomic(this.pathOf(id, "active"), serializeMemory(next));
      return undefined;
    });
  }

  /** INDEX.md（投影）: active 记忆索引，每次写操作后重建；容忍人工编辑的陈旧。 */
  rebuildIndex(): void {
    const lines = this.list("active").map((r) => `- ${r.id} | ${r.title} | rev ${r.revision} | ${r.summary}`);
    const body = [
      "# Memory Index",
      "",
      "Active ordinary memories (projection — the .md files are the authority):",
      "",
      ...(lines.length > 0 ? lines : ["(empty)"]),
      "",
    ].join("\n");
    try {
      writeFileAtomic(this.indexPath, body);
    } catch {
      // INDEX.md is a projection — its failure never breaks the write path (P2)
    }
  }

  /** Non-atomic direct save is deliberately absent — every mutation goes
   * through create/updateIfRevision/archiveIfUnchanged/recordAccess. */
}

// ---- legacy v2 parser (import only; kept byte-faithful to 阶段 9.5 format) --

interface LegacyRecord {
  runId: string;
  taskType: string;
  summaryEn: string;
  summaryZh: string;
  approach: string;
  pitfalls: string;
  keywordsEn: string[];
  model?: string;
  created: string;
  updated: string;
}

function parseLegacyMemory(raw: string, source: string): LegacyRecord {
  if (!raw.startsWith("---")) throw new Error(`${source}: missing frontmatter`);
  const end = raw.indexOf("\n---", 3);
  if (end === -1) throw new Error(`${source}: unterminated frontmatter`);
  const meta = (parseYaml(raw.slice(3, end)) ?? {}) as Record<string, unknown>;
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1);
  const section = (title: string): string => {
    const match = body.match(new RegExp(`## ${title}\\r?\\n([\\s\\S]*?)(?=\\n## |$)`));
    return match?.[1]?.trim() ?? "";
  };
  return {
    runId: String(meta.runId ?? ""),
    taskType: String(meta.taskType ?? "uncategorized"),
    summaryEn: (body.match(/^# (.+)$/m)?.[1] ?? "").trim(),
    summaryZh: section("中文摘要"),
    approach: section("Approach"),
    pitfalls: section("Pitfalls"),
    keywordsEn: Array.isArray(meta.keywords) ? meta.keywords.map(String) : [],
    model: meta.model == null ? undefined : String(meta.model),
    created: String(meta.created ?? new Date().toISOString()),
    updated: String(meta.updated ?? new Date().toISOString()),
  };
}

export { serializeMemory, parseMemory };
