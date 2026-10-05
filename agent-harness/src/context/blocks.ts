import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * 块模型：压缩的最小单元。消息先被切成四类块，所有压缩操作都以块为单位，
 * 绝不产生半截工具轮。
 *
 * - SystemBlock       — system 消息，永远保留。
 * - ConversationBlock — 一轮普通对话（一条 user 消息及紧随的纯文本 assistant 回复）。
 * - ToolRoundBlock    — assistant 工具调用 + 紧随其后的结果，tool_call id 用
 *                       Counter 完全配对（每个 id 恰好一次调用、一次结果）。
 * - MalformedToolBlock— 协议异常（结果缺失/重复/多余、孤立 toolResult），
 *                       保守整块保留——截断工具协议会让后续 API 调用直接报错。
 */

export interface BlockBase {
  /** 本块首条消息在源数组中的下标。 */
  start: number;
  /** 本块末条消息下标 + 1（开区间）。 */
  end: number;
}

export interface SystemBlock extends BlockBase {
  kind: "system";
  messages: [AgentMessage, ...AgentMessage[]];
}

export interface ConversationBlock extends BlockBase {
  kind: "conversation";
  messages: AgentMessage[];
}

export interface ToolRoundBlock extends BlockBase {
  kind: "toolRound";
  assistant: AgentMessage;
  results: AgentMessage[];
  /** assistant 消息里全部 toolCall 的 id（与 results 的 tool_call_id 一一配对）。 */
  toolCallIds: string[];
}

export interface MalformedToolBlock extends BlockBase {
  kind: "malformed";
  messages: AgentMessage[];
  reason: string;
}

export type Block = SystemBlock | ConversationBlock | ToolRoundBlock | MalformedToolBlock;

/** id → 出现次数 的精确计数（配对校验不能用 Set：重复 id 必须被判为不合法）。 */
function counterOf(values: readonly string[]): Map<string, number> {
  const counter = new Map<string, number>();
  for (const v of values) counter.set(v, (counter.get(v) ?? 0) + 1);
  return counter;
}

function countersEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export function toolCallIdsOf(message: AgentMessage): string[] {
  // Array.isArray guard (加固期): pi's transformContext contract says a
  // transformer must never throw — a hand-built transcript with string
  // assistant content used to TypeError out of partitionMessages and kill
  // the whole request.
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((b) => b.type === "toolCall").map((b) => (b as { id: string }).id);
}

function isToolResult(m: AgentMessage): m is Extract<AgentMessage, { role: "toolResult" }> {
  return m.role === "toolResult";
}

/**
 * 把消息序列切成块。约定：
 * - 连续的 user 消息归入同一 ConversationBlock；纯文本 assistant 消息只在
 *   紧跟该块内 user 消息时并入（否则自成一块）。
 * - 带 toolCall 的 assistant 开启一个工具轮，吞掉后续 toolResult 直到配对
 *   完整；id 用 Counter 完全配对才算合法，否则整块降级 MalformedToolBlock。
 * - 游离的 toolResult（前面没有配对的 assistant）也是 MalformedToolBlock。
 */
export function partitionMessages(messages: readonly AgentMessage[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "system") {
      blocks.push({ kind: "system", start: i, end: i + 1, messages: [m] });
      i++;
      continue;
    }
    if (m.role === "user") {
      let end = i + 1;
      while (end < messages.length && messages[end]?.role === "user") end++;
      blocks.push({ kind: "conversation", start: i, end, messages: messages.slice(i, end) });
      i = end;
      continue;
    }
    if (m.role === "assistant") {
      const callIds = toolCallIdsOf(m);
      if (callIds.length === 0) {
        const prev = blocks.at(-1);
        if (prev && prev.kind === "conversation" && prev.end === i && prev.messages.at(-1)?.role === "user") {
          // 紧跟 user 的纯文本回复：并入同一轮普通对话。
          prev.messages.push(m);
          prev.end = i + 1;
        } else {
          blocks.push({ kind: "conversation", start: i, end: i + 1, messages: [m] });
        }
        i++;
        continue;
      }
      const wanted = counterOf(callIds);
      let end = i + 1;
      const results: AgentMessage[] = [];
      const seen = new Map<string, number>();
      while (end < messages.length) {
        const r = messages[end];
        if (!r || !isToolResult(r)) break;
        seen.set(r.toolCallId, (seen.get(r.toolCallId) ?? 0) + 1);
        results.push(r);
        end++;
      }
      if (countersEqual(wanted, seen)) {
        blocks.push({ kind: "toolRound", start: i, end, assistant: m, results, toolCallIds: callIds });
      } else {
        blocks.push({
          kind: "malformed",
          start: i,
          end,
          messages: messages.slice(i, end),
          reason: `tool_call ids do not pair exactly: calls=${fmtCounter(wanted)} results=${fmtCounter(seen)}`,
        });
      }
      i = end;
      continue;
    }
    if (isToolResult(m)) {
      blocks.push({ kind: "malformed", start: i, end: i + 1, messages: [m], reason: "orphan toolResult" });
      i++;
      continue;
    }
    // 自定义/UI 消息：保守归入 conversation（永不主动压缩）。
    blocks.push({ kind: "conversation", start: i, end: i + 1, messages: [m] });
    i++;
  }
  return blocks;
}

function fmtCounter(c: Map<string, number>): string {
  return [...c.entries()].map(([k, v]) => (v === 1 ? k : `${k}×${v}`)).join(",") || "(none)";
}

/** 各类块的个数小计，进 ContextDecision。 */
export interface BlockStats {
  system: number;
  conversation: number;
  toolRound: number;
  malformed: number;
  total: number;
}

export function blockStats(blocks: readonly Block[]): BlockStats {
  const stats: BlockStats = { system: 0, conversation: 0, toolRound: 0, malformed: 0, total: blocks.length };
  for (const b of blocks) stats[b.kind]++;
  return stats;
}

/** 块内全部消息（ToolRoundBlock 是 assistant + results）。 */
export function blockMessages(block: Block): readonly AgentMessage[] {
  switch (block.kind) {
    case "system":
    case "conversation":
    case "malformed":
      return block.messages;
    case "toolRound":
      return [block.assistant, ...block.results];
  }
}
