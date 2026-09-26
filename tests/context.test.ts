import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn, TranscriptContext } from "@earendil-works/pi-agent-core";
import { assembleSystemPrompt, renderExperienceBlock, renderSkillBlock } from "../src/context/assembler.js";
import { createContextTransformer } from "../src/context/compaction.js";
import { readTraceFile } from "../src/trace/read.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { FAKE_MODEL, makeTempCwd } from "./helpers.js";

const tmp = makeTempCwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

describe("context assembler (阶段 8)", () => {
  it("assembles deterministically: base → skills → experiences, byte-identical for equal inputs", () => {
    const sections = {
      base: "BASE",
      skills: renderSkillBlock([{ name: "demo-skill", description: "does demo things", location: "/skills/demo/SKILL.md" }]),
      experiences: renderExperienceBlock([{ summaryZh: "先读后写", approach: "read then write", pitfalls: "不要盲目覆盖" }]),
    };
    expect(assembleSystemPrompt(sections)).toBe(assembleSystemPrompt({ ...sections }));
    expect(assembleSystemPrompt(sections)).toContain("BASE");
    expect(assembleSystemPrompt(sections).indexOf("BASE")).toBeLessThan(assembleSystemPrompt(sections).indexOf("<available_skills>"));
    expect(assembleSystemPrompt(sections).indexOf("<available_skills>")).toBeLessThan(assembleSystemPrompt(sections).indexOf("<relevant_experience>"));
  });

  it("renders empty blocks as empty strings and falls back to the default base", () => {
    expect(renderSkillBlock([])).toBe("");
    expect(renderExperienceBlock([])).toBe("");
    expect(assembleSystemPrompt()).toBe(assembleSystemPrompt({}));
  });
});

describe("context compaction (阶段 8)", () => {
  it("compacts the model-visible context when over threshold and records a compaction event", async () => {
    tmp.enter();
    const compactModel = { ...FAKE_MODEL, contextWindow: 300 };
    const big = "x".repeat(600);
    const steps: AssistantMessage[] = [
      assistantMsg([{ type: "toolCall", id: "c1", name: "write_file", arguments: { path: "a.txt", content: big } }]),
      assistantMsg([{ type: "toolCall", id: "c2", name: "write_file", arguments: { path: "b.txt", content: big } }]),
      assistantMsg([{ type: "text", text: "all written" }], "stop"),
    ];

    const capturedContexts: TranscriptContext[] = [];
    const streamFn: StreamFn = (_model, context) => {
      capturedContexts.push(context);
      const message = steps[capturedContexts.length - 1]!;
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      message.content.forEach((block, ci) => {
        if (block.type === "text") stream.push({ type: "text_start", contentIndex: ci, partial: message }, { type: "text_end", contentIndex: ci, partial: message });
        if (block.type === "toolCall") stream.push({ type: "toolcall_start", contentIndex: ci, partial: message }, { type: "toolcall_end", contentIndex: ci, toolCall: block, partial: message });
      });
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      return stream;
    };

    const manager = new RunManager();
    const result = await manager.run({
      task: `write two big files ${big.slice(0, 50)}…`,
      model: compactModel,
      streamFn,
      reporter: new CollectingReporter(),
      tools: [],
      compaction: {
        settings: { reserveTokens: 60, keepRecentTokens: 40 },
        summaryFn: async () => "The user asked to write two big files; a.txt and b.txt were written.",
      },
    });
    manager.close();

    expect(result.record.status).toBe("completed");

    // at least one model call saw the compacted context
    const compacted = capturedContexts.filter((c) => JSON.stringify(c).includes("<context-summary>"));
    expect(compacted.length).toBeGreaterThanOrEqual(1);

    // the audit event landed in the trace
    const trace = readTraceFile(result.tracePath as string);
    const compactions = trace.events.filter((e) => e.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]).toMatchObject({ trigger: "threshold" });
    expect(compactions[0] && typeof (compactions[0] as { tokensBefore: number }).tokensBefore === "number").toBe(true);
    tmp.leave();
  });

  it("transformer is a no-op below the threshold", async () => {
    const transformer = createContextTransformer({
      contextWindow: 128_000,
      model: FAKE_MODEL,
      summaryFn: async () => "should never be called",
    });
    const messages = [{ role: "user", content: "hello", timestamp: Date.now() }] as never[];
    await expect(transformer(messages)).resolves.toBe(messages);
  });
});

function assistantMsg(content: AssistantMessage["content"], stopReason: "toolUse" | "stop" = "toolUse"): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: FAKE_MODEL.api,
    provider: FAKE_MODEL.provider,
    model: FAKE_MODEL.id,
    // Large usage so the compaction threshold triggers deterministically.
    usage: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 400, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}
