import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { completeStructured } from "../src/llm/structured.js";
import { isTransientError, withRetry } from "../src/runtime/retry.js";
import { withToolTimeout } from "../src/runtime/tools/timeout.js";
import { readTraceFile } from "../src/trace/read.js";
import type { AnyAgentTool } from "../src/index.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";

const tmp = makeTempCwd();

afterEach(() => tmp.leave());

describe("completeStructured (阶段 9.8)", () => {
  const parse = (raw: string) => {
    const parsed = JSON.parse(raw) as { answer: string };
    if (!parsed.answer) throw new Error("missing field: answer");
    return parsed;
  };

  it("direct success", async () => {
    const { value, attempts, method } = await completeStructured({
      prompt: "q",
      parse,
      complete: async () => JSON.stringify({ answer: "ok" }),
    });
    expect(value.answer).toBe("ok");
    expect(attempts).toBe(1);
    expect(method).toBe("direct");
  });

  it("re-prompts with the parse error, then succeeds", async () => {
    const calls: string[] = [];
    const { value, attempts, method } = await completeStructured({
      prompt: "q",
      parse,
      complete: async (_messages, opts) => {
        expect(opts?.schemaTool).toBeUndefined();
        calls.push("call");
        if (calls.length === 1) return "not json at all";
        return JSON.stringify({ answer: "recovered" });
      },
      maxReprompts: 1,
    });
    expect(method).toBe("reprompt");
    expect(attempts).toBe(2);
    expect(value.answer).toBe("recovered");
  });

  it("re-prompt messages carry the previous response and the parse error", async () => {
    const calls: string[] = [];
    const complete = async (messages: readonly { role: string; content: string }[]) => {
      calls.push(messages.map((m) => m.content).join(" | "));
      return "garbage";
    };
    await completeStructured({
      prompt: "q",
      parse,
      complete,
      maxReprompts: 0,
    }).catch(() => "failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("q");

    // with a reprompt: the second call sees the assistant garbage + the error
    const calls2: string[] = [];
    await completeStructured({
      prompt: "q",
      parse,
      complete: async (messages) => {
        calls2.push(messages.map((m) => m.content).join(" | "));
        return "garbage";
      },
      maxReprompts: 1,
    }).catch(() => "failed");
    expect(calls2[1]).toContain("garbage");
    expect(calls2[1]).toContain("failed validation");
  });

  it("falls back to constrained decoding (schema tool) before giving up", async () => {
    let forced = false;
    const { value, method } = await completeStructured({
      prompt: "q",
      parse,
      complete: async (_messages, opts) => {
        if (opts?.schemaTool) {
          forced = true;
          return JSON.stringify({ answer: "constrained" });
        }
        return "still garbage";
      },
      maxReprompts: 1,
      schemaTool: {
        name: "answer",
        description: "structured answer",
        parameters: Type.Object({ answer: Type.String() }),
      },
    });
    expect(forced).toBe(true);
    expect(method).toBe("constrained");
    expect(value.answer).toBe("constrained");
  });

  it("throws after exhausting the pipeline without a schema tool", async () => {
    await expect(
      completeStructured({
        prompt: "q",
        parse,
        complete: async () => "garbage",
        maxReprompts: 1,
      }),
    ).rejects.toThrow();
  });
});

describe("tiered retry (阶段 9.8)", () => {
  function flakyTool(
    replay: "safe" | "never" | undefined,
    failures: number,
  ): { tool: AnyAgentTool; calls: () => number } {
    let calls = 0;
    const tool: AnyAgentTool = {
      name: "flaky",
      label: "Flaky",
      description: "test tool",
      parameters: Type.Object({}),
      replay,
      execute: async () => {
        calls++;
        if (calls <= failures) throw new Error("ETIMEDOUT: transient network issue");
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
    };
    return { tool, calls: () => calls };
  }

  it("retries transient failures of replay-safe tools and audits them", async () => {
    const retries: number[] = [];
    const { tool, calls } = flakyTool("safe", 1);
    const [wrapped] = withRetry([tool], {
      policy: { maxAttempts: 3, backoffMs: 1 },
      audit: (e) => {
        if (e.type === "tool_retry") retries.push(e.attempt);
      },
    });
    const result = await wrapped!.execute("t1", {}, undefined, undefined);
    expect(calls()).toBe(2);
    expect(result.content[0]).toMatchObject({ text: "ok" });
    expect(retries).toEqual([2]);
  });

  it("never auto-retries non-idempotent tools", async () => {
    const { tool, calls } = flakyTool("never", 1);
    const [wrapped] = withRetry([tool], { policy: { maxAttempts: 3, backoffMs: 1 } });
    await expect(wrapped!.execute("t1", {}, undefined, undefined)).rejects.toThrow(/ETIMEDOUT/);
    expect(calls()).toBe(1);
  });

  it("does not retry non-transient failures even on safe tools", async () => {
    let calls = 0;
    const tool: AnyAgentTool = {
      name: "strict",
      label: "Strict",
      description: "test tool",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        calls++;
        throw new Error("invalid input provided");
      },
    };
    const [wrapped] = withRetry([tool], { policy: { maxAttempts: 3, backoffMs: 1 } });
    await expect(wrapped!.execute("t1", {}, undefined, undefined)).rejects.toThrow(/invalid input/);
    expect(calls).toBe(1);
  });

  it("isTransientError recognizes the common transient vocabulary", () => {
    expect(isTransientError(new Error("request timeout"))).toBe(true);
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isTransientError(new Error("invalid arguments"))).toBe(false);
  });
});

