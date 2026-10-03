import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { partitionMessages, type ToolRoundBlock } from "../blocks.js";
import { estimateMessageTokens, estimateMessagesTokens } from "../tokens.js";

/**
 * 第一层：工具结果整理（确定性、零模型成本）。
 *
 * 触发条件：未受保护的旧工具轮的结果 token 合计超过独立小账本
 * （tool_result_budget）。最近 keep_recent_tool_rounds（默认 2）轮是"当前
 * 工作证据"，绝不截短不删除；最后一个 user 消息之后的轮次是当前回合，
 * resume 边界（historyCount）之后的轮次属于当前 Run 新增消息——全部豁免。
 * 其余旧轮按两步走：
 *
 *  1. 截短：保留 head + tail 字符，中间插入标记（保留 tool 与 tool_call_id，
 *     配合 Evidence 库可回查全文）；
 *  2. 仍超预算 → 最旧优先整轮移除（assistant + 结果一起），删一个测一次，够就停。
 *
 * 特例：注册了语义裁剪器的工具（如结构化 JSON 观测结果）不走头尾截断，
 * 而是解析后保留元数据、按预算贪心装填 elements 数组，始终输出合法 JSON。
 */

export interface SemanticTrimmer {
  /**
   * 把结果文本裁剪到 budgetChars 以内且保持语义完整（如合法 JSON）。
   * 返回 undefined 表示无法语义裁剪——回退到头尾截断。
   */
  (text: string, budgetChars: number): string | undefined;
}

export interface ToolReducerOptions {
  /** 旧工具轮结果的 token 小账本。 */
  budgetTokens: number;
  /** 全局最近 N 轮工具轮受保护。默认 2。 */
  keepRecentRounds?: number;
  /** 截短保留的头部长度。默认 4000。 */
  headChars?: number;
  /** 截短保留的尾部长度。默认 2000。 */
  tailChars?: number;
  /** Evidence 目录（相对路径），截短标记里给出全文回查指针。 */
  evidenceBase?: string;
  /** 按工具名注册的语义裁剪器。 */
  semanticTrimmers?: Readonly<Record<string, SemanticTrimmer>>;
}

export interface ToolReduction {
  messages: readonly AgentMessage[];
  trimmedRounds: number;
  removedRounds: number;
  savedTokens: number;
  /** 触发时旧轮结果合计是否超账本。 */
  triggered: boolean;
}

export const DEFAULT_TOOL_REDUCER_OPTIONS = {
  keepRecentRounds: 2,
  headChars: 4_000,
  tailChars: 2_000,
} as const;

/**
 * 头尾截断标记：保留工具名与 tool_call_id，模型可引用；字符数如实记录，
 * Evidence 库按 toolCallId 存有全文。
 */
export function compactionMarker(
  toolName: string,
  toolCallId: string,
  originalChars: number,
  omitted: number,
  evidenceBase?: string,
): string {
  const pointer = evidenceBase ? `; full output: ${evidenceBase}/${toolCallId}.md` : "";
  return `[tool result compacted: tool=${toolName}; tool_call_id=${toolCallId}; original_chars=${originalChars}; omitted ${omitted} characters${pointer}]`;
}

/**
 * JSON 观测结果的语义裁剪：解析后保留标量元数据字段，elements/items 等
 * 数组字段贪心装填到预算内，始终输出合法 JSON。解析失败或形状不符时
 * 返回 undefined，调用方回退到头尾截断。
 */
export function jsonArraySemanticTrim(text: string, budgetChars: number): string | undefined {
  const head = text.trimStart()[0];
  if (head !== "{" && head !== "[") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const arrayKey = ["elements", "items", "entries", "results", "files", "matches"].find((k) => Array.isArray(obj[k]));
  if (!arrayKey) return undefined;
  const entries = obj[arrayKey] as unknown[];
  const envelope = { ...obj, [arrayKey]: [] as unknown[] };
  let used = JSON.stringify(envelope).length;
  const kept: unknown[] = [];
  for (const entry of entries) {
    const size = JSON.stringify(entry).length + 1;
    if (used + size > budgetChars) break;
    kept.push(entry);
    used += size;
  }
  return JSON.stringify({ ...envelope, [arrayKey]: kept, truncated: kept.length < entries.length });
}

interface RoundPlan {
  block: ToolRoundBlock;
  /** 结果消息的校准 token 合计。 */
  tokens: number;
}

/** 压缩边界：对象引用集合而非下标——投影重建会平移下标，身份引用不会。 */
export interface ToolReducerBoundary {
  /** 当前 Run 新增消息（resume 持久化前缀之后的所有消息）；命中任一消息的轮次整轮豁免。 */
  protectedRefs: ReadonlySet<object>;
}

/**
 * 第一层 Reducer。返回新数组；未触发时原样返回传入引用（零成本快速路径）。
 * 转录与 Trace 永不修改——这里只塑形模型视图。
 */
