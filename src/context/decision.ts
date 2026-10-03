import type { ContextBudget } from "./budget.js";
import type { BlockStats } from "./blocks.js";

/**
 * 决策即数据：每次 prepare 产出一个 ContextDecision——可解释、可进 Trace、
 * 可在前端回放。40+ 字段记录"看到了什么、按哪条线判断、做了什么、代价多少"。
 */

export type PrefixDecisionKind = "reuse" | "defer" | "compact" | "rebuild";

/**
 * prefix_decision 语义（服务 prompt cache）：
 * - reuse   纯续用：投影在软线内，原样发送。
 * - defer   已越软线但缓存前缀可复用，继续追加，暂不压缩。
 * - compact 真压缩：命中硬边界（超 input_budget / 越强制线 / 未摘要块超限），
 *           回落到 forced_target（≈ 软线），前缀尽量少断。
 * - rebuild 前缀断裂（缓存已丢）：一次深压到 target_tokens。
 */
export interface ContextDecision {
  decision: PrefixDecisionKind;
  /** 一句话因果，永远可读。 */
  reason: string;

  // —— 估算 ——
  /** 本请求投影的混合估算（实测 Usage + 尾部校准估算）。 */
  estimatedTokens: number;
  /** 全量原始转录的校准估算（未应用水位线/Reducer）。 */
  transcriptEstimate: number;
  /** 最后一条 assistant 的实测 context token（无则 null）。 */
  usageTokens: number | null;

  // —— 预算线快照 ——
  budget: ContextBudget;

  // —— 块结构 ——
  blocks: BlockStats;
  /** 水位线之后、尚未被任何摘要覆盖的普通对话块数。 */
  unsummarizedConversationBlocks: number;
  unsummarizedLimit: number;

  // —— 第一层（工具结果整理） ——
  toolRoundsTrimmed: number;
  toolRoundsRemoved: number;
  toolResultSavedTokens: number;

  // —— 第二层（滚动摘要） ——
  summarized: boolean;
  summaryAttempts?: number;
  summaryChars?: number;
  /** 摘要消息插入位置（转录下标）；仅本轮真正生成了摘要时有值。 */
  cutIndex?: number;
  /** 覆盖水位线（本决策后）。 */
  coveredMessageCount: number;

  // —— 缓存/前缀 ——
  /** 缓存前缀是否仍然完整（append-only 检查）。 */
  cachePrefixIntact: boolean;
  /** 持久化前缀边界（resume 重建的转录长度；fresh run 为 0）。 */
  historyCount: number;

  // —— 结果 ——
  /** 压缩后投影的估算（decision=compact/rebuild 时）。 */
  tokensAfter?: number;
  durationMs: number;
}
