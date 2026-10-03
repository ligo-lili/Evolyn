import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn, TranscriptContext } from "@earendil-works/pi-agent-core";
import { assembleSystemPrompt, renderExperienceBlock, renderSkillBlock } from "../src/context/assembler.js";
import { partitionMessages, blockStats } from "../src/context/blocks.js";
import { computeContextBudget } from "../src/context/budget.js";
import {
  tokenCoefficient,
  estimateContextTokens,
  estimateMessagesTokens,
  TOKEN_COEFFICIENTS,
} from "../src/context/tokens.js";
import { reduceToolResults, jsonArraySemanticTrim } from "../src/context/reducers/tool.js";
import {
  summaryCutoffBlockIndex,
  countUnsummarizedConversationBlocks,
  coveredBoundaryIndex,
  replaceCoveredPrefix,
  advanceWatermark,
} from "../src/context/reducers/conversation.js";
import {
  validateSummary,
  summaryCaps,
  renderSummaryText,
  SummaryGenerationError,
  generateRollingSummary,
  BIG_FOLD_SPAN_TOKENS,
  type RollingConversationSummary,
} from "../src/context/summarizer.js";
import { createContextTransformer } from "../src/context/compaction.js";
import { readTraceFile } from "../src/trace/read.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { FAKE_MODEL, makeTempCwd } from "./helpers.js";

const tmp = makeTempCwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

// ---------- helpers ----------

const m = (role: string, content: unknown, extra: Record<string, unknown> = {}): AgentMessage =>
  ({ role, content, timestamp: 1, ...extra }) as never as AgentMessage;

const toolResultMsg = (id: string, text: string, toolName = "exec"): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  }) as never as AgentMessage;

const toolCallAssistant = (ids: string[], text = ""): AgentMessage =>
  m("assistant", [
    ...(text ? [{ type: "text", text }] : []),
    ...ids.map((id) => ({ type: "toolCall", id, name: "exec", arguments: {} })),
  ]);

const validSummary = (
  objective = "write two files",
  completed: string[] = ["wrote a.txt"],
): RollingConversationSummary => ({
  current_objective: objective,
  user_constraints: [],
  key_decisions: [],
  completed_work: completed,
  current_state: [],
  pending_work: [],
  important_facts: [],
});

const summaryChat = (summary: RollingConversationSummary | string) => async (): Promise<string> =>
  typeof summary === "string" ? summary : JSON.stringify(summary);

// ---------- 阶段 8: assembler ----------

describe("context assembler (阶段 8)", () => {
  it("assembles deterministically: base → skills → experiences, byte-identical for equal inputs", () => {
    const sections = {
      base: "BASE",
      skills: renderSkillBlock([
        { name: "demo-skill", description: "does demo things", location: "/skills/demo/SKILL.md" },
      ]),
      experiences: renderExperienceBlock([
        {
          id: "M001",
          title: "read before write",
          revision: 2,
          summary: "先读后写",
          snippet: "always read the file before editing",
          path: ".harness/memory/active/M001.md",
        },
      ]),
    };
    expect(assembleSystemPrompt(sections)).toBe(assembleSystemPrompt({ ...sections }));
    expect(assembleSystemPrompt(sections)).toContain("BASE");
    expect(assembleSystemPrompt(sections).indexOf("BASE")).toBeLessThan(
      assembleSystemPrompt(sections).indexOf("<available_skills>"),
    );
    expect(assembleSystemPrompt(sections).indexOf("<available_skills>")).toBeLessThan(
      assembleSystemPrompt(sections).indexOf("<relevant_experience>"),
    );
  });

  it("renders empty blocks as empty strings and falls back to the default base", () => {
    expect(renderSkillBlock([])).toBe("");
    expect(renderExperienceBlock([])).toBe("");
    expect(assembleSystemPrompt()).toBe(assembleSystemPrompt({}));
  });
});

// ---------- 块模型 ----------