export function reduceToolResults(
  messages: readonly AgentMessage[],
  coefficient: number,
  options: ToolReducerOptions,
  boundary: ToolReducerBoundary,
): ToolReduction {
  const keep = options.keepRecentRounds ?? DEFAULT_TOOL_REDUCER_OPTIONS.keepRecentRounds;
  const head = options.headChars ?? DEFAULT_TOOL_REDUCER_OPTIONS.headChars;
  const tail = options.tailChars ?? DEFAULT_TOOL_REDUCER_OPTIONS.tailChars;
  const blocks = partitionMessages(messages);
  const rounds = blocks.filter((b): b is ToolRoundBlock => b.kind === "toolRound");
  if (rounds.length === 0) return { messages, trimmedRounds: 0, removedRounds: 0, savedTokens: 0, triggered: false };

  const lastUserIndex = findLastIndex(messages, (m) => m.role === "user");
  const protectedFrom = rounds.length - keep; // 全局序数 ≥ 此值 = 全局最近 keep 轮
  const touchesProtected = (block: ToolRoundBlock): boolean =>
    boundary.protectedRefs.has(block.assistant as object) ||
    block.results.some((r) => boundary.protectedRefs.has(r as object));
  const isCompactable = (ordinal: number, block: ToolRoundBlock): boolean =>
    ordinal < protectedFrom && block.end <= lastUserIndex && !touchesProtected(block);
  const oldRounds: RoundPlan[] = [];
  for (let ordinal = 0; ordinal < rounds.length; ordinal++) {
    const block = rounds[ordinal]!;
    if (isCompactable(ordinal, block)) {
      oldRounds.push({ block, tokens: estimateMessagesTokens(block.results, coefficient) });
    }
  }
  const oldTokens = oldRounds.reduce((acc, p) => acc + p.tokens, 0);
  if (oldTokens <= options.budgetTokens) {
    return { messages, trimmedRounds: 0, removedRounds: 0, savedTokens: 0, triggered: false };
  }

  // 输出数组以 splice 改写；从旧到新处理时用 running offset 修正块下标。
  const output = [...messages];
  let offset = 0;
  let remaining = oldTokens;
  let trimmed = 0;
  let removed = 0;
  let saved = 0;

  // 第 1 步：逐轮截短（最旧优先），边截边测，够就停。
  for (const plan of oldRounds) {
    if (remaining <= options.budgetTokens) break;
    const replacedResults = plan.block.results.map((r) =>
      r.role === "toolResult" ? shrinkResult(r, plan.block.toolCallIds, head, tail, options, coefficient) : r,
    );
    const unchanged = replacedResults.every((r, idx) => r === plan.block.results[idx]);
    if (unchanged) continue;
    const width = plan.block.end - plan.block.start;
    const replacement = [plan.block.assistant, ...replacedResults];
    output.splice(plan.block.start + offset, width, ...replacement);
    offset += replacement.length - width;
    const after = estimateMessagesTokens(replacedResults, coefficient);
    saved += plan.tokens - after;
    remaining -= plan.tokens - after;
    plan.tokens = after;
    trimmed++;
  }

  // 第 2 步：仍超账本 → 最旧优先整轮移除，删一个测一次，够就停。
  for (const plan of oldRounds) {
    if (remaining <= options.budgetTokens) break;
    const width = plan.block.end - plan.block.start;
    const start = plan.block.start + offset;
    if (output[start] !== plan.block.assistant) continue; // 已被前一步改写，跳过（防御）
    output.splice(start, width);
    offset -= width;
    saved += plan.tokens;
    remaining -= plan.tokens;
    removed++;
  }

  return { messages: output, trimmedRounds: trimmed, removedRounds: removed, savedTokens: saved, triggered: true };
}

function findLastIndex(messages: readonly AgentMessage[], pred: (m: AgentMessage) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) if (pred(messages[i]!)) return i;
  return -1;
}

/** 单条结果的截短/语义裁剪。只动 text 块；image 块原样保留。无可裁内容时原引用返回。 */
function shrinkResult(
  result: Extract<AgentMessage, { role: "toolResult" }>,
  _roundCallIds: readonly string[],
  head: number,
  tail: number,
  options: ToolReducerOptions,
  coefficient: number,
): AgentMessage {
  const textBlocks = result.content.filter((b): b is { type: "text"; text: string } => b.type === "text");
  if (textBlocks.length === 0) return result;
  const original = textBlocks.map((b) => b.text).join("");
  if (original.length <= head + tail) return result;

  const other = result.content.filter((b) => b.type !== "text");
  const budgetChars = head + tail;

  // 语义裁剪特例：注册了裁剪器的工具优先，产出合法 JSON；失败回退头尾截断。
  const trimmer = options.semanticTrimmers?.[result.toolName];
  if (trimmer) {
    const semantic = trimmer(original, budgetChars);
    if (semantic !== undefined) {
      return { ...result, content: [...other, { type: "text", text: semantic }] } as AgentMessage;
    }
  }

  const marker = compactionMarker(
    result.toolName,
    result.toolCallId,
    original.length,
    original.length - head - tail,
    options.evidenceBase,
  );
  const text = `${original.slice(0, head)}\n${marker}\n${original.slice(original.length - tail)}`;
  const next = { ...result, content: [...other, { type: "text", text }] } as AgentMessage;
  // 截短只减不增；万一信封开销反超（极短结果 + 长标记），放弃以保字节稳定。
  if (estimateMessageTokens(next, coefficient) >= estimateMessageTokens(result, coefficient)) return result;
  return next;
}
