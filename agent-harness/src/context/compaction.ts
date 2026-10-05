import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { blockStats, partitionMessages } from "./blocks.js";
import { computeContextBudget, type BudgetOptions, type ContextBudget } from "./budget.js";
import { estimateContextTokens, estimateMessagesTokens, tokenCoefficientFor } from "./tokens.js";
import { reduceToolResults, DEFAULT_TOOL_REDUCER_OPTIONS, type ToolReducerOptions } from "./reducers/tool.js";
import {
  advanceWatermark,
  buildSummaryCandidate,
  countUnsummarizedConversationBlocks,
  coveredBoundaryIndex,
  replaceCoveredPrefix,
  summaryCutoffBlockIndex,
  type SummaryWatermark,
} from "./reducers/conversation.js";
import {
  generateRollingSummary,
  renderSummaryText,
  SummaryGenerationError,
  type RollingConversationSummary,
} from "./summarizer.js";
import type { ContextDecision, PrefixDecisionKind } from "./decision.js";
import type { HarnessAuditEvent } from "../trace/schema.js";
import type { ChatFn } from "../llm/structured.js";

/**
 * 上下文管理编排器——transformContext 钩子的实现。
 *
 * 总体数据流：
 *   原始消息序列（不可变）→ partition_messages 切块 → TokenEstimator 估算
 *   → ContextBudgetPolicy 六条预算线 → 第一层 ToolReducer（确定性，便宜）
 *   → 仍越硬边界？ → 第二层 ConversationReducer（模型摘要，贵）
 *   → ContextDecision（决策即数据）→ Trace / 前端。
 *
 * 三个贯穿始终的原则：
 *   1. 原始历史永不修改——prepare 只产出投影；
 *   2. 决策即数据——每次决策可解释、可进 Trace；
 *   3. 前缀缓存优先——压缩时机为 prompt cache 让路：每次请求产出一个
 *      prefix_decision（reuse 纯续用 / defer 越软线但缓存前缀可复用，继续
 *      追加 / compact 真压缩 / rebuild 前缀断裂）。越软线不立即压缩，先把
 *      prompt cache 吃干净；只有预估超 input_budget、越过强制线、未摘要块
 *      数超限三条硬边界才强制压；前缀断裂（缓存已丢）时才深压到 target。
 */

export interface ContextManagementOptions {
  model: Model<Api>;
  /** 六条预算线的覆盖项。 */
  budget?: BudgetOptions;
  /** 第一层 Reducer 覆盖项（budgetTokens 由预算线的 toolResultBudget 派生）。 */
  tool?: Omit<Partial<ToolReducerOptions>, "budgetTokens">;
  /** 未摘要普通对话块的强制压缩阈值。默认 12。 */
  maxUnsummarizedBlocks?: number;
  /** 切割点保护的最近普通对话块数。默认 4。 */
  keepConversationBlocks?: number;
  /**
   * resume 场景：恢复出的持久化转录长度。其后的消息属于当前 Run——第一层
   * 永不触碰、摘要水位线也不会覆盖它们。fresh run 不传。
   */
  historyCount?: number;
  /** Evidence 目录（相对路径），截短标记里的全文回查指针。 */
  evidenceBase?: string;
  /** 注入的摘要 chat 函数（测试/独立摘要模型路由）。 */
  summaryChat?: ChatFn;
  models?: Models;
  onEvent?: (event: HarnessAuditEvent) => void;
  /** 每次请求的完整决策记录（前端/测试消费）。 */
  onDecision?: (decision: ContextDecision) => void;
}

const DEFAULT_MAX_UNSUMMARIZED_BLOCKS = 12;
const DEFAULT_KEEP_CONVERSATION_BLOCKS = 4;

interface PrefixState {
  watermark?: SummaryWatermark;
  /** 上次请求看到的原始转录消息引用（append-only 检查 = 缓存前缀完整性）。 */
  lastRefs: readonly object[] | undefined;
  /** 上次第二层失败的原因：唯一重试机会携带的更严格提示。 */
  lastSummaryFailure?: string;
}