describe("context blocks (块模型)", () => {
  it("partitions a well-formed transcript: system / conversation / toolRound, exact pairing", () => {
    const messages = [
      m("system", "sys"),
      m("user", "do it"),
      toolCallAssistant(["c1"]),
      toolResultMsg("c1", "ok"),
      m("assistant", [{ type: "text", text: "done" }]),
    ];
    const blocks = partitionMessages(messages);
    expect(blocks.map((b) => b.kind)).toEqual(["system", "conversation", "toolRound", "conversation"]);
    expect(blocks[2]).toMatchObject({ start: 2, end: 4 });
    expect((blocks[2] as { toolCallIds: string[] }).toolCallIds).toEqual(["c1"]);
    // user + 紧随的纯文本 assistant 回复 = 一轮普通对话
    expect(blocks[3]!.start).toBe(4);
  });

  it("degrades duplicate / missing / orphan tool results to MalformedToolBlock (conservative keep)", () => {
    // 重复结果：同一 id 两次 → Counter 不配对 → 整块降级
    const dup = [m("user", "go"), toolCallAssistant(["c1"]), toolResultMsg("c1", "a"), toolResultMsg("c1", "b")];
    const dupBlocks = partitionMessages(dup);
    expect(dupBlocks.map((b) => b.kind)).toEqual(["conversation", "malformed"]);
    expect(dupBlocks[1]!.end - dupBlocks[1]!.start).toBe(3); // 整块保守保留

    // 缺失结果：两个调用只有一个结果
    const missing = [m("user", "go"), toolCallAssistant(["c1", "c2"]), toolResultMsg("c1", "a")];
    expect(partitionMessages(missing).map((b) => b.kind)).toEqual(["conversation", "malformed"]);

    // 孤立结果：前面没有配对的 assistant
    const orphan = [m("user", "go"), toolResultMsg("cX", "a")];
    expect(partitionMessages(orphan).map((b) => b.kind)).toEqual(["conversation", "malformed"]);
    expect((partitionMessages(orphan)[1] as { reason: string }).reason).toContain("orphan");
  });

  it("counts blocks for the decision record (extra result poisons the whole round)", () => {
    const messages = [
      m("system", "sys"),
      m("user", "go"),
      toolCallAssistant(["c1"]),
      toolResultMsg("c1", "ok"),
      toolResultMsg("c1", "duplicate"), // 重复结果 → Counter 不配对 → 整轮降级
    ];
    expect(blockStats(partitionMessages(messages))).toEqual({
      system: 1,
      conversation: 1,
      toolRound: 0,
      malformed: 1,
      total: 3,
    });
  });
});

// ---------- Token 估算与校准 ----------

describe("context tokens (校准估算)", () => {
  it("selects the model-family coefficient (provider first, then model id)", () => {
    expect(tokenCoefficient("qwen", "qwen-max")).toBe(TOKEN_COEFFICIENTS.qwen);
    expect(tokenCoefficient("deepseek", "deepseek-chat")).toBe(TOKEN_COEFFICIENTS.deepseek);
    expect(tokenCoefficient("openrouter", "deepseek/deepseek-r1")).toBe(TOKEN_COEFFICIENTS.deepseek);
    expect(tokenCoefficient("anthropic", "claude-sonnet-4")).toBe(TOKEN_COEFFICIENTS.anthropic);
    expect(tokenCoefficient("openai", "gpt-5")).toBe(TOKEN_COEFFICIENTS.openai);
    expect(tokenCoefficient("test", "fake-model")).toBe(1.3); // 未知族保守默认
  });

  it("calibrated estimate exceeds the chars/4 base for high-coefficient families", () => {
    const messages = [m("user", "这是一段比较长的中文内容，用来检验分词系数。".repeat(10))];
    const base = estimateMessagesTokens(messages, 1);
    expect(estimateMessagesTokens(messages, TOKEN_COEFFICIENTS.deepseek)).toBeGreaterThan(base);
  });

  it("blends the last assistant Usage (measured) with a calibrated trailing estimate", () => {
    const big = "z".repeat(800);
    const messages = [
      m("user", "task"),
      {
        role: "assistant",
        content: [{ type: "text", text: "mid" }],
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      } as never as AgentMessage,
      m("user", big),
    ];
    const est = estimateContextTokens(messages, 1);
    expect(est.usageTokens).toBe(120);
    expect(est.lastUsageIndex).toBe(1);
    expect(est.trailingTokens).toBe(Math.ceil(800 / 4));
    expect(est.tokens).toBe(120 + 200); // 实测 + 尾部估算，不取平均
  });
});

// ---------- 六条预算线 ----------

describe("context budget (六条预算线)", () => {
  it("derives the six lines for a large model window", () => {
    const b = computeContextBudget({ contextWindow: 131_072, maxTokens: 8_192 });
    expect(b.inputBudget).toBe(131_072 - 8_192 - 4_096);
    expect(b.workingInput).toBe(65_536); // 64k 偏好预算主动少用
    expect(b.triggerTokens).toBe(Math.floor(65_536 * 0.8)); // 软线
    expect(b.compactCeiling).toBe(b.inputBudget); // min(2×64k, inputBudget)
    expect(b.targetTokens).toBe(Math.floor(65_536 * 0.45)); // 深压目标
    expect(b.forcedTarget).toBe(b.triggerTokens); // 回落目标 ≈ 软线
    expect(b.toolResultBudget).toBe(Math.floor(b.targetTokens * 0.35)); // 独立小账本
  });

  it("keeps every line positive and ordered even for a tiny test window", () => {
    const b = computeContextBudget({ contextWindow: 300, maxTokens: 8_192 });
    expect(b.inputBudget).toBeGreaterThan(0);
    expect(b.toolResultBudget).toBeLessThan(b.targetTokens);
    expect(b.targetTokens).toBeLessThan(b.forcedTarget);
    expect(b.forcedTarget).toBe(b.triggerTokens);
    expect(b.triggerTokens).toBeLessThan(b.compactCeiling);
    expect(b.compactCeiling).toBeLessThanOrEqual(b.inputBudget);
  });
});

// ---------- 第一层：工具结果整理 ----------

