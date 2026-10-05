import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { toolCallIdsOf, type Block } from "../blocks.js";
import type { RollingConversationSummary } from "../summarizer.js";
import { renderSummaryText } from "../summarizer.js";

/**
 * 第二层：滚动摘要的前缀管理。
 *
 * - 选切割点（summaryCutoffBlockIndex）：保护最近 keepConversationBlocks 个
 *   普通对话块；工具轮的"近期保护"从最后一个可摘要对话块之后算起——否则
 *   历史里最后几个工具轮会永久占住保护位，让后面不断增长的普通对话永远
 *   推不动摘要水位线。
 * - 水位线（coveredMessageCount）持久化在 transformer 状态里；投影永远从
 *   原始历史 + 水位线重建，原始消息序列不可变。
 * - replaceCoveredPrefix 按消息对象引用与 tool_call_id 精确移除被覆盖的
 *   消息；system 消息豁免（永远保留）。摘要消息插在最前导 system 块之后。
 */

export interface SummaryWatermark {
  /** 已被摘要覆盖的前导非 system 消息条数。 */
  coveredCount: number;
  summary: RollingConversationSummary;
  /** 被覆盖消息的对象引用集合（身份匹配的精确移除）。 */
  coveredRefs: Set<object>;
  /** 被覆盖消息涉及的全部 tool_call id（assistant 调用 + toolResult 双侧）。 */
  coveredToolCallIds: Set<string>;
  /** 摘要消息插入的下标（前导 system 块之后）。 */
  cutIndex: number;
  /**
   * 摘要消息对象——水位线推进时创建一次，之后每轮投影复用同一对象，
   * 保证投影字节稳定（prompt cache 的前提）。
   */
  summaryMessage: AgentMessage;
}

/**
 * 加固期第四轮: the serializable core of the watermark. Object references do
 * not survive a process, so refs / tool-call ids / cut index are rebuilt from
 * the transcript on restore; only the two fields that CANNOT be recomputed —
 * how much was covered, and the summary itself — are persisted. Persisting
 * lets a resumed run continue the rolling summary instead of re-summarizing
 * the pre-crash prefix from scratch (cost) and re-rendering a different
 * summary message (prefix bytes → prompt cache).
 */
export interface PersistedWatermark {
  coveredCount: number;
  summary: RollingConversationSummary;
}

export function serializeWatermark(watermark: SummaryWatermark): PersistedWatermark {
  return { coveredCount: watermark.coveredCount, summary: watermark.summary };
}

/**
 * Rebuild a live watermark from its persisted core against the CURRENT
 * transcript. Returns undefined when the record cannot be trusted: a
 * transcript holding fewer non-system messages than the watermark claims
 * means the log lost events below its horizon (reconcile truncation), and a
 * summary that fails to render means the persisted JSON is corrupt — in both
 * cases the caller falls back to a fresh watermark rather than silently
 * dropping messages from the model's view.
 *
 * Limitation (加固期第五轮): SAME-LENGTH prefix drift — an event lost from
 * BOTH sinks below the horizon while later events survive — is not detectable
 * from the transcript alone. That class is caught upstream by the checkpoint
 * cross-check, and resume() withholds the restore whenever any degradation
 * was found; this function itself can only verify the count.
 */
export function restoreWatermark(
  persisted: PersistedWatermark,
  messages: readonly AgentMessage[],
): SummaryWatermark | undefined {
  if (!Number.isInteger(persisted.coveredCount) || persisted.coveredCount < 0) return undefined;
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (persisted.coveredCount > nonSystem.length) return undefined;
  const covered = nonSystem.slice(0, persisted.coveredCount);
  const coveredRefs = new Set<object>(covered as object[]);
  const coveredToolCallIds = new Set<string>();
  for (const m of covered) {
    for (const id of toolCallIdsOf(m)) coveredToolCallIds.add(id);
    if (m.role === "toolResult") coveredToolCallIds.add(m.toolCallId);
  }
  let summaryMessage: AgentMessage;
  try {
    summaryMessage = {
      role: "user",
      content: renderSummaryText(persisted.summary),
      timestamp: Date.now(),
    } as AgentMessage;
  } catch {
    return undefined;
  }
  return {
    coveredCount: persisted.coveredCount,
    summary: persisted.summary,
    coveredRefs,
    coveredToolCallIds,
    cutIndex: leadingSystemRunEnd(messages),
    summaryMessage,
  };
}

export interface CutoffOptions {
  /** 受保护的最近普通对话块数。默认 4。 */
  keepConversationBlocks?: number;
  /** 对话块稀缺时的回退：工具轮为主的历史保护最近 N 轮。默认 2。 */
  keepToolRounds?: number;
}

