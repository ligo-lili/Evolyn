import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, rrfCombine, type PassageEmbedder } from "./embedding.js";
import { chunkMemory, chunkSha256, type MemoryRecord } from "./model.js";
import type { MemoryStore } from "./store.js";

/**
 * MemorySearchIndex v3 — the derived, rebuildable search projection (§7).
 * The Markdown files are the authority (P1); every
 * failure here only degrades retrieval quality, never correctness (P2).
 *
 * - memory_chunks: chunk text + text_sha256 (content identity) + revision +
 *   embedding provenance + normalized vector BLOB; PK (memory_id, chunk_index).
 * - memory_fts: FTS5 over chunks; tokenizer probed trigram (中文友好) →
 *   unicode61, recorded in search_meta — a structural mismatch drops and
 *   rebuilds the whole projection.
 * - memory_access: which run READ which memory (the UPDATE authorization
 *   whitelist's audit trail, §6.3 / §8).
 *
 * Retrieval ranks at the MEMORY level: a long memory with many
 * chunk hits contributes ONE ranking entry per path — chunk count can never
 * inflate a score. Fusion is RRF (k=60); every result carries mode +
 * degrade_reason so callers can explain why only one path fired.
 */

export const MEMORY_SEARCH_SCHEMA_VERSION = "3";
export const RRF_K = 60;
export const MIN_VECTOR_SIMILARITY = 0.12;
export const SNIPPET_CHARS = 360;
export const FTS_MAX_TERMS = 12;
export const CANDIDATE_MULTIPLIER = 8;
/** accessCount 排序加成：boost = 1 + 0.15 × min(log2(1 + accessCount), 2)。 */
export const ACCESS_BOOST_WEIGHT = 0.15;
export const ACCESS_BOOST_CAP = 2;

export type SearchMode = "hybrid" | "fts" | "vector" | "unavailable";

export interface MemoryHit {
  record: MemoryRecord;
  /** The most relevant chunk text, ≤ SNIPPET_CHARS (title|summary header kept). */
  snippet: string;
  /** Which paths fired and why the others did not (可观测性). */
  mode: SearchMode;
  degradeReason?: string;
  /** 融合分（RRF；单路时 1/(k+rank)），已经过 accessCount 有界乘性提升。 */
  score: number;
  /** 本次排序应用的提升乘数（accessCount=0 → 1；封顶 1.30）。决策即数据。 */
  boost: number;
}

export interface BackfillStatus {
  status: "idle" | "running" | "complete" | "failed";
  attemptsUsed: number;
  lastError?: string;
  pending: number;
}

type ChunkRow = {
  memory_id: string;
  chunk_index: number;
  text: string;
  text_sha256: string;
  revision: number;
  embedding_model: string | null;
  embedding_dim: number | null;
  vec: Buffer | null;
};

function rowToChunk(r: Record<string, unknown>): ChunkRow {
  return {
    memory_id: String(r.memory_id),
    chunk_index: Number(r.chunk_index),
    text: String(r.text),
    text_sha256: String(r.text_sha256),
    revision: Number(r.revision),
    embedding_model: r.embedding_model == null ? null : String(r.embedding_model),
    embedding_dim: r.embedding_dim == null ? null : Number(r.embedding_dim),
    vec: r.vec == null ? null : (r.vec as Buffer),
  };
}

export class MemorySearchIndex {
  constructor(private readonly db: DatabaseSync) {
    this.ensureTokenizer();
    // 上一个进程可能在补全中途被杀，留下 running 假状态——新进程构造时
    // 必然没有在跑的补全任务，复位；下次 startBackfill 会重试（§9.4）。
    if (this.meta()["backfill_status"] === "running") this.setMeta("backfill_status", "idle");
  }

  // ---- schema / tokenizer --------------------------------------------------

