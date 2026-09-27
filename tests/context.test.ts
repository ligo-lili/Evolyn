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

    // audit events landed in the trace: threshold first, rolling when the tail regrew
    const trace = readTraceFile(result.tracePath as string);
    const compactions = trace.events.filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    expect(compactions[0]).toMatchObject({ trigger: "threshold" });
    expect(typeof (compactions[0] as { tokensBefore: number }).tokensBefore === "number").toBe(true);
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

  it("rolls the summary when the tail outgrows the budget again (阶段 9.5)", async () => {
    const events: Array<{ trigger?: string }> = [];
    const summaryCalls: Array<{ len: number; previous?: string }> = [];
    const transformer = createContextTransformer({
      contextWindow: 300,
      model: FAKE_MODEL,
      settings: { reserveTokens: 60, keepRecentTokens: 40 },
      summaryFn: async (prefix, previous) => {
        summaryCalls.push({ len: prefix.length, previous });
        return previous ? `ROLLED: ${previous}` : "FIRST SUMMARY";
      },
      onEvent: (e) => events.push(e as { trigger?: string }),
    });

    const big = "y".repeat(800);
    const m = (role: string, content: unknown) => ({ role, content, timestamp: Date.now() }) as never as import("@earendil-works/pi-agent-core").AgentMessage;
    const msgs1 = [
      m("system", "sys"),
      m("user", "task"),
      m("assistant", [{ type: "toolCall", id: "c1", name: "write_file", arguments: { path: "a", content: big } }]),
      m("toolResult", [{ type: "text", text: big }]),
      m("assistant", [{ type: "text", text: "step1 done" }]),
    ];
    const out1 = await transformer(msgs1);
    expect(JSON.stringify(out1)).toContain("FIRST SUMMARY");

    const msgs2 = [
      ...msgs1,
      m("user", "next step"),
      m("assistant", [{ type: "text", text: big }]),
      m("toolResult", [{ type: "text", text: big }]),
    ];
    const out2 = await transformer(msgs2);
    expect(JSON.stringify(out2)).toContain("ROLLED:");
    expect(summaryCalls[1]?.previous).toBe("FIRST SUMMARY"); // fold the previous summary in
    expect(events.map((e) => (e.type === "compaction" ? e.trigger : undefined))).toEqual(["threshold", "rolling"]);
  });

  it("tidy condenses old tool results but keeps the current turn verbatim", async () => {
    const { tidyToolResults } = await import("../src/context/compaction.js");
    const big = "z".repeat(800);
    const m = (role: string, content: unknown) => ({ role, content, timestamp: Date.now() }) as never as import("@earendil-works/pi-agent-core").AgentMessage;
    const messages = [
      m("system", "sys"),
      m("user", "turn1"),
      m("assistant", [{ type: "text", text: "x" }]),
      { role: "toolResult", toolCallId: "old", toolName: "exec", content: [{ type: "text", text: big }], isError: false, timestamp: 1 } as never as import("@earendil-works/pi-agent-core").AgentMessage,
      m("user", "turn2"),
      { role: "toolResult", toolCallId: "new", toolName: "exec", content: [{ type: "text", text: big }], isError: false, timestamp: 2 } as never as import("@earendil-works/pi-agent-core").AgentMessage,
    ];
    const tidied = tidyToolResults(messages, { keepChars: 100, evidenceBase: ".harness/evidence/run-1" });
    const oldText = JSON.stringify(tidied[3]);
    const newText = JSON.stringify(tidied[5]);
    expect(oldText).toContain("(truncated; full output:");
    expect(oldText).toContain("run-1/old.md");
    expect(oldText.length).toBeLessThan(JSON.stringify(messages[3]).length);
    expect(newText).toContain(big); // current turn untouched
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
