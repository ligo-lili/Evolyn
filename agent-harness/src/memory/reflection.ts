import type { AgentMessage } from "@earendil-works/pi-agent-core";
import path from "node:path";
import { Type } from "typebox";
import { HarnessError } from "../errors.js";
import { defaultChat, type ChatFn } from "../llm/structured.js";
import { resolveModel } from "../providers.js";
import { defaultDbPath, openDatabase } from "../storage/db.js";
import { RunRepo } from "../storage/repos/runs.js";
import { TraceEventRepo } from "../storage/repos/trace-events.js";
import { MemoryCapacityError, MAX_ACTIVE_MEMORIES, MemoryStore } from "./store.js";
import { MemorySearchIndex } from "./search.js";
import type { MemoryRecord } from "./model.js";

/**
 * 写入流程三道闸——普通记忆稀疏，默认动作 NONE：
 *
 *   Run 结束 → ReflectionGate（确定性，零成本）
 *                │ 闲聊/能力询问/临时查询 ──▶ 跳过
 *                │ 持久信号（"以后/记住/偏好"）或真实工作 ▼
 *              PostRunMemoryReflector（独立 reflection 模型角色）
 *                │ 严格 JSON：{action: none|create|update, ...}
 *              ▼
 *            Manager 写入（乐观锁校验）→ INDEX 重建 → 增量同步搜索投影
 *
 * 关键约束（prompt 软约束 + 程序硬校验双层）：
 *  1. 默认 NONE；
 *  2. UPDATE 授权白名单：只允许更新本轮 memory_read 过全文的记忆——用机制
 *     而非提示词阻止凭 cue 猜改（§6.3）；
 *  3. update 必须携带完整替换内容，并保留旧有效事实与 material negations；
 *  4. 容量硬顶：active 满 25 条 create 拒绝（§6.5）。
 */

export interface RunDigest {
  runId: string;
  task: string;
  modelSpec: string;
  status: string;
  error?: string;
  toolCalls: Array<{ toolName: string; args?: unknown; isError?: boolean }>;
  finalAssistantText?: string;
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Compact the run into the digest the reflector sees (tool args truncated). */
export function buildRunDigest(
  record: { runId?: string; id?: string; task: string; modelSpec: string; status: string; error?: string },
  messages: readonly AgentMessage[],
): RunDigest {
  const toolCalls: RunDigest["toolCalls"] = [];
  const callById = new Map<string, RunDigest["toolCalls"][number]>();
  let finalAssistantText: string | undefined;
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const block of m.content) {
        if (block.type === "toolCall") {
          const call = { toolName: block.name, args: block.arguments };
          toolCalls.push(call);
          // 消息里本来就有精确 id——按 toolCallId 配对；按名字反扫在同名
          // 并行调用上会张冠李戴。
          callById.set(block.id, call);
        }
      }
      const text = textOf(m.content);
      if (text.trim()) finalAssistantText = text;
    } else if (m.role === "toolResult") {
      const call = callById.get(m.toolCallId);
      if (call) call.isError = m.isError;
    }
  }
  return {
    runId: record.runId ?? record.id ?? "",
    task: record.task,
    modelSpec: record.modelSpec,
    status: record.status,
    error: record.error,
    toolCalls,
    finalAssistantText,
  };
}

// ---------------------------------------------------------------------------
// 第一道闸：确定性 ReflectionGate（零模型成本，§6 / §14.4）
// ---------------------------------------------------------------------------

/** 持久信号：用户明确要求跨会话记住——即使没有工具调用也必须反思。 */
const PERSISTENT_SIGNAL_PATTERNS: RegExp[] = [
  /记住/i,
  /记下来/,
  /以后(都|请|要)/,
  /从今(以后|往后)/,
  /偏好/,
  /\bremember\b/i,
  /\bpreference\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\balways\b/i,
];

/** 能力询问/闲聊特征：问 agent 自己能做什么，不产生可记忆的工作经验。 */
const CAPABILITY_QUERY_PATTERNS: RegExp[] = [
  /你(能|会)(做|干)(什么|啥)/,
  /你是什么|你是谁/,
  /what can you do/i,
  /what are you\b/i,
  /how do you work/i,
];

export interface GateDecision {
  reflect: boolean;
  reason: string;
}

/** 第一道闸：纯函数、零成本、可单测（§14.4：可升级为小模型分类）。 */
export function shouldReflect(digest: Pick<RunDigest, "task" | "toolCalls">): GateDecision {
  const task = digest.task.trim();
  if (!task) return { reflect: false, reason: "empty task" };
  const persistent = PERSISTENT_SIGNAL_PATTERNS.some((p) => p.test(task));
  if (persistent) return { reflect: true, reason: "persistent-signal keyword in task" };
  if (CAPABILITY_QUERY_PATTERNS.some((p) => p.test(task))) {
    return { reflect: false, reason: "capability question (chitchat)" };
  }
  if (digest.toolCalls.length === 0) {
    return { reflect: false, reason: "no tool calls — temporary query or chitchat" };
  }
  return { reflect: true, reason: `real work (${digest.toolCalls.length} tool call(s))` };
}

