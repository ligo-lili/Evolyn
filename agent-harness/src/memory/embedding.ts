/**
 * 阶段 9.6: local embeddings for hybrid memory recall. No API key, no vector
 * database service — vectors live in SQLite (memory_vectors) as ANOTHER
 * rebuildable projection of the authoritative markdown memory files.
 *
 * Default model: Xenova/multilingual-e5-small (multilingual zh+en, matching
 * our bilingual memory content). E5 models expect "query: "/"passage: "
 * prefixes, applied here so callers stay model-agnostic.
 */

export type PassageEmbedder = {
  embedPassages(texts: readonly string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

export const E5_PREFIXES = { passage: "passage: ", query: "query: " } as const;

/**
 * 规范 embedding 模型 id：写入 memory_chunks.embedding_model 的唯一取值。
 * 运行时 backfill 与 CLI rebuild --vector 必须用同一个 id，否则彼此建的
 * 向量都会被当作过期模型重新计算。
 */
export const EMBEDDING_MODEL_ID = "Xenova/multilingual-e5-small";

let shared: PassageEmbedder | undefined;

/**
 * 进程级单例：模型每进程至多加载一次，工厂本身零成本——加载是惰性
 * Promise，且检索路在 vectorCount() === 0 时根本不会触到它（run 启动
 * 零开销；建过向量才付一次 query embedding 的代价）。
 */
export function sharedEmbedder(options: LocalEmbedderOptions = {}): PassageEmbedder {
  shared ??= localEmbedder(options);
  return shared;
}

export interface LocalEmbedderOptions {
  model?: string;
  /** Where the model files are downloaded on first use. */
  cacheDir?: string;
  /**
   * Mirror host for model downloads (e.g. https://hf-mirror.com where
   * huggingface.co is unreachable). Falls back to HARNESS_EMBEDDING_REMOTE_HOST
   * or HF_ENDPOINT.
   */
  remoteHost?: string;
}

export function localEmbedder(options: LocalEmbedderOptions = {}): PassageEmbedder {
  const model = options.model ?? "Xenova/multilingual-e5-small";
  let extractor:
    | Promise<{ (texts: string[], opts: Record<string, unknown>): Promise<{ data: Float32Array; dims: number[] }> }>
    | undefined;

  const load = () => {
    extractor ??= (async () => {
      const tf = await import("@huggingface/transformers");
      const cacheDir = options.cacheDir ?? process.env.HARNESS_EMBEDDING_CACHE_DIR;
      if (cacheDir) tf.env.cacheDir = cacheDir;
      // transformers.js has no HF_ENDPOINT support — map it onto env.remoteHost.
      const remoteHost = options.remoteHost ?? process.env.HARNESS_EMBEDDING_REMOTE_HOST ?? process.env.HF_ENDPOINT;
      if (remoteHost) tf.env.remoteHost = remoteHost.endsWith("/") ? remoteHost : `${remoteHost}/`;
      // q8 quantization: ~4x smaller download than fp32, plenty for recall.
      return (await tf.pipeline("feature-extraction", model, { dtype: "q8" })) as never;
    })().catch((err) => {
      // 下载/加载失败不缓存 rejected promise——否则首败之后向量路永久失效；
      // 复位后下一次调用可重试（检索侧本来就有 FTS 降级兜底）。
      extractor = undefined;
      throw err;
    });
    return extractor;
  };

  const run = async (texts: readonly string[]): Promise<number[][]> => {
    const extractor = await load();
    const output = await extractor([...texts], { pooling: "mean", normalize: true });
    const dims = output.dims as number[];
    const dim = dims[dims.length - 1]!;
    const count = (output.data as Float32Array).length / dim;
    const rows: number[][] = [];
    for (let i = 0; i < count; i++) {
      rows.push(Array.from(output.data.slice(i * dim, (i + 1) * dim)));
    }
    return rows;
  };

  return {
    async embedPassages(texts) {
      if (texts.length === 0) return [];
      return run(texts.map((t) => E5_PREFIXES.passage + t));
    },
    async embedQuery(text) {
      const rows = await run([E5_PREFIXES.query + text]);
      return rows[0]!;
    },
  };
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Reciprocal Rank Fusion: score = Σ 1/(k + rank) over every ranking the item
 * appears in (1-based ranks). Cheap, parameter-light, and robust to
 * different score scales across retrievers.
 */
export function rrfCombine(
  rankings: ReadonlyArray<ReadonlyArray<{ id: string }>>,
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((item, i) => {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