describe("context tool reducer (第一层)", () => {
  const big = (chars: number) => "x".repeat(chars);

  it("is a no-op (same reference) when old tool results fit the ledger", () => {
    const messages = [
      m("system", "sys"),
      m("user", "turn1"),
      toolCallAssistant(["c1"]),
      toolResultMsg("c1", big(100)),
      m("user", "turn2"),
      toolCallAssistant(["c2"]),
      toolResultMsg("c2", big(100)),
    ];
    const out = reduceToolResults(messages, 1, { budgetTokens: 10_000 }, { protectedRefs: new Set() });
    expect(out.messages).toBe(messages);
    expect(out.triggered).toBe(false);
  });

  it("truncates old results head+tail with a marker preserving tool and tool_call_id", () => {
    const messages = [
      m("system", "sys"),
      m("user", "turn1"),
      toolCallAssistant(["c1"]),
      toolResultMsg("c1", "HEAD" + big(4000) + "TAIL"),
      m("user", "turn2"),
      toolCallAssistant(["c2"]),
      toolResultMsg("c2", "recent"),
    ];
    // keepRecentRounds: 1 → c1 是唯一可压缩轮；c2 是当前回合，豁免
    // 账本取"截短后可满足"的量 → 只截短不删除
    const out = reduceToolResults(
      messages,
      1,
      { budgetTokens: 100, headChars: 100, tailChars: 50, keepRecentRounds: 1 },
      { protectedRefs: new Set() },
    );
    expect(out.triggered).toBe(true);
    expect(out.trimmedRounds).toBe(1);
    expect(out.removedRounds).toBe(0);
    const text = JSON.stringify(out.messages[3]);
    expect(text).toContain("HEAD");
    expect(text).toContain("TAIL");
    expect(text).toContain("tool=exec");
    expect(text).toContain("tool_call_id=c1");
    expect(text).toContain("original_chars=4008");
    expect(text).toContain("omitted 3858 characters");
    expect(JSON.stringify(out.messages[6])).toContain("recent"); // 当前回合不动
  });

  it("protects the recent 2 rounds and the current turn, only touching the compactable prefix", () => {
    const messages = [
      m("system", "sys"),
      m("user", "turn1"),
      toolCallAssistant(["old1"]),
      toolResultMsg("old1", big(2000)),
      m("user", "turn2"),
      toolCallAssistant(["old2"]),
      toolResultMsg("old2", big(2000)),
      toolCallAssistant(["recent1"]),
      toolResultMsg("recent1", big(2000)),
      toolCallAssistant(["recent2"]),
      toolResultMsg("recent2", big(2000)),
      m("user", "turn3"),
      toolCallAssistant(["current"]),
      toolResultMsg("current", big(2000)),
    ];
    // 账本=截短后的总量可以满足 → 只截短不删除
    const out = reduceToolResults(
      messages,
      1,
      { budgetTokens: 250, headChars: 10, tailChars: 5 },
      { protectedRefs: new Set() },
    );
    const text = JSON.stringify(out.messages);
    // 全局最近 2 轮（recent2、current）+ 当前回合绝不截短；更老的轮次截短
    expect(text).toContain(big(2000));
    expect(text).toContain("tool_call_id=old1"); // 最旧轮被截短且 id 保留
    expect(text).toContain("tool_call_id=recent1"); // 第 3 新的轮也已老化，可截短
    expect(text).toContain("original_chars=");
    expect(text).not.toContain("tool_call_id=recent2");
    expect(text).not.toContain("tool_call_id=current");
  });

  it("removes whole rounds oldest-first (assistant AND results together), re-measuring each step", () => {
    const messages = [
      m("system", "sys"),
      m("user", "turn1"),
      toolCallAssistant(["r1"]),
      toolResultMsg("r1", big(3000)),
      m("user", "turn2"),
      toolCallAssistant(["r2"]),
      toolResultMsg("r2", big(3000)),
      m("user", "turn3"),
      toolCallAssistant(["r3"]),
      toolResultMsg("r3", big(3000)),
      m("user", "turn4"),
      toolCallAssistant(["r4"]),
      toolResultMsg("r4", big(3000)),
    ];
    // headChars 极小也塞不进账本 → 截短后仍超 → 整轮移除，够就停
    const out = reduceToolResults(
      messages,
      1,
      { budgetTokens: 50, headChars: 5, tailChars: 2 },
      { protectedRefs: new Set() },
    );
    expect(out.removedRounds).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(out.messages);
    expect(text).not.toContain('"c1"'); // 最旧的整轮消失（assistant 与结果一起）
    expect(text).toContain("r4"); // 受保护的最近轮还在
  });

  it("never touches rounds at or after the resume boundary (protected refs)", () => {
    const messages = [
      m("system", "sys"),
      m("user", "recovered task"),
      toolCallAssistant(["recovered1"]),
      toolResultMsg("recovered1", big(3000)),
      m("user", "recovered turn 2"),
      toolCallAssistant(["recovered2"]),
      toolResultMsg("recovered2", big(3000)),
      m("user", "fresh turn"),
      toolCallAssistant(["fresh"]),
      toolResultMsg("fresh", big(3000)),
    ];
    // 恢复转录 8 条 = 持久化前缀；其后的 fresh 轮属于当前 Run（按对象引用保护）。
    // 账本取"截短后可满足"的量 → 只截短不删除。
    const out = reduceToolResults(
      messages,
      1,
      { budgetTokens: 100, headChars: 10, tailChars: 5 },
      { protectedRefs: new Set(messages.slice(8) as object[]) },
    );
    const text = JSON.stringify(out.messages);
    expect(text).toContain("tool_call_id=recovered1"); // 持久化前缀里的旧轮被截短
    expect(JSON.stringify(out.messages[9])).toContain(big(3000)); // 当前 Run 新增的轮完整
    expect(text).not.toContain("tool_call_id=recovered2"); // 最近 2 轮全局保护也覆盖它
  });

  it("applies the registered semantic trimmer (valid JSON output) instead of head+tail", () => {
    const payload = JSON.stringify({
      window: "ws",
      goal: "inspect",
      elements: Array.from({ length: 50 }, (_, i) => ({ i, label: `el-${i}`, detail: "y".repeat(40) })),
    });
    const messages = [
      m("system", "sys"),
      m("user", "turn1"),
      toolCallAssistant(["obs"]),
      toolResultMsg("obs", payload, "computer_observe"),
      m("user", "turn2"),
      toolCallAssistant(["x"]),
      toolResultMsg("x", big(50)),
    ];
    const out = reduceToolResults(
      messages,
      1,
      {
        budgetTokens: 100,
        headChars: 200,
        tailChars: 20,
        keepRecentRounds: 1,
        semanticTrimmers: { computer_observe: jsonArraySemanticTrim },
      },
      { protectedRefs: new Set() },
    );
    expect(out.triggered).toBe(true);
    const trimmed = JSON.parse(JSON.stringify(out.messages[3]));
    const resultText = trimmed.content.find((c: { type: string }) => c.type === "text").text as string;
    const parsed = JSON.parse(resultText); // 始终合法 JSON
    expect(parsed.window).toBe("ws");
    expect(parsed.goal).toBe("inspect");
    expect(parsed.truncated).toBe(true);
    expect(parsed.elements.length).toBeGreaterThan(0);
    expect(parsed.elements.length).toBeLessThan(50);
    expect(resultText.length).toBeLessThanOrEqual(240);
  });
});

