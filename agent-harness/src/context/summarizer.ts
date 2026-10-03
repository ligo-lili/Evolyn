import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { completeStructured, defaultChat, type ChatFn } from "../llm/structured.js";
import { escapeStructuralTags } from "./assembler.js";

/**
 * 第二层的摘要生成器：严格 JSON 的滚动摘要（RollingConversationSummary）。
 *
 * 防失控是双保险：prompt 里软约束（每字段 5 条、每条 80 字），程序里
 * validateSummary 硬校验（上限 8 条 / 1200 字），超了直接抛
 * SummaryGenerationError——不信任模型的自觉。prompt 还明确：禁止编造推断、
 * 带证据 id 的工具原文只留"用途 + 完整 ID"引用。
 *
 * 大折叠保护：本次压缩跨度超过 bigFoldSpanTokens 时放宽输出上限——"超大
 * 跨度硬塞进小摘要"会丢信息，这是显式防的。
 */

export interface RollingConversationSummary {
  /** 用户当前目标（滚动更新，永远是"现在要做的事"）。 */
  current_objective: string;
  user_constraints: string[];
  key_decisions: string[];
  completed_work: string[];
  current_state: string[];
  pending_work: string[];
  important_facts: string[];
}

export class SummaryGenerationError extends Error {
  constructor(message: string) {
    super(`summary generation failed: ${message}`);
    this.name = "SummaryGenerationError";
  }
}

/** 字段数上限的硬校验边界（普通跨度 / 大折叠跨度）。 */
export interface SummaryCaps {
  maxItems: number;
  maxChars: number;
  objectiveChars: number;
}

/** 跨度超过此 token 数时按大折叠放宽输出上限。 */
export const BIG_FOLD_SPAN_TOKENS = 50_000;

const NORMAL_CAPS: SummaryCaps = { maxItems: 8, maxChars: 1200, objectiveChars: 400 };
const BIG_FOLD_CAPS: SummaryCaps = { maxItems: 12, maxChars: 2400, objectiveChars: 600 };

export function summaryCaps(spanTokens: number): SummaryCaps {
  return spanTokens > BIG_FOLD_SPAN_TOKENS ? BIG_FOLD_CAPS : NORMAL_CAPS;
}

const SUMMARY_FIELDS = [
  "user_constraints",
  "key_decisions",
  "completed_work",
  "current_state",
  "pending_work",
  "important_facts",
] as const;

/**
 * 硬校验：结构完整、字段类型正确、条数与长度在上限内。
 * 校验失败抛 SummaryGenerationError，由调用方决定重试或放弃。
 */