// ---------------------------------------------------------------------------
// 第二道闸：PostRunMemoryReflector（严格 JSON 决策）
// ---------------------------------------------------------------------------

export type ReflectionAction = "none" | "create" | "update";

export interface ReflectionDecision {
  action: ReflectionAction;
  /** Required for update — must be a memory the run READ via memory_read. */
  id?: string;
  title?: string;
  summary?: string;
  content?: string;
  keywords?: string[];
  /** 为什么这样决策（可追溯，P5）。none 时必填。 */
  reason: string;
}

export interface ReflectionCandidate {
  id: string;
  title: string;
  summary: string;
  revision: number;
  /** 本轮 memory_read 过全文——UPDATE 授权白名单（§6.3）。 */
  readable: boolean;
}

export const REFLECTION_SYSTEM_PROMPT =
  "You decide how a finished coding-agent run should update long-term memory. " +
  "Ordinary memory must stay SPARSE: the default action is NONE — create only when the run " +
  "produced a durable, reusable lesson (project decision, direction change, important background), " +
  "not for routine work. Output ONLY strict JSON with exactly these keys: " +
  'action ("none" | "create" | "update"), ' +
  "id (required for update: the memory being updated), " +
  "title (short english title), " +
  "summary (one-sentence zh+en summary), " +
  "content (the COMPLETE replacement memory body in markdown; for update keep every still-valid " +
  "old fact and material negations — rejected approaches, numeric caps, safety constraints), " +
  "keywords (3-8 search keywords, english), " +
  "reason (why this action / why none). " +
  "UPDATE is only allowed for ids explicitly marked READ in the candidate list.";

export function buildReflectionPrompt(input: {
  digest: RunDigest;
  candidates: ReflectionCandidate[];
  activeCount: number;
  maxActive: number;
}): string {
  const candidateLines = input.candidates.map(
    (c) =>
      `- id: ${c.id} | rev ${c.revision} | ${c.readable ? "READ (update allowed)" : "cue-only (update FORBIDDEN)"} | ${c.title} — ${c.summary}`,
  );
  return [
    "Decide the memory action for this run:",
    JSON.stringify(
      {
        ...input.digest,
        toolCalls: input.digest.toolCalls.slice(0, 30).map((c) => ({ ...c, args: truncated(c.args) })),
        finalAssistantText: input.digest.finalAssistantText?.slice(0, 1_000),
      },
      null,
      1,
    ),
    candidateLines.length
      ? `\nExisting memories (id | revision | authorization):\n${candidateLines.join("\n")}`
      : "\nNo existing memories.",
    `\nCapacity: active ${input.activeCount}/${input.maxActive} — create is REJECTED at the cap.`,
  ].join("\n");
}

function truncated(value: unknown): unknown {
  const s = JSON.stringify(value);
  if (s === undefined || s.length <= 300) return value;
  return s.slice(0, 300) + "…";
}

export const REFLECTION_SCHEMA = Type.Object({
  action: Type.Union([Type.Literal("none"), Type.Literal("create"), Type.Literal("update")]),
  id: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  keywords: Type.Optional(Type.Array(Type.String())),
  reason: Type.String(),
});

/** 严格解析：形状不符即抛——调用方按"本次不写记忆"处理（绝不硬造）。 */
export function parseReflectionDecision(raw: string): ReflectionDecision {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in reflection output");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const action = String(parsed.action ?? "");
  if (action !== "none" && action !== "create" && action !== "update") {
    throw new Error(`invalid reflection action "${action}"`);
  }
  const reason = String(parsed.reason ?? "").trim();
  if (!reason) throw new Error("reflection decision requires a reason (P5: 修改可追溯)");
  const decision: ReflectionDecision = {
    action,
    reason,
    id: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : undefined,
    title: typeof parsed.title === "string" ? parsed.title.trim() : undefined,
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : undefined,
    content: typeof parsed.content === "string" ? parsed.content.trim() : undefined,
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String).filter(Boolean).slice(0, 8) : undefined,
  };
  if (decision.action === "update" && !decision.id) throw new Error("update requires an id");
  if (decision.action === "update" && !decision.content) {
    // §6.4: update 必须携带完整替换内容——保持 cue 与正文一致，绝不静默拼接。
    throw new Error("update requires the complete replacement content");
  }
  if (decision.action === "create" && (!decision.title || !decision.content)) {
    throw new Error("create requires title and content");
  }
  return decision;
}

