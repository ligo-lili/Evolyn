/**
 * 六条预算线——压缩决策的全部标尺。语义：
 *
 *   input_budget      = 模型窗口 − 输出预留 − 安全余量            （硬上界）
 *   working_input     = min(input_budget, 偏好预算，默认 64k)     ← 为了成本/缓存主动少用
 *   trigger_tokens    = 软线 (0.80 × working_input)   命中只"标记"要压缩
 *   compact_ceiling   = 强制线 (ceilingFactor × working_input，≤ input_budget)  越过必须压
 *   target_tokens     = 深压目标 (0.45 × working_input)  前缀断裂时的压缩目标
 *   forced_target     = 强制压缩后的回落目标（≈ 软线）
 *   tool_result_budget= target × 0.35   工具结果独立小账本（第一层Reducer用）
 *
 * 软线与强制线分离是整套设计的核心：越软线不立即压缩，先把 prompt cache
 * 吃干净；只有硬边界（预估超 input_budget / 越强制线 / 未摘要块超限）才强制压。
 */

export interface BudgetOptions {
  /** 偏好预算：为成本与缓存主动压低的工作集目标。默认 65536。 */
  preferenceTokens?: number;
  /** 安全余量：估算误差 + 消息信封开销的缓冲。默认 4096。 */
  safetyTokens?: number;
  /** 输出预留。默认 min(model.maxTokens, 窗口的 25%)。 */
  outputReserveTokens?: number;
  /** 软线比例。默认 0.80。 */
  triggerRatio?: number;
  /** 深压目标比例。默认 0.45。 */
  targetRatio?: number;
  /** 工具结果小账本比例（占深压目标）。默认 0.35。 */
  toolResultRatio?: number;
  /** 强制线相对 working_input 的倍数。默认 2。 */
  ceilingFactor?: number;
}

export interface ContextBudget {
  contextWindow: number;
  outputReserve: number;
  safetyTokens: number;
  preferenceTokens: number;
  /** 模型窗口 − 输出预留 − 安全余量。 */
  inputBudget: number;
  /** min(inputBudget, preferenceTokens)。 */
  workingInput: number;
  /** 软线：命中只标记，不立即压缩。 */
  triggerTokens: number;
  /** 强制线：越过必须压缩。 */
  compactCeiling: number;
  /** 深压目标：前缀断裂（缓存已丢）时一次压到位。 */
  targetTokens: number;
  /** 强制压缩的回落目标（≈ 软线）。 */
  forcedTarget: number;
  /** 工具结果独立小账本。 */
  toolResultBudget: number;
}

export const DEFAULT_BUDGET_OPTIONS: Required<BudgetOptions> = {
  preferenceTokens: 65_536,
  safetyTokens: 4_096,
  outputReserveTokens: Number.POSITIVE_INFINITY, // 实际取 min(maxTokens, 25% 窗口)
  triggerRatio: 0.8,
  targetRatio: 0.45,
  toolResultRatio: 0.35,
  ceilingFactor: 2,
};

export interface BudgetModelShape {
  contextWindow: number;
  maxTokens?: number;
}

/**
 * 由模型窗口推导六条预算线。小窗口（测试/微型模型）下各分量按窗口比例
 * 收缩，保证任何窗口都得到一组正的、有序的预算线。
 */
export function computeContextBudget(model: BudgetModelShape, options?: BudgetOptions): ContextBudget {
  const o = { ...DEFAULT_BUDGET_OPTIONS, ...options };
  const window = Math.max(1, Math.floor(model.contextWindow));
  const outputReserve = Math.min(
    o.outputReserveTokens,
    model.maxTokens ?? 8_192,
    Math.ceil(window * 0.25),
    Math.max(1, Math.floor(window * 0.4)), // 小窗口下输出预留不能吃掉一半以上
  );
  const safety = Math.min(o.safetyTokens, Math.max(1, Math.floor(window * 0.05)));
  const inputBudget = Math.max(1, window - outputReserve - safety);
  const preference = Math.max(1, Math.min(o.preferenceTokens, inputBudget));
  const workingInput = Math.max(1, Math.min(inputBudget, preference));
  const triggerTokens = Math.max(1, Math.floor(workingInput * o.triggerRatio));
  const compactCeiling = Math.max(triggerTokens + 1, Math.min(Math.floor(workingInput * o.ceilingFactor), inputBudget));
  const targetTokens = Math.max(1, Math.floor(workingInput * o.targetRatio));
  const forcedTarget = Math.max(targetTokens + 1, triggerTokens);
  const toolResultBudget = Math.max(1, Math.floor(targetTokens * o.toolResultRatio));
  return {
    contextWindow: window,
    outputReserve,
    safetyTokens: safety,
    preferenceTokens: preference,
    inputBudget,
    workingInput,
    triggerTokens,
    compactCeiling,
    targetTokens,
    forcedTarget,
    toolResultBudget,
  };
}