// ---------- 第二层：切割点 / 水位线 / 前缀替换 ----------

describe("context conversation reducer (第二层)", () => {
  it("protects the last 4 conversation blocks; tool rounds after the cutoff follow the fix", () => {
    // user / round 交错 → 5 个独立对话块。cutoff = 倒数第 4 个对话块的起点；
    // 末尾两个工具轮不需要"最近 N 轮"保护位——它们天然落在最后一个可摘要
    // 对话块之后（修复点：工具轮不会永久占住保护位、顶不动水位线）。
    const blocks = partitionMessages([
      m("user", "conv1"),
      toolCallAssistant(["t1"]),
      toolResultMsg("t1", "r"),
      m("user", "conv2"),
      toolCallAssistant(["u2"]),
      toolResultMsg("u2", "r"),
      m("user", "conv3"),
      toolCallAssistant(["u3"]),
      toolResultMsg("u3", "r"),
      m("user", "conv4"),
      toolCallAssistant(["u4"]),
      toolResultMsg("u4", "r"),
      m("user", "conv5"),
      toolCallAssistant(["t2"]),
      toolResultMsg("t2", "r"),
      toolCallAssistant(["t3"]),
      toolResultMsg("t3", "r"),
    ]);
    const cutoff = summaryCutoffBlockIndex(blocks, { keepConversationBlocks: 4 });
    expect(cutoff).toBe(2); // conv2 的块下标：材料 = conv1 + t1 老工具轮
    expect(blocks[cutoff]!.start).toBe(3);
    // 末尾工具轮（t2/t3，块 9、10）连同最近 4 个对话块一起被保护
    expect(blocks.slice(cutoff).every((b) => b.kind === "conversation" || b.kind === "toolRound")).toBe(true);
  });

  it("falls back to tool-round protection when conversation blocks are scarce (coding runs)", () => {
    const blocks = partitionMessages([
      m("user", "task"),
      toolCallAssistant(["r1"]),
      toolResultMsg("r1", "r"),
      toolCallAssistant(["r2"]),
      toolResultMsg("r2", "r"),
      toolCallAssistant(["r3"]),
      toolResultMsg("r3", "r"),
      toolCallAssistant(["r4"]),
      toolResultMsg("r4", "r"),
    ]);
    const cutoff = summaryCutoffBlockIndex(blocks);
    expect(cutoff).toBe(3); // 工具轮块下标 1..4，保护最近 2 轮（r3、r4）→ 材料含 r1、r2
    expect(blocks[cutoff]!.start).toBe(5);
  });

  it("returns null when there is nothing to summarize", () => {
    const few = partitionMessages([m("user", "a"), toolCallAssistant(["c"]), toolResultMsg("c", "r")]);
    expect(summaryCutoffBlockIndex(few)).toBeNull();
  });

  it("advanceWatermark + replaceCoveredPrefix: summary after system, precise removal, system exempt", () => {
    const messages: AgentMessage[] = [
      m("system", "sys"),
      m("user", "task"),
      toolCallAssistant(["c1"]),
      toolResultMsg("c1", "r1"),
      m("user", "fresh"),
    ];
    const material = messages.slice(1, 4);
    const watermark = advanceWatermark(undefined, messages, material, validSummary());
    expect(watermark.coveredCount).toBe(3);
    const projection = replaceCoveredPrefix(messages, watermark);
    expect(projection.length).toBe(3); // system + summary + fresh
    expect(projection[0]!.role).toBe("system");
    expect(projection[1]!.role).toBe("user");
    expect(JSON.stringify(projection[1])).toContain("<context-summary>");
    expect(JSON.stringify(projection[1])).toContain("write two files");
    expect(JSON.stringify(projection[2])).toContain("fresh");
    // 同一摘要消息对象在多次投影间复用（字节稳定 → prompt cache 友好）
    expect(replaceCoveredPrefix(messages, watermark)[1]).toBe(projection[1]);
  });

  it("removes covered tool protocol by tool_call_id even when object identity was rebuilt (resume)", () => {
    const messages: AgentMessage[] = [
      m("system", "sys"),
      m("user", "task"),
      toolCallAssistant(["c1"]),
      toolResultMsg("c1", "r1"),
      m("user", "fresh"),
    ];
    const watermark = advanceWatermark(undefined, messages, messages.slice(1, 4), validSummary());
    // resume 重建了对象——身份引用失效，但 tool_call_id 精确移除仍然生效
    const rebuilt = messages.map((x) => ({ ...x }) as AgentMessage);
    const projection = replaceCoveredPrefix(rebuilt, watermark);
    expect(projection.length).toBe(3);
    expect(JSON.stringify(projection)).not.toContain("r1");
    expect(JSON.stringify(projection)).not.toContain('"c1"');
    // 位置水位线兜底：coveredCount 之内的消息按位置移除
    expect(
      countUnsummarizedConversationBlocks(
        partitionMessages(rebuilt),
        coveredBoundaryIndex(rebuilt, watermark.coveredCount),
      ),
    ).toBe(1);
  });
});

