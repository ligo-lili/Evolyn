import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { HarnessError } from "../errors.js";
import type { PassageEmbedder } from "./embedding.js";
import { MAX_ACTIVE_MEMORIES, MemoryConflictError, MemoryNotFoundError, MemoryStore } from "./store.js";
import { MemorySearchIndex } from "./search.js";
import type { AnyAgentTool } from "../runtime/tools/index.js";

/**
 * 模型工具面（memory-design.md §8）——信任分层在工具层的落实：
 *
 *   memory_read     显式读取：返回完整正文，计入 access_count，并把 id 记入
 *                   本 run 的授权白名单（读过的 id 才可被 update / 反思 update）。
 *   memory_search   检索 cue：id + title + revision + summary + snippet，
 *                   无副作用——搜索不授权更新。
 *   memory_create   受容量硬顶约束（active 满 25 拒绝）。
 *   memory_update   完整替换 + 乐观锁 + 白名单校验（机制，不是提示词）。
 *   memory_archive  archive_if_unchanged（必须基于最新快照）。
 *   core_memory_update  按 key upsert 单条 Core entry，强制 reason +
 *                   source_statement——模型永远不能整份覆盖 CORE.md。
 *
 * 权限映射（permissions.ts）：读 → fs:read readonly；写 → fs:write mutating。
 */

export interface MemoryToolDeps {
  store: MemoryStore;
  index: MemorySearchIndex;
  /** 当前 run id——memory_read 的白名单归属。 */
  runId: string;
  /** memory_search 的可选向量路（缺席时降级 FTS，绝不抛错）。惰性工厂——
   * 首次调用才加载本地 embedding 模型。 */
  embedder?: () => PassageEmbedder;
}

function textResult<T>(text: string, details: T): { content: [{ type: "text"; text: string }]; details: T } {
  return { content: [{ type: "text", text }], details };
}

const readParams = Type.Object({
  id: Type.String({ description: "Memory id, e.g. M001" }),
});

const searchParams = Type.Object({
  query: Type.String({ description: "Free-text search query (zh or en)" }),
  limit: Type.Optional(Type.Number({ description: "Max hits (default 5)" })),
});

const createParams = Type.Object({
  title: Type.String({ description: "Short english title" }),
  summary: Type.String({ description: "One-sentence summary (zh)" }),
  content: Type.String({ description: "Complete memory body in markdown" }),
  keywords: Type.Optional(Type.Array(Type.String({ description: "3-8 search keywords" }))),
});

const updateParams = Type.Object({
  id: Type.String({ description: "Memory id to update — must have been READ this run" }),
  revision: Type.Number({ description: "Expected revision (optimistic lock)" }),
  title: Type.String(),
  summary: Type.String(),
  content: Type.String({ description: "COMPLETE replacement body; keep still-valid old facts and negations" }),
  keywords: Type.Optional(Type.Array(Type.String())),
});

const archiveParams = Type.Object({
  id: Type.String(),
  revision: Type.Number({ description: "Expected revision (archive is refused on a stale snapshot)" }),
});

const coreUpdateParams = Type.Object({
  key: Type.String({ description: "Stable entry key, e.g. language or test-runner" }),
  content: Type.String({ description: "Entry content" }),
  reason: Type.String({ description: "Why this entry is written/changed (required, audited)" }),
  source_statement: Type.String({ description: "Verbatim user evidence backing this entry (required)" }),
});

