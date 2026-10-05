import { estimateTokens as baseEstimateTokens } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";

/**
 * Token 估算与校准闭环。
 *
 * 底座是 pi 的字符启发式（≈ chars/4，英文语料），再乘以模型族保守系数——
 * 不同分词器对同一文本的 token 数差异可观，系数把"估少了"的风险移到"估多"侧。
 *
 *   openai 1.0 / qwen 1.2 / deepseek 1.35 / anthropic 1.15，未知族 1.3。
 *
 * 系数不是拍的：scripts/calibrate_tokens.mjs 用真实 Trace 样本校准
 * （估算/实际 的 P50/P95 分布，node scripts/calibrate_tokens.mjs [--traces dir]）。
 * 旧系数尾部低估时上调，剩余缺口由两层兜底：① 预算线自带安全余量；
 * ② 最后一条 assistant Usage 是实测 context 值，其后新增尾部用估算【求和】
 * ——实测是事实，估算只补增量（加固期注释修正：旧注释写的"按大者取值"
 * 与实现的求和语义不符）。
 */

/** 模型族系数（校准产物；改动须能被校准脚本复现）。 */
export const TOKEN_COEFFICIENTS = {
  openai: 1.0,
  qwen: 1.2,
  deepseek: 1.35,
  anthropic: 1.15,
} as const;

/** 未知模型族的保守默认：宁可多估（提前压缩）不可少估（窗口溢出）。 */
export const DEFAULT_TOKEN_COEFFICIENT = 1.3;

/**
 * 按模型族取系数。provider 命中优先（harness 自注册的 "qwen" provider），
 * 其次按模型 id 的族名模糊匹配（openrouter 上的 deepseek/qwen/claude/gpt）。
 */
export function tokenCoefficient(provider: string, modelId: string): number {
  const p = provider.toLowerCase();
  const id = modelId.toLowerCase();
  if (p === "qwen" || id.includes("qwen")) return TOKEN_COEFFICIENTS.qwen;
  if (p === "deepseek" || id.includes("deepseek")) return TOKEN_COEFFICIENTS.deepseek;
  if (p === "anthropic" || p === "amazon-bedrock" || id.includes("claude")) return TOKEN_COEFFICIENTS.anthropic;
  if (p === "openai" || /^(gpt-|o\d)/.test(id)) return TOKEN_COEFFICIENTS.openai;
  return DEFAULT_TOKEN_COEFFICIENT;
}

export function tokenCoefficientFor(model: Pick<Model<Api>, "provider" | "id">): number {
  return tokenCoefficient(model.provider, model.id);
}

/** 单条消息的校准估算（向上取整）。 */
export function estimateMessageTokens(message: AgentMessage, coefficient: number): number {
  return Math.ceil(baseEstimateTokens(message) * coefficient);
}

/** 一段消息的校准估算合计。 */
export function estimateMessagesTokens(messages: readonly AgentMessage[], coefficient: number): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m, coefficient);
  return total;
}

export interface ContextUsageEstimate {
  /** 混合估算：实测 Usage（如有）+ 其后尾部的校准估算，取大者。 */
  tokens: number;
  /** 最后一条 assistant 的实测 context token（无则 null）。 */
  usageTokens: number | null;
  /** 实测值之后新增尾部的估算（无实测值时为全量估算）。 */
  trailingTokens: number;
  /** 提供实测值的消息下标，无则 null。 */
  lastUsageIndex: number | null;
}

function usageContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * 上下文估算：最后一条 assistant 的 Usage 是该次请求的实测值（provider 分词
 * 数出来的），其后新增的消息没有实测，用校准估算补上；无实测时退化为全量
 * 校准估算。实测与估算不取平均——实测已经"是"事实，估算只补增量。
 */
export function estimateContextTokens(messages: readonly AgentMessage[], coefficient: number): ContextUsageEstimate {
  let lastUsageIndex: number | null = null;
  let lastUsage: Usage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.usage && m.stopReason !== "error") {
      lastUsageIndex = i;
      lastUsage = m.usage;
      break;
    }
  }
  if (lastUsageIndex === null || !lastUsage) {
    const tokens = estimateMessagesTokens(messages, coefficient);
    return { tokens, usageTokens: null, trailingTokens: tokens, lastUsageIndex: null };
  }
  const usageTokens = usageContextTokens(lastUsage);
  const trailingTokens = estimateMessagesTokens(messages.slice(lastUsageIndex + 1), coefficient);
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex };
}