// ---------- 摘要生成器：双保险与三道闸 ----------

describe("context summarizer (严格 JSON 滚动摘要)", () => {
  it("hard-validates caps: 8 items / 1200 chars, non-empty objective", () => {
    const caps = summaryCaps(0);
    expect(caps).toEqual({ maxItems: 8, maxChars: 1200, objectiveChars: 400 });
    expect(() =>
      validateSummary({ ...validSummary(), completed_work: Array.from({ length: 9 }, (_, i) => `s${i}`) }, caps),
    ).toThrow(SummaryGenerationError);
    expect(() => validateSummary({ ...validSummary(), important_facts: ["x".repeat(1201)] }, caps)).toThrow(
      SummaryGenerationError,
    );
    expect(() => validateSummary({ ...validSummary(), current_objective: "" }, caps)).toThrow(SummaryGenerationError);
    expect(() => validateSummary({ ...validSummary(), pending_work: "not an array" }, caps)).toThrow(
      SummaryGenerationError,
    );
    expect(validateSummary(validSummary(), caps).current_objective).toBe("write two files");
  });

  it("relaxes the output caps for big folds (>50k span) instead of cramming", () => {
    expect(summaryCaps(BIG_FOLD_SPAN_TOKENS + 1)).toEqual({ maxItems: 12, maxChars: 2400, objectiveChars: 600 });
    const bigFold = validateSummary(
      { ...validSummary(), completed_work: Array.from({ length: 10 }, (_, i) => `s${i}`) },
      summaryCaps(BIG_FOLD_SPAN_TOKENS * 2),
    );
    expect(bigFold.completed_work).toHaveLength(10);
  });

  it("renders all six fields plus the objective into the summary block", () => {
    const text = renderSummaryText(validSummary());
    expect(text).toContain("<context-summary>");
    expect(text).toContain("current_objective: write two files");
    expect(text).toContain("completed_work:");
    expect(text).toContain("Continue the task from here.");
  });

  it("retries once with the validation error (retry_compact) and then succeeds", async () => {
    const calls: string[] = [];
    const chat = async (messages: readonly { role: string; content: string }[]): Promise<string> => {
      calls.push(messages.at(-1)!.content);
      return calls.length === 1 ? "I cannot do that" : JSON.stringify(validSummary());
    };
    const { summary, attempts } = await generateRollingSummary({
      material: [m("user", "material")],
      spanTokens: 100,
      model: FAKE_MODEL,
      chat,
    });
    expect(attempts).toBe(2);
    expect(summary.current_objective).toBe("write two files");
    expect(calls[1]).toContain("failed validation");
  });

  it("throws SummaryGenerationError after the single retry is exhausted", async () => {
    const chat = async (): Promise<string> => "garbage";
    await expect(
      generateRollingSummary({ material: [m("user", "material")], spanTokens: 100, model: FAKE_MODEL, chat }),
    ).rejects.toThrow(SummaryGenerationError);
  });

  it("folds the previous summary and any failure hint into the prompt", async () => {
    let prompt = "";
    const chat = async (messages: readonly { role: string; content: string }[]): Promise<string> => {
      prompt = messages[0]!.content;
      return JSON.stringify(validSummary());
    };
    await generateRollingSummary({
      material: [m("user", "new material")],
      previous: validSummary("old objective"),
      spanTokens: 100,
      failureHint: "completed_work exceeded 8 items",
      model: FAKE_MODEL,
      chat,
    });
    expect(prompt).toContain("<previous_summary>");
    expect(prompt).toContain("old objective");
    expect(prompt).toContain("failed validation: completed_work exceeded 8 items");
    expect(prompt).toContain("new material");
  });
});