export function createMemoryTools(deps: MemoryToolDeps): AnyAgentTool[] {
  const readTool: AgentTool<typeof readParams, { id: string; revision: number; accessCount: number }> = {
    name: "memory_read",
    label: "Memory read",
    description:
      "Read the FULL body of one ordinary memory by id. Counts as an access and authorizes " +
      "memory_update / reflection updates for this id within the current run. Use memory_search first to find ids.",
    parameters: readParams,
    execute: async (_toolCallId, args) => {
      const record = deps.store.get(args.id);
      if (!record) throw new MemoryNotFoundError(args.id);
      if (record.status !== "active") throw new HarnessError(`memory "${args.id}" is archived and not retrievable`);
      // 副作用即契约：计访问 + 授权白名单（§8）。
      await deps.store.recordAccess(args.id);
      deps.index.recordAccess(deps.runId, args.id);
      return textResult(`# ${record.title} (rev ${record.revision})\n${record.content}`, {
        id: record.id,
        revision: record.revision,
        accessCount: record.accessCount + 1,
      });
    },
  };

  const searchTool: AgentTool<typeof searchParams, { mode: string; degradeReason?: string; hits: number }> = {
    name: "memory_search",
    label: "Memory search",
    description:
      "Search ordinary memories (FTS + optional vector hybrid with automatic degradation). " +
      "Returns cues (id/title/summary/snippet), NOT full bodies — follow up with memory_read. " +
      "No side effects: searching does not authorize updates.",
    parameters: searchParams,
    execute: async (_toolCallId, args) => {
      const hits = await deps.index.search(deps.store, args.query, {
        limit: args.limit ?? 5,
        embedder: deps.embedder?.(),
      });
      if (hits.length === 0) {
        return textResult("(no matching memory)", { mode: "unavailable", hits: 0 });
      }
      const lines = hits.map(
        (h) =>
          `- ${h.record.id} (rev ${h.record.revision}) ${h.record.title} — ${h.record.summary} | ${h.snippet.slice(0, 200)} | mode=${h.mode}`,
      );
      return textResult(lines.join("\n"), {
        mode: hits[0]!.mode,
        degradeReason: hits[0]!.degradeReason,
        hits: hits.length,
      });
    },
  };

  const createTool: AgentTool<typeof createParams, { id: string; revision: number }> = {
    name: "memory_create",
    label: "Memory create",
    description:
      "Create a new ordinary memory (durable, reusable lessons only — sparse by design). " +
      `Refused when the active set is at capacity (${MAX_ACTIVE_MEMORIES}).`,
    parameters: createParams,
    execute: async (_toolCallId, args) => {
      const record = await deps.store.create({
        title: args.title,
        summary: args.summary,
        content: args.content,
        keywords: args.keywords ?? [],
      });
      return textResult(`created ${record.id} (rev ${record.revision})`, { id: record.id, revision: record.revision });
    },
  };

  const updateTool: AgentTool<typeof updateParams, { id: string; revision: number }> = {
    name: "memory_update",
    label: "Memory update",
    description:
      "Replace one ordinary memory (full replacement; keep still-valid old facts and material negations). " +
      "Only ids READ via memory_read in THIS run are authorized; the revision must match (optimistic lock).",
    parameters: updateParams,
    execute: async (_toolCallId, args) => {
      const authorized = deps.index.readIdsForRun(deps.runId);
      if (!authorized.includes(args.id)) {
        throw new HarnessError(
          `update of "${args.id}" not authorized — memory_read it first (whitelist, mechanism not prompt)`,
        );
      }
      try {
        const record = await deps.store.updateIfRevision(args.id, args.revision, {
          title: args.title,
          summary: args.summary,
          content: args.content,
          keywords: args.keywords ?? [],
        });
        return textResult(`updated ${record.id} (rev ${record.revision})`, {
          id: record.id,
          revision: record.revision,
        });
      } catch (err) {
        if (err instanceof MemoryConflictError) {
          throw new HarnessError(`${err.message} (the cue you hold may be stale — memory_read it again)`);
        }
        throw err;
      }
    },
  };

  const archiveTool: AgentTool<typeof archiveParams, { id: string; revision: number }> = {
    name: "memory_archive",
    label: "Memory archive",
    description:
      "Archive an ordinary memory (leaves the searchable active set; content is preserved). " +
      "Refused when the provided revision is stale (archive_if_unchanged).",
    parameters: archiveParams,
    execute: async (_toolCallId, args) => {
      const record = await deps.store.archiveIfUnchanged(args.id, args.revision);
      return textResult(`archived ${record.id} (rev ${record.revision})`, {
        id: record.id,
        revision: record.revision,
      });
    },
  };

  const coreUpdateTool: AgentTool<typeof coreUpdateParams, { key: string }> = {
    name: "core_memory_update",
    label: "Core memory update",
    description:
      "Upsert ONE core-memory entry by key (user identity, stable preferences, global constraints). " +
      "reason and source_statement are REQUIRED — every core change must trace back to user evidence. " +
      "You can never overwrite the whole core memory.",
    parameters: coreUpdateParams,
    execute: async (_toolCallId, args) => {
      await deps.store.coreUpdate({
        key: args.key,
        content: args.content,
        reason: args.reason,
        sourceStatement: args.source_statement,
      });
      return textResult(`core entry "${args.key}" upserted`, { key: args.key });
    },
  };

  return [readTool, searchTool, createTool, updateTool, archiveTool, coreUpdateTool] as AnyAgentTool[];
}