function prefixIntact(messages: readonly AgentMessage[], lastRefs: readonly object[] | undefined): boolean {
  if (!lastRefs) return false; // 首个请求：缓存本就是空的
  if (messages.length < lastRefs.length) return false;
  for (let i = 0; i < lastRefs.length; i++) {
    if (messages[i] !== lastRefs[i]) return false;
  }
  return true;
}

/**
 * 构造 pi transformContext 钩子。同一实例跨整个 Run 持有水位线与前缀状态；
 * 每次调用是纯函数式的投影重建——原始转录永不修改。
 */
export function createContextTransformer(
  options: ContextManagementOptions,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const coeff = tokenCoefficientFor(options.model);
  const budget = computeContextBudget(options.model, options.budget);
  const maxUnsummarized = options.maxUnsummarizedBlocks ?? DEFAULT_MAX_UNSUMMARIZED_BLOCKS;
  const keepConversationBlocks = options.keepConversationBlocks ?? DEFAULT_KEEP_CONVERSATION_BLOCKS;
  const toolOptions: ToolReducerOptions = {
    ...DEFAULT_TOOL_REDUCER_OPTIONS,
    ...options.tool,
    budgetTokens: budget.toolResultBudget,
    evidenceBase: options.evidenceBase ?? options.tool?.evidenceBase,
  };
  const state: PrefixState = { lastRefs: undefined };

  // pi 以 (messages, signal) 调用本钩子并 await 其结果——run 被 abort 时
  // 按其"必须不抛、返回安全回退"的契约原样返回，不再发起摘要模型调用。
  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    if (signal?.aborted) return messages;
    const started = Date.now();
    const blocks = partitionMessages(messages);
    const stats = blockStats(blocks);
    const transcriptEstimate = estimateContextTokens(messages, coeff).tokens;
    const watermark = state.watermark;

    // resume 边界按对象引用传递：投影重建会平移下标，身份不会。当前 Run
    // 新增的消息在两层都不可触碰（第一层不截短、第二层不折叠）。
    const persistedEnd = options.historyCount ?? messages.length;
    const protectedRefs: ReadonlySet<object> = new Set(messages.slice(persistedEnd) as object[]);

    // —— 第一层（确定性，零模型成本）：对候选投影跑工具结果整理 ——
    const candidate = watermark ? buildSummaryCandidate(messages, watermark) : messages;
    const reduction = reduceToolResults(candidate, coeff, toolOptions, { protectedRefs });
    const estimate = estimateContextTokens(reduction.messages, coeff);
    const boundary = coveredBoundaryIndex(messages, watermark?.coveredCount ?? 0);
    const unsummarized = countUnsummarizedConversationBlocks(blocks, boundary);

    const overSoft = estimate.tokens > budget.triggerTokens;
    const overForced = estimate.tokens > budget.compactCeiling;
    const overInput = estimate.tokens > budget.inputBudget;
    const overBlocks = unsummarized > maxUnsummarized;
    const intact = prefixIntact(messages, state.lastRefs);

    let decision: PrefixDecisionKind;
    let reason: string;
    let projection: readonly AgentMessage[] = reduction.messages;
    let summaryChars: number | undefined;
    let cutIndex: number | undefined;
    let summaryAttempts: number | undefined;
    let tokensAfter: number | undefined;
    let summarized = false;

    if (!overSoft && !overBlocks) {
      decision = "reuse";
      reason = `estimate ${estimate.tokens} ≤ soft line ${budget.triggerTokens}`;
    } else if (overSoft && !overForced && !overInput && !overBlocks) {
      decision = "defer";
      reason = `estimate ${estimate.tokens} over soft line ${budget.triggerTokens} but under forced line ${budget.compactCeiling} — keep appending`;
    } else {
      const hard = overInput
        ? `estimate ${estimate.tokens} exceeds input budget ${budget.inputBudget}`
        : overForced
          ? `estimate ${estimate.tokens} exceeds forced line ${budget.compactCeiling}`
          : `unsummarized conversation blocks ${unsummarized} exceed limit ${maxUnsummarized}`;
      decision = intact ? "compact" : "rebuild";
      reason = intact
        ? `${hard}; prefix intact — compact back to forced target`
        : `${hard}; no reusable cached prefix — deep compact to target`;

      if (signal?.aborted) {
        // abort 落在决策之后：跳过摘要模型调用（其结果永远不会被消费），
        // 第一层投影原样返回——原始历史仍然未被触碰。
        reason += "; run aborted — summarization skipped, layer-1 projection returned";
      } else {
        const compacted = await compactOnce(messages, blocks, watermark, {
          deep: !intact,
          budget,
          keepConversationBlocks,
          toolOptions,
          persistedEnd,
          protectedRefs,
          coeff,
          failureHint: state.lastSummaryFailure,
          model: options.model,
          models: options.models,
          summaryChat: options.summaryChat,
          signal,
        });
        if (compacted.ok) {
          projection = compacted.projection;
          state.watermark = compacted.watermark;
          state.lastSummaryFailure = undefined;
          summarized = true;
          summaryChars = compacted.summaryChars;
          cutIndex = compacted.cutIndex;
          summaryAttempts = compacted.attempts;
          tokensAfter = compacted.tokensAfter;
          // 加固期第三轮: posterior check — a single oversized "protected" block
          // (immune to both layers by design) can leave the projection over the
          // hard input budget even after a successful summary; the model call
          // below may then die at the provider window. Surface it on the
          // decision AND stderr instead of failing silently at the API.
          if (compacted.tokensAfter > budget.inputBudget) {
            reason +=
              `; POST-COMPACTION still over input budget (${compacted.tokensAfter} > ${budget.inputBudget}` +
              ` tokens) — an oversized protected block may be immune to both layers`;
            process.stderr.write(
              `[harness] context: projection still exceeds the input budget after compaction ` +
                `(${compacted.tokensAfter} > ${budget.inputBudget}) — an oversized protected block may be immune to both layers\n`,
            );
          }
          options.onEvent?.({
            type: "compaction",
            trigger: watermark ? "rolling" : "threshold",
            tokensBefore: estimate.tokens,
            summaryChars: compacted.summaryChars,
            cutIndex: compacted.cutIndex,
          });
        } else {
          // 闸门①：摘要失败 → 原样返回投影，绝不动原始消息。
          state.lastSummaryFailure = compacted.error;
          reason += `; summarization failed (${compacted.error}) — projection returned unchanged`;
        }
      }
    }

    state.lastRefs = [...messages];
    const record: ContextDecision = {
      decision,
      reason,
      estimatedTokens: estimate.tokens,
      transcriptEstimate,
      usageTokens: estimate.usageTokens,
      budget,
      blocks: stats,
      unsummarizedConversationBlocks: unsummarized,
      unsummarizedLimit: maxUnsummarized,
      toolRoundsTrimmed: reduction.trimmedRounds,
      toolRoundsRemoved: reduction.removedRounds,
      toolResultSavedTokens: reduction.savedTokens,
      summarized,
      summaryAttempts,
      summaryChars,
      cutIndex,
      coveredMessageCount: state.watermark?.coveredCount ?? 0,
      cachePrefixIntact: intact,
      historyCount: options.historyCount ?? 0,
      tokensAfter,
      durationMs: Date.now() - started,
    };
    options.onEvent?.({ type: "context_decision", ...record });
    options.onDecision?.(record);
    // 投影数组本身可变（我们构造的）或就是调用方传入的原数组（快速路径）——
    // readonly 只是让"不得修改输入"在类型上显式化。
    return projection as AgentMessage[];
  };

  async function compactOnce(
    messages: readonly AgentMessage[],
    blocks: ReturnType<typeof partitionMessages>,
    watermark: SummaryWatermark | undefined,
    ctx: {
      deep: boolean;
      budget: ContextBudget;
      keepConversationBlocks: number;
      toolOptions: ToolReducerOptions;
      persistedEnd: number;
      protectedRefs: ReadonlySet<object>;
      coeff: number;
      failureHint?: string;
      model: Model<Api>;
      models?: Models;
      summaryChat?: ChatFn;
      signal?: AbortSignal;
    },
  ): Promise<
    | {
        ok: true;
        projection: readonly AgentMessage[];
        watermark: SummaryWatermark;
        tokensAfter: number;
        summaryChars: number;
        cutIndex: number;
        attempts: number;
      }
    | { ok: false; error: string }
  > {
    const cutoff = summaryCutoffBlockIndex(blocks, { keepConversationBlocks: ctx.keepConversationBlocks });
    if (cutoff === null) return { ok: false, error: "no summarizable conversation blocks" };
    const boundary = coveredBoundaryIndex(messages, watermark?.coveredCount ?? 0);
    // 材料窗口 + 材料下限（加固期 P1-2）。切割点保护"最近 N 个对话块"，但一
    // 旦水位线越过切割点、或切割点前的材料本身极小，gate ③ / "material is
    // empty" 会在每次请求上永久失败——水位线推不动，估算单调上涨直到
    // provider 窗口报错。受保护偏好让位于功能：材料低于下限时，窗口向切割
    // 点之后扩展（绝不越过 resume 边界），让摘要器有真正可压缩的东西。
    const MIN_MATERIAL_TOKENS = 256;
    let materialEnd = Math.min(blocks[cutoff]!.start, ctx.persistedEnd);
    let material = messages.slice(boundary, materialEnd).filter((m) => m.role !== "system");
    let materialEstimate = estimateMessagesTokens(material, ctx.coeff);
    if (materialEstimate < MIN_MATERIAL_TOKENS) {
      for (let i = cutoff + 1; i < blocks.length; i++) {
        const b = blocks[i]!;
        if (b.kind === "system") continue;
        const end = Math.min(b.end, ctx.persistedEnd);
        if (end <= materialEnd) continue;
        materialEnd = end;
        material = messages.slice(boundary, materialEnd).filter((m) => m.role !== "system");
        materialEstimate = estimateMessagesTokens(material, ctx.coeff);
        if (materialEstimate >= MIN_MATERIAL_TOKENS) break;
      }
    }
    if (materialEnd <= boundary) return { ok: false, error: "material is empty (all covered or protected)" };
    if (material.length === 0) return { ok: false, error: "material is empty (system-only)" };
    const target = ctx.deep ? ctx.budget.targetTokens : ctx.budget.forcedTarget;
    const span = Math.max(materialEstimate - target, 0);

    let generated: RollingConversationSummary;
    let attempts: number;
    try {
      const result = await generateRollingSummary({
        material,
        previous: watermark?.summary,
        spanTokens: span,
        model: ctx.model,
        models: ctx.models,
        chat: ctx.summaryChat,
        failureHint: ctx.failureHint,
        signal: ctx.signal,
      });
      generated = result.summary;
      attempts = result.attempts;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof SummaryGenerationError ? err.message : err instanceof Error ? err.message : String(err),
      };
    }

    // 闸门③：摘要必须真的更小，否则视为失败。
    const rendered = renderSummaryText(generated);
    const summaryEstimate = estimateMessagesTokens(
      [{ role: "user", content: rendered, timestamp: Date.now() } as AgentMessage],
      ctx.coeff,
    );
    if (summaryEstimate >= materialEstimate) {
      return {
        ok: false,
        error: `summary (${summaryEstimate} tokens) is not smaller than material (${materialEstimate} tokens)`,
      };
    }

    const next = advanceWatermark(watermark, messages, material, generated);
    // 投影从原始历史 + 新水位线整体重建，再过一遍第一层（protectedRefs 按
    // 身份匹配，跨投影重建依然有效）。
    const rebuilt = replaceCoveredPrefix(messages, next);
    const reduced = reduceToolResults(rebuilt, ctx.coeff, ctx.toolOptions, { protectedRefs: ctx.protectedRefs });
    const tokensAfter = estimateContextTokens(reduced.messages, ctx.coeff).tokens;
    return {
      ok: true,
      projection: reduced.messages,
      watermark: next,
      tokensAfter,
      summaryChars: rendered.length,
      cutIndex: next.cutIndex,
      attempts,
    };
  }
}