describe("tool timeout (阶段 9.8)", () => {
  it("aborts a hanging tool and reports the timeout", async () => {
    const tool: AnyAgentTool = {
      name: "hangs",
      label: "Hangs",
      description: "test tool",
      parameters: Type.Object({}),
      execute: async (_id, _params, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
        }),
    };
    const [wrapped] = withToolTimeout([tool], 50);
    await expect(wrapped!.execute("t1", {}, undefined, undefined)).rejects.toThrow(/timed out after 50ms/);
  });

  it("lets fast tools through untouched", async () => {
    const tool: AnyAgentTool = {
      name: "fast",
      label: "Fast",
      description: "test tool",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "quick" }], details: undefined }),
    };
    const [wrapped] = withToolTimeout([tool], 5_000);
    const result = await wrapped!.execute("t1", {}, undefined, undefined);
    expect(result.content[0]).toMatchObject({ text: "quick" });
  });
});

describe("runaway guards (阶段 9.8)", () => {
  it("breaks repeated identical tool calls and marks the run failed with the reason", async () => {
    tmp.enter();
    const steps: AssistantMessage[] = [1, 2, 3, 4].map((i) =>
      assistantMessage(
        [
          {
            type: "toolCall",
            id: `c${i}`,
            name: "send_notification",
            arguments: { channel: "email", message: "same" },
          },
        ],
        "toolUse",
      ),
    );
    steps.push(assistantMessage([{ type: "text", text: "gave up" }], "stop"));
    const manager = new RunManager();
    const result = await manager.run({
      task: "loop forever",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(steps),
      reporter: new CollectingReporter(),
      database: path.join(tmp.dir, "repeat", "harness.db"),
      limits: { maxRepeatedToolCalls: 1 },
    });
    manager.close();

    expect(result.record.status).toBe("failed");
    expect(result.record.error).toContain("identical arguments");
    const trace = readTraceFile(result.tracePath as string);
    expect(trace.events.some((e) => e.type === "limit_exceeded" && e.kind === "repeat")).toBe(true);
    tmp.leave();
  });

  it("enforces the cost budget", async () => {
    tmp.enter();
    // helpers.assistantMessage carries zero cost — build costly turns instead.
    const costly = (i: number): AssistantMessage =>
      ({
        role: "assistant",
        content: [
          { type: "toolCall", id: `c${i}`, name: "write_file", arguments: { path: `f${i}.txt`, content: "x" } },
        ],
        api: FAKE_MODEL.api,
        provider: FAKE_MODEL.provider,
        model: FAKE_MODEL.id,
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      }) as AssistantMessage;
    const steps: AssistantMessage[] = [1, 2, 3].map((i) => costly(i));
    steps.push(assistantMessage([{ type: "text", text: "end" }], "stop"));
    const manager = new RunManager();
    const result = await manager.run({
      task: "spend money",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(steps),
      reporter: new CollectingReporter(),
      database: path.join(tmp.dir, "cost", "harness.db"),
      limits: { maxCostUsd: 0.005 }, // first assistant turn already costs $0.01
    });
    manager.close();

    expect(result.record.status).toBe("failed");
    expect(result.record.error).toContain("cost budget exhausted");
    const trace = readTraceFile(result.tracePath as string);
    expect(trace.events.some((e) => e.type === "limit_exceeded" && e.kind === "cost")).toBe(true);
    tmp.leave();
  });

  it("enforces the tool-call budget", async () => {
    tmp.enter();
    const steps: AssistantMessage[] = [1, 2, 3].map((i) =>
      assistantMessage(
        [{ type: "toolCall", id: `c${i}`, name: "write_file", arguments: { path: `g${i}.txt`, content: `x${i}` } }],
        "toolUse",
      ),
    );
    steps.push(assistantMessage([{ type: "text", text: "end" }], "stop"));
    const manager = new RunManager();
    const result = await manager.run({
      task: "call tools a lot",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(steps),
      reporter: new CollectingReporter(),
      database: path.join(tmp.dir, "calls", "harness.db"),
      limits: { maxToolCalls: 1 },
    });
    manager.close();

    expect(result.record.status).toBe("failed");
    expect(result.record.error).toContain("tool-call budget exhausted");
    tmp.leave();
  });

  it("evidence capture still runs under the wrapper chain", async () => {
    tmp.enter();
    const manager = new RunManager();
    const result = await manager.run({
      task: "write evidence",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([
        assistantMessage(
          [{ type: "toolCall", id: "c1", name: "write_file", arguments: { path: "ev.txt", content: "evidence body" } }],
          "toolUse",
        ),
        assistantMessage([{ type: "text", text: "done" }], "stop"),
      ]),
      reporter: new CollectingReporter(),
      database: path.join(tmp.dir, "ev", "harness.db"),
    });
    manager.close();
    const runId = result.record.id;
    const evidence = fs.readFileSync(path.join(tmp.dir, ".harness", "evidence", runId, "c1.md"), "utf8");
    expect(evidence).toContain("evidence body");
    tmp.leave();
  });
});