// ---------------------------------------------------------------------------
// 编排：load run → gate → reflect → authorized write
// ---------------------------------------------------------------------------

export interface ReflectOptions {
  database?: string;
  /** Reflection model spec; defaults to HARNESS_DISTILL_MODEL or deepseek/deepseek-flash. */
  reflectModelSpec?: string;
  /** Injectable chat for tests; default goes through the pi-ai registry. */
  complete?: ChatFn;
  /** Skip the deterministic gate (CLI `memory distill --force`). */
  force?: boolean;
  candidateLimit?: number;
}

export type ReflectOutcome =
  | { action: "skipped"; reason: string }
  | { action: "none"; reason: string }
  | { action: "created"; reason: string; record: MemoryRecord; file: string }
  | { action: "updated"; reason: string; record: MemoryRecord; file: string }
  | { action: "rejected"; reason: string };

export async function reflectRunById(runId: string, options: ReflectOptions = {}): Promise<ReflectOutcome> {
  const dbPath = options.database ?? defaultDbPath();
  const db = openDatabase(dbPath);
  try {
    const runRow = new RunRepo(db).get(runId);
    if (!runRow) throw new HarnessError(`run "${runId}" not found`);
    if (runRow.status === "running")
      throw new HarnessError(`run "${runId}" is still running — nothing to reflect on yet`);

    const messages = new TraceEventRepo(db)
      .getByRun(runId)
      .filter((e) => e.type === "message_end")
      .map((e) => e.message);
    const digest = buildRunDigest(runRow, messages);

    const store = new MemoryStore(path.join(path.dirname(dbPath), "memory"));
    const index = new MemorySearchIndex(db);

    const gate = shouldReflect(digest);
    if (!gate.reflect && !options.force) {
      return { action: "skipped", reason: gate.reason };
    }

    // 第二道闸输入：候选 + 授权白名单 + 容量状态（确定性拼装）。
    const candidateLimit = options.candidateLimit ?? 3;
    const hits = await index.search(store, digest.task.slice(0, 1600), { limit: candidateLimit });
    const readable = new Set(index.readIdsForRun(runId));
    const candidates: ReflectionCandidate[] = hits.map((h) => ({
      id: h.record.id,
      title: h.record.title,
      summary: h.record.summary,
      revision: h.record.revision,
      readable: readable.has(h.record.id),
    }));

    const spec = options.reflectModelSpec ?? process.env.HARNESS_DISTILL_MODEL ?? "deepseek/deepseek-flash";
    const complete = options.complete ?? defaultChat(resolveModel(spec), { systemPrompt: REFLECTION_SYSTEM_PROMPT });
    const raw = await complete(
      [
        {
          role: "user",
          content: buildReflectionPrompt({
            digest,
            candidates,
            activeCount: store.activeCount(),
            maxActive: MAX_ACTIVE_MEMORIES,
          }),
        },
      ],
      {
        schemaTool: {
          name: "record_memory_decision",
          description: "Record the memory decision JSON.",
          parameters: REFLECTION_SCHEMA,
        },
      },
    );
    const decision = parseReflectionDecision(raw);

    if (decision.action === "none") {
      return { action: "none", reason: decision.reason };
    }

    // 第三道闸：授权白名单 + 乐观锁 + 容量——机制而非提示词（§6.3）。
    if (decision.action === "update") {
      const id = decision.id!;
      if (!readable.has(id)) {
        return {
          action: "rejected",
          reason: `update of "${id}" not authorized — the run never read its full text (whitelist)`,
        };
      }
      const existing = store.get(id);
      if (!existing || existing.status !== "active") {
        return { action: "rejected", reason: `memory "${id}" not found in the active set` };
      }
      const record = await store.updateIfRevision(id, existing.revision, {
        title: decision.title ?? existing.title,
        summary: decision.summary ?? existing.summary,
        content: decision.content ?? existing.content,
        keywords: decision.keywords ?? existing.keywords,
      });
      return { action: "updated", reason: decision.reason, record, file: store.pathOf(id, "active") };
    }

    try {
      const record = await store.create({
        title: decision.title ?? digest.task.slice(0, 80),
        summary: decision.summary ?? "",
        content: decision.content ?? "",
        keywords: decision.keywords ?? [],
        sourceRunId: runId,
        model: spec,
      });
      return { action: "created", reason: decision.reason, record, file: store.pathOf(record.id, "active") };
    } catch (err) {
      if (err instanceof MemoryCapacityError) {
        return { action: "rejected", reason: err.message };
      }
      throw err;
    }
  } finally {
    db.close();
  }
}