/**
 * 切割点：返回"可摘要材料"的结束块下标（不含），无事可做时返回 null。
 *
 * 主规则：普通对话块足够多（> keep）时，保护最近 keep 个对话块——工具轮的
 * 近期保护随"最后一个可摘要对话块之后"一并生效，而不是让历史末尾的工具轮
 * 永久占住保护位。
 * 回退规则：对话块稀缺（如一整个 coding run 只有一条任务消息、其余全是工具
 * 轮）时，改为保护最近 keepToolRounds 个工具轮，让更早的轮次可被折叠。
 */
export function summaryCutoffBlockIndex(blocks: readonly Block[], options?: CutoffOptions): number | null {
  const keepConv = options?.keepConversationBlocks ?? 4;
  const keepRounds = options?.keepToolRounds ?? 2;
  const conversationIdxs: number[] = [];
  const roundIdxs: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "conversation") conversationIdxs.push(i);
    else if (b.kind === "toolRound") roundIdxs.push(i);
  }
  if (conversationIdxs.length > keepConv) {
    return conversationIdxs[conversationIdxs.length - keepConv]!;
  }
  if (roundIdxs.length > keepRounds) {
    return roundIdxs[roundIdxs.length - keepRounds]!;
  }
  return null;
}

/** 水位线边界：前导 coveredCount 条非 system 消息之后的消息下标（含 system 穿插）。 */
export function coveredBoundaryIndex(messages: readonly AgentMessage[], coveredCount: number): number {
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "system") continue;
    if (seen >= coveredCount) return i;
    seen++;
  }
  return messages.length;
}

/** 水位线之后、尚未被任何摘要覆盖的普通对话块数。 */
export function countUnsummarizedConversationBlocks(blocks: readonly Block[], boundaryIndex: number): number {
  return blocks.filter((b) => b.kind === "conversation" && b.start >= boundaryIndex).length;
}

/**
 * 生成摘要水位线：把 [boundary, cutoffEnd) 的材料折叠进新摘要。
 * （fold 本身由 summarizer.ts 完成；这里负责水位线簿记。）
 */
export function advanceWatermark(
  previous: SummaryWatermark | undefined,
  messages: readonly AgentMessage[],
  material: readonly AgentMessage[],
  summary: RollingConversationSummary,
): SummaryWatermark {
  const coveredRefs = new Set<object>(previous?.coveredRefs ?? []);
  const coveredToolCallIds = new Set<string>(previous?.coveredToolCallIds ?? []);
  for (const m of material) {
    coveredRefs.add(m as object);
    for (const id of toolCallIdsOf(m)) coveredToolCallIds.add(id);
    if (m.role === "toolResult") coveredToolCallIds.add(m.toolCallId);
  }
  const coveredCount = (previous?.coveredCount ?? 0) + countNonSystem(material);
  const cutIndex = leadingSystemRunEnd(messages);
  return {
    coveredCount,
    summary,
    coveredRefs,
    coveredToolCallIds,
    cutIndex,
    summaryMessage: {
      role: "user",
      content: renderSummaryText(summary),
      timestamp: Date.now(),
    } as AgentMessage,
  };
}

function countNonSystem(messages: readonly AgentMessage[]): number {
  return messages.filter((m) => m.role !== "system").length;
}

/** 前导连续 system 块的结束下标（摘要消息的插入点）。 */
function leadingSystemRunEnd(messages: readonly AgentMessage[]): number {
  let i = 0;
  while (i < messages.length && messages[i]?.role === "system") i++;
  return i;
}

/**
 * 从原始历史 + 水位线重建投影：被覆盖的前缀替换为一条摘要消息。
 * 移除判定取"位置水位线 ∨ 引用/ID 精确匹配"的并集——位置计数是快路径
 * （append-only 转录两者一致），引用与 tool_call_id 匹配兜住转录被外部
 * 改写的情形；system 消息永远豁免。
 */
export function replaceCoveredPrefix(messages: readonly AgentMessage[], watermark: SummaryWatermark): AgentMessage[] {
  const out: AgentMessage[] = [];
  let nonSystemSeen = 0;
  for (const m of messages) {
    if (m.role === "system") {
      out.push(m);
      continue;
    }
    const byPosition = nonSystemSeen < watermark.coveredCount;
    const byRef =
      watermark.coveredRefs.has(m as object) ||
      (m.role === "toolResult" && watermark.coveredToolCallIds.has(m.toolCallId)) ||
      toolCallIdsOf(m).some((id) => watermark.coveredToolCallIds.has(id));
    // 超过位置边界的消息若仍被引用命中，说明转录被改写——保守移除。
    if (byPosition || byRef) {
      nonSystemSeen++;
      continue;
    }
    out.push(m);
    nonSystemSeen++;
  }
  const insertAt = Math.min(watermark.cutIndex, out.length);
  out.splice(insertAt, 0, watermark.summaryMessage);
  return out;
}

/** 等价于 replaceCoveredPrefix 的"无新摘要"形态：按现有水位线重建投影。 */
export function buildSummaryCandidate(messages: readonly AgentMessage[], watermark: SummaryWatermark): AgentMessage[] {
  return replaceCoveredPrefix(messages, watermark);
}