  private meta(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM search_meta").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES (?, ?)").run(key, value);
  }

  /**
   * tokenizer 探测顺序 trigram → unicode61（§7.1）。以 sqlite_master 里的
   * 实际表定义为准（migration 以默认 tokenizer 建表、meta 缺失或说谎都能被
   * 纠正）：缺失或不匹配时重建 FTS 表——行内容由 reconcile/rebuild 以
   * Markdown 为权威回填。
   */
  private ensureTokenizer(): void {
    const probe = this.probeTokenizer("trigram");
    // 探测无结论（并发写锁等瞬时故障）时绝不下结论、绝不动现有表——宁可
    // 保持现状，也不能把 trigram 库误降级成 unicode61。
    const desired = probe === true ? "trigram" : probe === false ? "unicode61" : undefined;
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'").get() as
      { sql?: string } | undefined;
    const actual = row === undefined ? undefined : row.sql?.includes("trigram") ? "trigram" : "unicode61";
    if (desired !== undefined && (actual === undefined || actual !== desired)) {
      this.recreateFts(desired);
    } else if (row === undefined) {
      // no table at all and the probe was inconclusive — create the portable default
      this.recreateFts("unicode61");
    } else {
      this.setMeta("fts_tokenizer", actual!);
      this.setMeta("schema_version", MEMORY_SEARCH_SCHEMA_VERSION);
    }
  }

  /**
   * true = 支持；false = SQLite 明确报告不支持该 tokenizer；"inconclusive" =
   * 其它错误（库被并发写锁住等）——调用方必须保持现状，不得当作"不支持"。
   * 探针表名带进程唯一后缀：两个进程同时探测不会互相撞名。
   */
  private probeTokenizer(tokenizer: "trigram" | "unicode61"): boolean | "inconclusive" {
    const table = `memory_fts_probe_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      this.db.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(t, tokenize='${tokenizer}')`);
      this.db.exec(`DROP TABLE ${table}`);
      return true;
    } catch (err) {
      try {
        this.db.exec(`DROP TABLE IF EXISTS ${table}`);
      } catch {
        // probe residue is harmless (unique name); cleanup is best-effort
      }
      const message = err instanceof Error ? err.message : String(err);
      if (/no such tokenizer|unknown tokenizer/i.test(message)) return false;
      process.stderr.write(`[memory] tokenizer probe inconclusive (${message}) — keeping the current table\n`);
      return "inconclusive";
    }
  }

  private recreateFts(tokenizer: "trigram" | "unicode61"): void {
    this.db.exec("DROP TABLE IF EXISTS memory_fts");
    this.db.exec(
      `CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, chunk_index UNINDEXED, text, tokenize='${tokenizer}')`,
    );
    this.setMeta("fts_tokenizer", tokenizer);
    this.setMeta("schema_version", MEMORY_SEARCH_SCHEMA_VERSION);
  }

  // ---- sync / reconcile ----------------------------------------------------

  /**
   * Upsert one record's chunks — the §9.3 conditional-write semantics: a
   * chunk row is kept (its embedding ALONG WITH it) whenever text_sha256 is
   * unchanged, because content identity is the sha, not the revision. Only a
   * changed/missing chunk is replaced (as an un-embedded row); rows beyond
   * the new chunk count are dropped. Must only be called for ACTIVE records.
   */
  syncRecord(record: MemoryRecord): void {
    const chunks = chunkMemory(record);
    const existing = this.db
      .prepare("SELECT chunk_index, text_sha256 FROM memory_chunks WHERE memory_id = ?")
      .all(record.id) as Array<{ chunk_index: number | bigint; text_sha256: string }>;
    const shaByIndex = new Map<number, string>(existing.map((r) => [Number(r.chunk_index), r.text_sha256]));
    this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(record.id);
    const update = this.db.prepare(
      `UPDATE memory_chunks SET text = ?, text_sha256 = ?, revision = ? WHERE memory_id = ? AND chunk_index = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO memory_chunks (memory_id, chunk_index, text, text_sha256, revision) VALUES (?, ?, ?, ?, ?)`,
    );
    const deleteAt = this.db.prepare("DELETE FROM memory_chunks WHERE memory_id = ? AND chunk_index = ?");
    const ftsInsert = this.db.prepare("INSERT INTO memory_fts (memory_id, chunk_index, text) VALUES (?, ?, ?)");
    for (const chunk of chunks) {
      ftsInsert.run(record.id, chunk.index, chunk.text);
      if (shaByIndex.get(chunk.index) === chunk.sha256) {
        // 内容身份未变：原行原样保留（vec 一并存活），仅刷新 revision。
        update.run(chunk.text, chunk.sha256, record.revision, record.id, chunk.index);
      } else {
        // 内容变了（或新块）：旧行连同其向量作废，重插为未嵌入行。
        if (shaByIndex.has(chunk.index)) deleteAt.run(record.id, chunk.index);
        insert.run(record.id, chunk.index, chunk.text, chunk.sha256, record.revision);
      }
    }
    // 收缩：新块数少于旧块数时删除尾部行。
    this.db.prepare("DELETE FROM memory_chunks WHERE memory_id = ? AND chunk_index >= ?").run(record.id, chunks.length);
  }

  removeRecord(id: string): void {
    this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(id);
    this.db.prepare("DELETE FROM memory_chunks WHERE memory_id = ?").run(id);
  }

  /**
   * 启动对账（§9）以 Markdown 为权威：索引中多余的行删除，revision / sha
   * 不匹配的 chunk 重算。只建文本投影，不做 embedding——启动关键路径不等
   * 远程/本地模型（§9.1）。返回处理的记录数。
   */
  reconcile(store: MemoryStore): number {
    this.ensureTokenizer(); // guarantees the FTS table exists with the best tokenizer
    // Version-stamp hook for FUTURE schema bumps: ensureTokenizer stamps "3"
    // on every consistent open today, so this only fires once the constant
    // moves and the derived rows must be rebuilt from the authority below.
    const meta = this.meta();
    if (meta["schema_version"] !== MEMORY_SEARCH_SCHEMA_VERSION) {
      this.db.exec("DELETE FROM memory_chunks");
      this.setMeta("schema_version", MEMORY_SEARCH_SCHEMA_VERSION);
    }
    const live = store.list("active");
    const liveIds = new Set(live.map((r) => r.id));
    // delete rows for memories that no longer exist or left the active set
    const indexed = this.db.prepare("SELECT DISTINCT memory_id FROM memory_chunks").all() as Array<{
      memory_id: string;
    }>;
    for (const { memory_id } of indexed) {
      if (!liveIds.has(memory_id)) this.removeRecord(memory_id);
    }
    for (const record of live) this.syncRecord(record);
    return live.length;
  }

  /** Full rebuild from the authoritative files (CLI `memory rebuild`). */
  rebuild(store: MemoryStore): number {
    this.ensureTokenizer();
    this.db.exec("DELETE FROM memory_fts");
    this.db.exec("DELETE FROM memory_chunks");
    const live = store.list("active");
    for (const record of live) this.syncRecord(record);
    return live.length;
  }

  // ---- access audit (§6.3 UPDATE whitelist) --------------------------------

  recordAccess(runId: string, memoryId: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO memory_access (run_id, memory_id, accessed_at) VALUES (?, ?, ?)")
      .run(runId, memoryId, new Date().toISOString());
  }

  /** The ids this run READ the full text of — the only updatable set (§6.3). */
  readIdsForRun(runId: string): string[] {
    const rows = this.db.prepare("SELECT memory_id FROM memory_access WHERE run_id = ?").all(runId) as Array<{
      memory_id: string;
    }>;
    return rows.map((r) => r.memory_id);
  }

  // ---- embeddings -----------------------------------------------------------

  private currentEmbeddingModel(): string | undefined {
    const value = this.meta()["embedding_model"];
    return value || undefined;
  }

  vectorCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks WHERE vec IS NOT NULL").get() as {
      n: unknown;
    };
    return Number(row.n);
  }

  /** Total chunks and chunks still missing a CURRENT-model vector. */
  backfillPending(embeddingModel: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_chunks WHERE vec IS NULL OR embedding_model IS NULL OR embedding_model != ?",
      )
      .get(embeddingModel) as { n: unknown };
    return Number(row.n);
  }

  /** (Re-)embed every chunk of one memory; same-model identical chunks keep vectors. */
  async embedRecord(record: MemoryRecord, embedder: PassageEmbedder, embeddingModel: string): Promise<void> {
    const chunks = this.db
      .prepare("SELECT * FROM memory_chunks WHERE memory_id = ? ORDER BY chunk_index")
      .all(record.id) as unknown as Record<string, unknown>[];
    const rows = chunks.map(rowToChunk);
    const stale = rows.filter((r) => !r.vec || r.embedding_model !== embeddingModel);
    if (stale.length === 0) return;
    const vectors = await embedder.embedPassages(stale.map((r) => r.text));
    const update = this.db.prepare(
      // 条件写（§9.3）：补全期间记忆被修改（sha 变化）时，旧文本向量绝不覆盖新 chunk。
      `UPDATE memory_chunks SET vec = ?, embedding_model = ?, embedding_dim = ?
       WHERE memory_id = ? AND chunk_index = ? AND text_sha256 = ?`,
    );
    let i = 0;
    for (const row of stale) {
      const vec = vectors[i++];
      if (!vec) continue;
      update.run(
        Buffer.from(Float32Array.from(vec).buffer),
        embeddingModel,
        vec.length,
        row.memory_id,
        row.chunk_index,
        row.text_sha256,
      );
    }
  }

  /**
   * 启动后台补全（§9.2）：有限次指数退避（2s × 4ⁿ，≤3 次），状态机
   * idle → running → complete / failed——返回的句柄对象由后台任务原地更新，
   * 可经 CLI `memory status` 观察。失败只影响本轮检索质量（降级 FTS），
   * 下次重启重试。
   */
  startBackfill(
    store: MemoryStore,
    embedder: PassageEmbedder,
    embeddingModel: string,
    opts: { baseDelayMs?: number; maxAttempts?: number } = {},
  ): BackfillStatus & { promise: Promise<void> } {
    const baseDelayMs = opts.baseDelayMs ?? 2_000;
    const maxAttempts = opts.maxAttempts ?? 3;
    const handle: BackfillStatus & { promise: Promise<void> } = {
      status: "running",
      attemptsUsed: 0,
      pending: this.backfillPending(embeddingModel),
      promise: Promise.resolve(),
    };
    this.setMeta("backfill_status", "running");
    handle.promise = (async () => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        handle.attemptsUsed = attempt;
        try {
          const pending = this.backfillPending(embeddingModel);
          if (pending === 0) break;
          const live = store.list("active");
          for (const record of live) await this.embedRecord(record, embedder, embeddingModel);
          handle.pending = this.backfillPending(embeddingModel);
          if (handle.pending === 0) break;
        } catch (err) {
          handle.lastError = err instanceof Error ? err.message : String(err);
          if (attempt >= maxAttempts) {
            handle.status = "failed";
            this.setMeta("backfill_status", "failed");
            this.setMeta("backfill_error", handle.lastError ?? "unknown");
            process.stderr.write(`[memory] embedding backfill failed: ${handle.lastError}\n`);
            return;
          }
          const delay = baseDelayMs * 4 ** (attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      handle.status = "complete";
      handle.pending = this.backfillPending(embeddingModel);
      this.setMeta("backfill_status", "complete");
    })();
    return handle;
  }

  // ---- retrieval ------------------------------------------------------------

  /** 查询清洗 → 安全 OR 短语表达式（≤12 词，§7.3）。 */
  private ftsExpression(query: string): string | undefined {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, FTS_MAX_TERMS)
      .map((t) => `"${t.replace(/"/g, "")}"`);
    if (terms.length === 0) return undefined;
    return terms.join(" OR ");
  }

  private ftsRankedChunks(
    query: string,
    limit: number,
  ): Array<{ memoryId: string; chunkIndex: number }> | "unavailable" {
    const expression = this.ftsExpression(query);
    if (!expression) return [];
    try {
      const rows = this.db
        .prepare(`SELECT memory_id, chunk_index FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`)
        .all(expression, limit) as Array<{ memory_id: string; chunk_index: number }>;
      return rows.map((r) => ({ memoryId: String(r.memory_id), chunkIndex: Number(r.chunk_index) }));
    } catch (err) {
      process.stderr.write(`[memory] FTS path failed (${err instanceof Error ? err.message : err}) — degrading\n`);
      return "unavailable";
    }
  }

  /**
   * 向量路：查询归一化后与全量 chunk 做确定性余弦扫描（非 ANN——active ≤ 25
   * 时全量最准且零额外依赖，§12），min_vector_similarity 过滤弱命中。
   */
  private async vectorRankedChunks(
    query: string,
    embedder: PassageEmbedder,
    limit: number,
  ): Promise<Array<{ memoryId: string; chunkIndex: number; score: number }>> {
    if (!query.trim() || this.vectorCount() === 0) return [];
    const queryVector = await embedder.embedQuery(query);
    const rows = this.db.prepare("SELECT * FROM memory_chunks WHERE vec IS NOT NULL").all() as unknown as Record<
      string,
      unknown
    >[];
    const scored = rows.map(rowToChunk).map((r) => {
      const dim = Number(r.embedding_dim ?? 0);
      const blob = r.vec!;
      // Copy the byte range into a fresh, 4-byte-aligned ArrayBuffer.
      const aligned = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
      const vec = Array.from(new Float32Array(aligned)).slice(0, dim || undefined);
      return { memoryId: r.memory_id, chunkIndex: r.chunk_index, score: cosineSimilarity(queryVector, vec) };
    });
    return scored
      .filter((s) => s.score >= MIN_VECTOR_SIMILARITY)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * 混合检索（§7.3–7.5）。降级链 HYBRID → 单路 → UNAVAILABLE（结果为空，
   * 不抛错）；每级显式记录 degrade_reason。排名单位是 Memory 不是 Chunk；
   * title/summary/revision 用权威 Markdown 记录回填，剔除已不在 active
   * 集合的陈旧索引行。
   */
  async search(
    store: MemoryStore,
    query: string,
    opts: { limit?: number; embedder?: PassageEmbedder; embeddingModel?: string } = {},
  ): Promise<MemoryHit[]> {
    const limit = opts.limit ?? 5;
    const pool = Math.max(limit * CANDIDATE_MULTIPLIER, limit);
    const fts = this.ftsRankedChunks(query, pool);
    const ftsFailed = fts === "unavailable";
    // Each memory's BEST chunk index across the paths (§7.4.2: the snippet is
    // the most relevant chunk). FTS wins for ids both paths surfaced.
    const bestChunkByMemory = new Map<string, number>();

    let vectorRanking: Array<{ id: string; rank: number }> = [];
    let vectorFailed = false;
    if (opts.embedder) {
      try {
        const chunks = await this.vectorRankedChunks(query, opts.embedder, pool);
        // 排名单位是 Memory：每路只取该记忆最相关 chunk 的名次（§7.4.1）。
        const best = new Map<string, number>();
        for (const c of chunks) if (!best.has(c.memoryId)) best.set(c.memoryId, c.chunkIndex);
        vectorRanking = [...best.keys()].map((id, i) => ({ id, rank: i + 1 }));
        // vector-best chunk only fills ids the FTS path never surfaced
        for (const [id, idx] of best) if (!bestChunkByMemory.has(id)) bestChunkByMemory.set(id, idx);
      } catch (err) {
        vectorFailed = true;
        process.stderr.write(`[memory] vector path failed (${err instanceof Error ? err.message : err}) — degrading\n`);
      }
    }

    // collapse chunk ranks to memory ranks for the FTS path too
    const memoryFts: Array<{ id: string; rank: number }> = [];
    if (!ftsFailed && fts.length > 0) {
      const best = new Map<string, number>();
      for (const c of fts) if (!best.has(c.memoryId)) best.set(c.memoryId, c.chunkIndex);
      for (const [id] of best) memoryFts.push({ id, rank: 0 });
      memoryFts.sort((a, b) => (best.get(a.id) ?? 0) - (best.get(b.id) ?? 0));
      memoryFts.forEach((m, i) => (m.rank = i + 1));
      for (const [id, idx] of best) bestChunkByMemory.set(id, idx);
    }

    let mode: SearchMode;
    let degradeReason: string | undefined;
    if (memoryFts.length > 0 && vectorRanking.length > 0) {
      mode = "hybrid";
    } else if (ftsFailed && vectorRanking.length > 0) {
      mode = "vector";
      degradeReason = "fts unavailable";
    } else if (vectorFailed && memoryFts.length > 0) {
      mode = "fts";
      degradeReason = "embedding failed";
    } else if (memoryFts.length > 0) {
      mode = "fts";
      // FTS-only without an embedder is the configured posture, not a
      // degradation; with one, empty vector hits mean embeddings aren't built.
      if (opts.embedder) degradeReason = "no vectors matched";
    } else if (vectorRanking.length > 0) {
      mode = "vector";
      degradeReason = ftsFailed ? "fts unavailable" : "no fts matches";
    } else {
      mode = ftsFailed && opts.embedder ? "unavailable" : "fts";
      if (mode === "unavailable") degradeReason = "fts unavailable";
    }

    // 融合分：双路 RRF；单路退化为同一公式 1/(k+rank)，保证两case分数量纲一致。
    const fusedScores: Array<{ id: string; score: number }> =
      memoryFts.length > 0 && vectorRanking.length > 0
        ? rrfCombine([memoryFts, vectorRanking], RRF_K)
        : (memoryFts.length > 0 ? memoryFts : vectorRanking).map((r) => ({ id: r.id, score: 1 / (RRF_K + r.rank) }));

    // 有界乘性提升：accessCount 高的记忆在融合分之上获得 log 阻尼、硬封顶
    // （≤ +45%）的加成。accessCount 是 query 无关量——做成 RRF 第三路会
    // 系统性偏向热门记忆（富者愈富）；乘性有界只重排边缘、不固化榜单。
    // 权威回填同时在这里完成：陈旧索引行（已不在 active 集合）直接剔除。
    const boosted: Array<{ id: string; score: number; boost: number }> = [];
    for (const fused of fusedScores) {
      const record = store.get(fused.id);
      if (!record || record.status !== "active") continue;
      const boost = 1 + ACCESS_BOOST_WEIGHT * Math.min(Math.log2(1 + record.accessCount), ACCESS_BOOST_CAP);
      boosted.push({ id: fused.id, score: fused.score * boost, boost });
    }
    boosted.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    const hits: MemoryHit[] = [];
    const chunkTextById = this.chunkLookup();
    for (const entry of boosted.slice(0, limit)) {
      const record = store.get(entry.id)!; // 上一循环已验证存在且 active
      const bestIndex = bestChunkByMemory.get(entry.id);
      const bestText = bestIndex !== undefined ? chunkTextById.get(entry.id)?.get(bestIndex) : undefined;
      const snippet = (bestText ?? record.content).slice(0, SNIPPET_CHARS);
      hits.push({ record, snippet, mode, degradeReason, score: entry.score, boost: entry.boost });
    }
    return hits;
  }

  /** memory_id → (chunk_index → text), for snippet selection. */
  private chunkLookup(): Map<string, Map<number, string>> {
    const rows = this.db.prepare("SELECT memory_id, chunk_index, text FROM memory_chunks").all() as Array<{
      memory_id: string;
      chunk_index: number;
      text: string;
    }>;
    const map = new Map<string, Map<number, string>>();
    for (const r of rows) {
      let inner = map.get(r.memory_id);
      if (!inner) {
        inner = new Map<number, string>();
        map.set(r.memory_id, inner);
      }
      inner.set(Number(r.chunk_index), r.text);
    }
    return map;
  }

  /** SearchMeta + counts for `memory status` observability (§13). */
  diagnostics(embeddingModel?: string): Record<string, string | number> {
    const meta = this.meta();
    const chunks = this.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: unknown };
    return {
      schema_version: meta["schema_version"] ?? "?",
      fts_tokenizer: meta["fts_tokenizer"] ?? "?",
      backfill_status: meta["backfill_status"] ?? "idle",
      backfill_error: meta["backfill_error"] ?? "",
      chunks: Number(chunks.n),
      vectors: this.vectorCount(),
      ...(embeddingModel ? { backfill_pending: this.backfillPending(embeddingModel) } : {}),
    };
  }
}

export { chunkSha256 };