// ---------- 编排器：prefix_decision 状态机 ----------

describe("context transformer (prefix decisions)", () => {
  const WINDOW = 300; // trigger≈168 / ceiling=210 / target≈94 / toolBudget≈32
  const round = (id: string, chars: number): AgentMessage[] => [
    toolCallAssistant([id]),
    toolResultMsg(id, "x".repeat(chars)),
  ];

  it("reuses below the soft line (same reference, no summary call)", async () => {
    const decisions: { decision: string; summarized?: boolean }[] = [];
    const transformer = createContextTransformer({
      model: { ...FAKE_MODEL, contextWindow: WINDOW },
      summaryChat: summaryChat(validSummary()),
      onDecision: (d) => decisions.push(d),
    });
    const messages = [m("system", "sys"), m("user", "tiny")];
    await expect(transformer(messages)).resolves.toBe(messages);
    expect(decisions.map((d) => d.decision)).toEqual(["reuse"]);
  });

  it("defers over the soft line but under the forced line — keeps appending, cache intact", async () => {
    const decisions: { decision: string; reason: string }[] = [];
    let summaries = 0;
    const transformer = createContextTransformer({
      model: { ...FAKE_MODEL, contextWindow: WINDOW },
      summaryChat: async () => {
        summaries++;
        return JSON.stringify(validSummary());
      },
      onDecision: (d) => decisions.push({ decision: d.decision, reason: d.reason }),
    });
    // ~600 chars result → estimate ≈ 202 ∈ (168, 210]
    const messages = [
      m("system", "sys"),
      m("user", "t"),
      toolCallAssistant(["c1"]),
      toolResultMsg("c1", "x".repeat(600)),
    ];
    const projection = await transformer(messages);
    expect(decisions[0]!.decision).toBe("defer");
    expect(summaries).toBe(0);
    expect(projection).toBe(messages); // 未压缩，纯续用（同一引用）
  });

  it("compacts over the forced line, then rolls; covered messages leave the projection", async () => {
    const events: { type: string; trigger?: string }[] = [];
    const decisions: { decision: string; summarized: boolean }[] = [];
    const prompts: string[] = [];
    const transformer = createContextTransformer({
      model: { ...FAKE_MODEL, contextWindow: WINDOW },
      summaryChat: async (turns) => {
        prompts.push(turns[0]!.content);
        return JSON.stringify(validSummary());
      },
      onEvent: (e) => events.push(e as { type: string; trigger?: string }),
      onDecision: (d) => decisions.push({ decision: d.decision, summarized: d.summarized }),
    });
    const base: AgentMessage[] = [
      m("system", "sys"),
      m("user", "please write files"),
      ...round("r1", 2000),
      ...round("r2", 2000),
    ];
    // 首个请求缓存本就是空的 → 深压（rebuild 语义），一次性压到 target
    const input1 = [...base, ...round("r3", 2000)];
    const out1 = await transformer(input1);
    expect(decisions[0]).toMatchObject({ decision: "rebuild", summarized: true });
    const summary1 = out1.find((x) => JSON.stringify(x).includes("<context-summary>"));
    expect(summary1).toBeDefined();
    expect(JSON.stringify(out1)).not.toContain("please write files"); // 被覆盖的前缀离开投影
    expect(JSON.stringify(out1)).toContain("r3"); // 受保护的最近轮次保留

    // 尾部长回强制线（真 append）→ 滚动折叠上一次摘要
    const out2 = await transformer([...input1, ...round("r4", 2000)]);
    expect(decisions[1]).toMatchObject({ decision: "compact", summarized: true });
    expect(prompts[1]).toContain("<previous_summary>"); // 折叠旧摘要
    expect(prompts[1]).toContain("r2"); // 材料是水位线之后的增量
    expect(prompts[1]).not.toContain("please write files");
    expect(JSON.stringify(out2).split("<context-summary>").length - 1).toBe(1); // 只有一份摘要
    expect(events.filter((e) => e.type === "compaction").map((e) => e.trigger)).toEqual(["threshold", "rolling"]);
  });

  it("gate ①: summary failure returns the projection unchanged and never touches originals", async () => {
    const decisions: { decision: string; summarized: boolean; reason: string }[] = [];
    const transformer = createContextTransformer({
      model: { ...FAKE_MODEL, contextWindow: WINDOW },
      summaryChat: summaryChat("still not json"),
      onDecision: (d) => decisions.push({ decision: d.decision, summarized: d.summarized, reason: d.reason }),
    });
    const messages: AgentMessage[] = [
      m("system", "sys"),
      m("user", "task"),
      ...round("r1", 2000),
      ...round("r2", 2000),
      ...round("r3", 2000),
    ];
    const out = await transformer(messages);
    expect(decisions[0]!.summarized).toBe(false);
    expect(decisions[0]!.reason).toContain("summarization failed");
    expect(out.length).toBe(messages.length); // 原样返回
  });

  it("gate ③: a summary that is not smaller than the material is rejected", async () => {
    const decisions: { summarized: boolean; reason: string }[] = [];
    const transformer = createContextTransformer({
      model: { ...FAKE_MODEL, contextWindow: WINDOW },
      // 巨型摘要（仍在硬校验上限内）：比材料还大 → 视为失败
      summaryChat: summaryChat(
        validSummary(
          "objective",
          Array.from({ length: 8 }, (_, i) => `fact ${i} ${"z".repeat(500)}`),
        ),
      ),
      onDecision: (d) => decisions.push({ summarized: d.summarized, reason: d.reason }),
    });
    const messages: AgentMessage[] = [
      m("system", "sys"),
      m("user", "short"),
      ...round("r1", 2000),
      ...round("r2", 2000),
      ...round("r3", 2000),
    ];
    await transformer(messages);
    expect(decisions[0]!.summarized).toBe(false);
    expect(decisions[0]!.reason).toContain("not smaller than material");
  });

  it("rebuilds with a deep target when the cached prefix is broken (non-append transcript)", async () => {
    const decisions: { decision: string; cachePrefixIntact: boolean }[] = [];
    const transformer = createContextTransformer({
      model: { ...FAKE_MODEL, contextWindow: WINDOW },
      summaryChat: summaryChat(validSummary()),
      onDecision: (d) => decisions.push({ decision: d.decision, cachePrefixIntact: d.cachePrefixIntact }),
    });
    const messages: AgentMessage[] = [
      m("system", "sys"),
      m("user", "task"),
      ...round("r1", 2000),
      ...round("r2", 2000),
      ...round("r3", 2000),
    ];
    await transformer(messages);
    // 转录被外部改写（非 append-only）→ 前缀断裂
    const mutated = [...messages];
    mutated.splice(2, 1); // 删掉一轮
    const out = await transformer(mutated);
    expect(decisions[1]).toMatchObject({ decision: "rebuild", cachePrefixIntact: false });
    expect(JSON.stringify(out)).toContain("<context-summary>");
  });

  it("resume boundary: current-segment messages are never truncated nor summarized (both layers)", async () => {
    const prompts: string[] = [];
    const transformer = createContextTransformer({
      model: { ...FAKE_MODEL, contextWindow: WINDOW },
      summaryChat: async (turns) => {
        prompts.push(turns[0]!.content);
        return JSON.stringify(validSummary());
      },
      // 恢复转录 7 条 = 持久化前缀（sys、user1、roundA、user2、roundB）；
      // user3、roundC 及之后属于当前 Run 段。
      historyCount: 7,
    });
    const bigA = "a".repeat(2000);
    const bigB = "b".repeat(2000);
    const bigC = "c".repeat(3000);
    const bigD = "d".repeat(2000);
    const raw: AgentMessage[] = [
      m("system", "sys"),
      m("user", "task 1"),
      toolCallAssistant(["rA"]),
      toolResultMsg("rA", bigA),
      m("user", "task 2"),
      toolCallAssistant(["rB"]),
      toolResultMsg("rB", bigB),
      m("user", "turn 3"),
      toolCallAssistant(["rC"]),
      toolResultMsg("rC", bigC),
    ];
    const out1 = await transformer([...raw]);
    expect(JSON.stringify(out1)).toContain("<context-summary>");
    expect(JSON.stringify(out1)).toContain("turn 3"); // 当前段消息进入投影
    expect(JSON.stringify(out1)).toContain(bigC); // 且完整未截短

    // 当前段继续生长：roundD 老化出"当前回合"，roundC 老化出"最近 2 轮"——
    // 两者都越过了它们的投影下标与 historyCount 的比较线，只能靠引用保护。
    const msgs2 = [
      ...raw,
      toolCallAssistant(["rD"]),
      toolResultMsg("rD", bigD),
      m("user", "turn 4"),
      ...round("rE", 2000),
    ];
    const out2 = await transformer(msgs2);
    expect(JSON.stringify(out2)).toContain("<context-summary>");
    // 当前段：user3/roundC 不被摘要覆盖（材料在持久化边界处截断，只含 roundB——
    // task 2 已随请求 1 的摘要离开水位线）……
    expect(prompts[1]).not.toContain("turn 3");
    expect(prompts[1]).not.toContain(bigC);
    expect(prompts[1]).toContain('"rB"');
    // ……也不被第一层截短（下标位移后引用保护仍然命中）
    expect(JSON.stringify(out2)).toContain("turn 3");
    expect(JSON.stringify(out2)).toContain(bigC);
    expect(JSON.stringify(out2)).toContain(bigD);
    // 持久化前缀里已覆盖的消息离开投影
    expect(JSON.stringify(out2)).not.toContain("task 2");
  });

  it("aborted signal: returns the original messages as the safe fallback, no summary call", async () => {
    const decisions: { decision: string }[] = [];
    let summaries = 0;
    const transformer = createContextTransformer({
      model: { ...FAKE_MODEL, contextWindow: WINDOW },
      summaryChat: async () => {
        summaries++;
        return JSON.stringify(validSummary());
      },
      onDecision: (d) => decisions.push({ decision: d.decision }),
    });
    // 远超强制线——若未 abort 本应触发压缩
    const messages: AgentMessage[] = [
      m("system", "sys"),
      m("user", "task"),
      ...round("r1", 2000),
      ...round("r2", 2000),
      ...round("r3", 2000),
    ];
    const controller = new AbortController();
    controller.abort();
    await expect(transformer(messages, controller.signal)).resolves.toBe(messages);
    expect(summaries).toBe(0);
    expect(decisions).toEqual([]); // 钩子短路：不产决策、不调摘要、不动消息
  });

  it("mid-flight: the run's abort signal is forwarded to the summary chat", async () => {
    let received: AbortSignal | undefined;
    const transformer = createContextTransformer({
      model: { ...FAKE_MODEL, contextWindow: WINDOW },
      summaryChat: async (_turns, opts) => {
        received = opts?.signal;
        return JSON.stringify(validSummary());
      },
    });
    const messages: AgentMessage[] = [
      m("system", "sys"),
      m("user", "task"),
      ...round("r1", 2000),
      ...round("r2", 2000),
      ...round("r3", 2000),
    ];
    const controller = new AbortController();
    const out = await transformer(messages, controller.signal);
    // 信号一路透传到摘要调用（defaultChat 会把它交给 completeSimple 中断请求）
    expect(received).toBe(controller.signal);
    expect(JSON.stringify(out)).toContain("<context-summary>");
  });
});