export function validateSummary(value: unknown, caps: SummaryCaps): RollingConversationSummary {
  if (typeof value !== "object" || value === null) {
    throw new SummaryGenerationError("summary must be a JSON object");
  }
  const v = value as Record<string, unknown>;
  const objective = v.current_objective;
  if (typeof objective !== "string" || objective.trim().length === 0) {
    throw new SummaryGenerationError("current_objective must be a non-empty string");
  }
  if (objective.length > caps.objectiveChars) {
    throw new SummaryGenerationError(`current_objective exceeds ${caps.objectiveChars} chars (${objective.length})`);
  }
  const empty: RollingConversationSummary = {
    current_objective: "",
    user_constraints: [],
    key_decisions: [],
    completed_work: [],
    current_state: [],
    pending_work: [],
    important_facts: [],
  };
  const out: RollingConversationSummary = { ...empty, current_objective: objective.trim() };
  for (const field of SUMMARY_FIELDS) {
    const arr = v[field];
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) {
      throw new SummaryGenerationError(`${field} must be an array of strings`);
    }
    if (arr.length > caps.maxItems) {
      throw new SummaryGenerationError(`${field} exceeds ${caps.maxItems} items (${arr.length})`);
    }
    for (const item of arr as string[]) {
      if (item.length > caps.maxChars) {
        throw new SummaryGenerationError(`${field} item exceeds ${caps.maxChars} chars (${item.length})`);
      }
    }
    out[field] = (arr as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return out;
}

/**
 * 渲染为插在 system 之后的摘要消息文本。带 evidence id 的工具原文在摘要里
 * 只保留"用途 + 完整 ID"引用——全文仍在 Evidence 库可回查。
 */
export function renderSummaryText(summary: RollingConversationSummary): string {
  const list = (items: readonly string[]): string =>
    items.length > 0 ? items.map((s) => `- ${escapeStructuralTags(s)}`).join("\n") : "- (none)";
  return [
    "The earlier conversation was compacted into this rolling summary to stay within the context window:",
    `<context-summary>`,
    `current_objective: ${escapeStructuralTags(summary.current_objective)}`,
    `user_constraints:`,
    list(summary.user_constraints),
    `key_decisions:`,
    list(summary.key_decisions),
    `completed_work:`,
    list(summary.completed_work),
    `current_state:`,
    list(summary.current_state),
    `pending_work:`,
    list(summary.pending_work),
    `important_facts:`,
    list(summary.important_facts),
    `</context-summary>`,
    "Continue the task from here.",
  ].join("\n");
}

/**
 * 摘要 system prompt：结构钉死、软约束写明、三条禁令（不编造、不复制 Task
 * 快照——那是独立事实源、证据原文只留引用）。
 */
export const SUMMARY_SYSTEM_PROMPT =
  "You are a context summarization assistant. Fold the conversation material into a rolling summary. " +
  "Do NOT continue the conversation. ONLY output JSON with EXACTLY these fields: " +
  '{"current_objective": string, "user_constraints": string[], "key_decisions": string[], ' +
  '"completed_work": string[], "current_state": string[], "pending_work": string[], "important_facts": string[]}. ' +
  "Soft limits: at most 5 items per array field, at most 80 characters per item, current_objective at most 200 characters. " +
  "Rules: never invent or infer facts that are not in the material; do not copy task snapshots verbatim (they are an " +
  "independent source of truth and will be re-read); for long tool outputs, keep only a purpose description plus the " +
  "FULL evidence/tool-call id so the original can be looked up later.";

/** 把材料序列化成模型可读文本（单条消息超长截断，防摘要输入本身爆炸）。 */
export function serializeMaterial(messages: readonly AgentMessage[]): string {
  return messages
    .map((m) =>
      JSON.stringify(m, (_, v) => (typeof v === "string" && v.length > 2_000 ? v.slice(0, 2_000) + "…(truncated)" : v)),
    )
    .join("\n");
}

export interface GenerateSummaryOptions {
  /** 本轮要折叠的材料（水位线之后、切割点之前的消息）。 */
  material: readonly AgentMessage[];
  /** 已有的滚动摘要：折叠更新而非从零重建。 */
  previous?: RollingConversationSummary;
  /** 本次压缩跨度 token 数（material 估算 − 压缩目标），驱动大折叠放宽。 */
  spanTokens: number;
  /** 摘要模型角色（默认用 run 自己的模型；独立小模型可传给调用方）。 */
  model: Model<Api>;
  /** 注入的 chat 函数（测试/自定义模型路由）；默认走 pi-ai 注册表。 */
  chat?: ChatFn;
  /** 上次摘要失败的原因：唯一一次更严格重试的提示。 */
  failureHint?: string;
  models?: Models;
  /** run 的 abort 信号：透传给摘要请求（ pi transformContext 契约）。 */
  signal?: AbortSignal;
}

export interface GeneratedSummary {
  summary: RollingConversationSummary;
  attempts: number;
}

function foldMaterial(
  previous: RollingConversationSummary | undefined,
  material: readonly AgentMessage[],
  failureHint?: string,
): string {
  const parts: string[] = [];
  if (failureHint) {
    parts.push(
      `A previous summarization attempt failed validation: ${failureHint}. Be extra careful to satisfy the JSON schema and length limits.`,
    );
  }
  if (previous) {
    parts.push(
      `<previous_summary>\n${JSON.stringify(previous, null, 2)}\n</previous_summary>\n` +
        "Fold the material below into this summary, keeping every field current and every earlier fact that still matters.",
    );
  } else {
    parts.push("Summarize the conversation material below into the rolling summary.");
  }
  parts.push(`Conversation material (JSON lines, one per message):\n${serializeMaterial(material)}`);
  return parts.join("\n\n");
}

/**
 * 生成滚动摘要：直接解析 → 带校验错误重_prompt 一次（completeStructured 的
 * 分层恢复就是"唯一重试机会 retry_compact"）。全部失败抛 SummaryGenerationError，
 * 调用方按"原样返回、绝不动原消息"处理。
 */
export async function generateRollingSummary(options: GenerateSummaryOptions): Promise<GeneratedSummary> {
  const caps = summaryCaps(options.spanTokens);
  const chat =
    options.chat ?? defaultChat(options.model, { models: options.models, systemPrompt: SUMMARY_SYSTEM_PROMPT });
  const prompt = foldMaterial(options.previous, options.material, options.failureHint);
  const { value, attempts } = await completeStructured<RollingConversationSummary>({
    prompt,
    parse: (raw) => {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end <= start) throw new SummaryGenerationError("no JSON object found in output");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch (err) {
        throw new SummaryGenerationError(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      return validateSummary(parsed, caps);
    },
    complete: chat,
    maxReprompts: 1,
    signal: options.signal,
  });
  return { summary: value, attempts };
}