// ---------- RunManager 集成：Trace 里的 compaction / context_decision ----------

describe("context management via RunManager (阶段 8 integration)", () => {
  it("compacts when over the forced line and records decisions + compactions in the trace", async () => {
    tmp.enter();
    const compactModel = { ...FAKE_MODEL, contextWindow: 300 };
    const big = "x".repeat(600);
    const steps: AssistantMessage[] = [
      assistantMsg([{ type: "toolCall", id: "c1", name: "write_file", arguments: { path: "a.txt", content: big } }]),
      assistantMsg([{ type: "toolCall", id: "c2", name: "write_file", arguments: { path: "b.txt", content: big } }]),
      assistantMsg([{ type: "toolCall", id: "c3", name: "write_file", arguments: { path: "c.txt", content: big } }]),
      assistantMsg([{ type: "toolCall", id: "c4", name: "write_file", arguments: { path: "d.txt", content: big } }]),
      assistantMsg([{ type: "text", text: "all written" }], "stop"),
    ];

    const capturedContexts: TranscriptContext[] = [];
    const streamFn: StreamFn = (_model, context) => {
      capturedContexts.push(context);
      const message = steps[capturedContexts.length - 1]!;
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      message.content.forEach((block, ci) => {
        if (block.type === "text")
          stream.push(
            { type: "text_start", contentIndex: ci, partial: message },
            { type: "text_end", contentIndex: ci, partial: message },
          );
        if (block.type === "toolCall")
          stream.push(
            { type: "toolcall_start", contentIndex: ci, partial: message },
            { type: "toolcall_end", contentIndex: ci, toolCall: block, partial: message },
          );
      });
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      return stream;
    };

    const manager = new RunManager();
    const result = await manager.run({
      task: `write four big files ${big.slice(0, 50)}…`,
      model: compactModel,
      streamFn,
      reporter: new CollectingReporter(),
      tools: [],
      context: { summaryChat: summaryChat(validSummary("write four files", ["a.txt", "b.txt"])) },
    });
    manager.close();

    expect(result.record.status).toBe("completed");

    // 至少一次模型调用看到了压缩后的上下文
    const compacted = capturedContexts.filter((c) => JSON.stringify(c).includes("<context-summary>"));
    expect(compacted.length).toBeGreaterThanOrEqual(1);

    // Trace: compaction 审计事件 + 每次请求的 context_decision
    const trace = readTraceFile(result.tracePath as string);
    const compactions = trace.events.filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    expect(compactions[0]).toMatchObject({ trigger: "threshold" });
    const decisions = trace.events.filter((e) => e.type === "context_decision");
    expect(decisions.length).toBe(capturedContexts.length);
    expect(decisions[0]).toMatchObject({ decision: "reuse" });
    expect(decisions.some((d) => (d as { summarized: boolean }).summarized)).toBe(true);
    tmp.leave();
  });
});

function assistantMsg(
  content: AssistantMessage["content"],
  stopReason: "toolUse" | "stop" = "toolUse",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: FAKE_MODEL.api,
    provider: FAKE_MODEL.provider,
    model: FAKE_MODEL.id,
    // Large usage so the compaction threshold triggers deterministically.
    usage: {
      input: 300,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 400,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}
