import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ContextDecision } from "../src/context/decision.js";
import { LimitEnforcer } from "../src/runtime/limits.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { InteractiveSession } from "../src/runtime/session.js";
import { openDatabase, defaultDbPath } from "../src/storage/db.js";
import { RunRepo } from "../src/storage/repos/runs.js";
import { TraceEventRepo } from "../src/storage/repos/trace-events.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn, USAGE } from "./helpers.js";

const tmp = makeTempCwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

function traceEvents(runId: string): { type: string }[] {
  const db = openDatabase(defaultDbPath());
  try {
    return new TraceEventRepo(db).getByRun(runId).map((e) => ({ type: e.type }));
  } finally {
    db.close();
  }
}

function runRowStatus(runId: string): string | undefined {
  const db = openDatabase(defaultDbPath());
  try {
    return new RunRepo(db).get(runId)?.status;
  } finally {
    db.close();
  }
}

/**
 * StreamFn whose first call holds until released — makes mid-run timing
 * deterministic. Honors the abort protocol: on signal abort it settles the
 * stream with an aborted assistant message (real provider adapters do the
 * same; a fake that ignores the signal would leave the loop waiting forever).
 */
function gatedStreamFn(
  firstMessage: AssistantMessage,
  laterMessages: AssistantMessage[],
): {
  streamFn: StreamFn;
  started: Promise<void>;
  release: () => void;
} {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const emitMessage = (stream: AssistantMessageEventStream, message: AssistantMessage): void => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    const text = message.content.find((b) => b.type === "text");
    if (text && text.type === "text") {
      stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
    }
    stream.push({ type: "done", reason: "stop", message });
  };
  const streamFn: StreamFn = (_model, _context, options) => {
    calls++;
    const stream = new AssistantMessageEventStream();
    if (calls === 1) {
      notifyStarted();
      const signal = options?.signal;
      let settled = false;
      const settleAborted = (): void => {
        if (settled) return;
        settled = true;
        stream.push({
          type: "error",
          reason: "aborted",
          error: assistantMessage([{ type: "text", text: "" }], "aborted"),
        });
      };
      signal?.addEventListener("abort", settleAborted, { once: true });
      void gate.then(() => {
        if (settled || signal?.aborted) return;
        settled = true;
        emitMessage(stream, firstMessage);
      });
      return stream;
    }
    const next = laterMessages.shift();
    if (!next) throw new Error(`unexpected extra stream call #${calls}`);
    emitMessage(stream, next);
    return stream;
  };
  return { streamFn, started, release };
}

describe("InteractiveSession (fake StreamFn, no API key)", () => {
  it("runs many submits over ONE durable run; run_end lands only at end()", async () => {
    const steps = [
      assistantMessage([{ type: "text", text: "first answer" }], "stop"),
      assistantMessage([{ type: "text", text: "second answer" }], "stop"),
    ];
    const manager = new RunManager();
    const session = await InteractiveSession.start(manager, {
      task: "first question",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(steps),
    });

    const first = await session.submit("first question");
    expect(first.status).toBe("completed");
    expect(session.isStreaming).toBe(false);
    // The trace bracket is OPEN mid-session: run_start, no run_end.
    const midTypes = traceEvents(session.id).map((e) => e.type);
    expect(midTypes[0]).toBe("run_start");
    expect(midTypes).not.toContain("run_end");

    const second = await session.submit("second question");
    expect(second.status).toBe("completed");
    const roles = session
      .messages()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    // Only assistant messages carry usage — 2 assistant turns × 15 tokens.
    expect(session.usage()?.totalTokens).toBe(2 * USAGE.totalTokens);

    const outcome = await session.end();
    expect(outcome.status).toBe("completed");
    const finalTypes = traceEvents(session.id).map((e) => e.type);
    expect(finalTypes[0]).toBe("run_start");
    expect(finalTypes.at(-1)).toBe("run_end");
    expect(runRowStatus(session.id)).toBe("completed");
    manager.close();
  });

  it("steer() while busy queues the message into the running agent", async () => {
    const first = assistantMessage([{ type: "text", text: "first answer" }], "stop");
    const second = assistantMessage([{ type: "text", text: "second answer" }], "stop");
    const { streamFn, release } = gatedStreamFn(first, [second]);
    const manager = new RunManager();
    const session = await InteractiveSession.start(manager, {
      task: "first question",
      model: FAKE_MODEL,
      streamFn,
    });

    const cycle = session.submit("first question");
    session.steer("actually, do this instead");
    release();
    const outcome = await cycle;

    expect(outcome.status).toBe("completed");
    expect(session.hasQueuedMessages()).toBe(false);
    const texts = session
      .messages()
      .filter((m) => m.role === "user")
      .map((m) => (m.role === "user" ? m.content : []))
      .map((content) =>
        Array.isArray(content)
          ? content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("")
          : String(content),
      );
    expect(texts).toContain("actually, do this instead");
    await session.end();
    manager.close();
  });

  it("interrupt() settles the cycle with an aborted assistant message and the session stays usable", async () => {
    const first = assistantMessage([{ type: "text", text: "answer" }], "stop");
    const later = assistantMessage([{ type: "text", text: "after abort" }], "stop");
    const { streamFn, started, release } = gatedStreamFn(first, [later]);
    const manager = new RunManager();
    const session = await InteractiveSession.start(manager, {
      task: "long question",
      model: FAKE_MODEL,
      streamFn,
    });

    const cycle = session.submit("long question");
    await started; // the run is mid-first-request
    session.interrupt();
    const outcome = await cycle;
    release();

    expect(outcome.status).toBe("completed");
    const last = session.messages().at(-1);
    expect(last?.role).toBe("assistant");
    if (last?.role === "assistant") expect(last.stopReason).toBe("aborted");

    // The session survives the interrupt — a fresh submit still works.
    const next = await session.submit("try again");
    expect(next.status).toBe("completed");
    await session.end();
    manager.close();
  });

  it("setModel hot-switches for the next cycle and validates the spec", async () => {
    const manager = new RunManager();
    const session = await InteractiveSession.start(manager, {
      task: "hello",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "hi" }], "stop")]),
    });
    expect(session.modelSpec).toBe(`${FAKE_MODEL.provider}/${FAKE_MODEL.id}`);
    session.setModel("deepseek/deepseek-flash");
    expect(session.modelSpec).toBe("deepseek/deepseek-flash");
    expect(() => session.setModel("no-such-provider/no-such-model")).toThrow();
    await session.end();
    manager.close();
  });

  it("a session killed WITHOUT end() is recoverable by the plain resume path", async () => {
    const manager = new RunManager();
    const session = await InteractiveSession.start(manager, {
      task: "do a thing",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "did the thing" }], "stop")]),
    });
    await session.submit("do a thing");
    const runId = session.id;
    // "Crash": no end(), durable state still says running, then the process dies.
    manager.close();

    const manager2 = new RunManager();
    const recovered = await manager2.resume(runId, { model: FAKE_MODEL });
    expect(recovered.record.status).toBe("completed");
    expect(runRowStatus(runId)).toBe("completed");
    const types = traceEvents(runId).map((e) => e.type);
    expect(types.filter((t) => t === "run_end")).toHaveLength(1);
    manager2.close();
  });

  it("end() while streaming aborts, finalizes exactly once", async () => {
    const first = assistantMessage([{ type: "text", text: "answer" }], "stop");
    const { streamFn, started, release } = gatedStreamFn(first, []);
    const manager = new RunManager();
    const session = await InteractiveSession.start(manager, {
      task: "long question",
      model: FAKE_MODEL,
      streamFn,
    });
    void session.submit("long question").catch(() => undefined);
    await started;

    const outcome = await session.end();
    expect(outcome.status).toBe("completed");
    expect(session.isStreaming).toBe(false);
    release(); // the held stream must not append anything after run_end
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const types = traceEvents(session.id).map((e) => e.type);
    expect(types.filter((t) => t === "run_end")).toHaveLength(1);
    expect(types.at(-1)).toBe("run_end");
    manager.close();
  });
});

describe("LimitEnforcer.resetCycle (interactive per-cycle semantics)", () => {
  const noopAudit = (): void => {};
  const noopViolation = (): void => {};
  const baseLimits = {
    maxTurns: 40,
    maxToolCalls: 1,
    maxRepeatedToolCalls: 3,
    maxCostUsd: 1,
    maxTotalTokens: 1000,
    toolTimeoutMs: 1000,
  };

  it("resets the tool-call counter per cycle but keeps the cost fuse cumulative", () => {
    const enforcer = new LimitEnforcer(baseLimits, noopAudit, noopViolation);
    expect(enforcer.beforeToolCall("a", {})).toBeUndefined();
    expect(enforcer.beforeToolCall("a", {})).toMatchObject({ block: true });
    enforcer.resetCycle();
    expect(enforcer.beforeToolCall("a", {})).toBeUndefined();

    const usage: Usage = { ...USAGE, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 } };
    enforcer.charge(usage);
    enforcer.resetCycle();
    expect(enforcer.beforeToolCall("a", {})).toMatchObject({ block: true, reason: expect.stringContaining("cost") });
  });
});

describe("InteractiveSession — manual /compact and per-cycle refresh", () => {
  it("requestCompact forces the next request's context_decision to compact", async () => {
    const decisions: ContextDecision[] = [];
    const manager = new RunManager();
    const session = await InteractiveSession.start(manager, {
      task: "first question",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([
        assistantMessage([{ type: "text", text: "first answer" }], "stop"),
        assistantMessage([{ type: "text", text: "second answer" }], "stop"),
      ]),
      context: { onDecision: (decision) => decisions.push(decision) },
    });

    await session.submit("first question");
    expect(decisions.at(-1)?.decision).toBe("reuse"); // tiny transcript — no budget pressure

    session.requestCompact();
    await session.submit("second question");
    expect(decisions.at(-1)?.decision).toBe("compact"); // manual trigger bypasses the budget lines
    expect(decisions.at(-1)?.reason).toContain("manual /compact");

    await session.end();
    manager.close();
  });

  it("injects a session_refresh system message when the workspace changes (coding toolset)", async () => {
    const manager = new RunManager();
    const session = await InteractiveSession.start(manager, {
      task: "create a file",
      model: FAKE_MODEL,
      tools: "coding",
      streamFn: scriptedStreamFn([
        assistantMessage([{ type: "text", text: "created" }], "stop"),
        assistantMessage([{ type: "text", text: "looked around" }], "stop"),
      ]),
    });

    await session.submit("create a file");
    // First cycle: the baseline equals the session-start injections — no refresh.
    const systemsBefore = session.messages().filter((m) => m.role === "system");
    expect(systemsBefore).toHaveLength(1); // leading system message only

    // The workspace tree changes → the next cycle carries a fresh map.
    fs.writeFileSync(path.join(tmp.dir, "refresh-probe.txt"), "hello");
    await session.submit("now look around");

    const systemsAfter = session.messages().filter((m) => m.role === "system");
    expect(systemsAfter.length).toBe(2);
    const refresh = systemsAfter.at(-1);
    const rendered = JSON.stringify(refresh?.content ?? "");
    expect(rendered).toContain("session_refresh");
    expect(rendered).toContain("refresh-probe.txt");
    // The refresh block lands BEFORE the user message it precedes.
    const roles = session.messages().map((m) => m.role);
    expect(roles.indexOf("system", 1)).toBeLessThan(roles.lastIndexOf("user"));

    await session.end();
    manager.close();
  });

  it("resume() attaches a recovered run and the conversation continues on the SAME run id", async () => {
    const manager = new RunManager();
    const crashed = await InteractiveSession.start(manager, {
      task: "do a thing",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "did the thing" }], "stop")]),
    });
    await crashed.submit("do a thing");
    const runId = crashed.id;
    manager.close(); // "crash" — no end(), durable state says running

    const manager2 = new RunManager();
    const session = await InteractiveSession.resume(manager2, runId, {
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "continued answer" }], "stop")]),
    });
    expect(session.id).toBe(runId); // same durable run
    expect(session.isStreaming).toBe(false);

    const outcome = await session.submit("keep going");
    expect(outcome.status).toBe("completed");
    const roles = session
      .messages()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);

    const end = await session.end();
    expect(end.status).toBe("completed");
    const types = traceEvents(runId).map((e) => e.type);
    expect(types.filter((t) => t === "run_end")).toHaveLength(1);
    expect(runRowStatus(runId)).toBe("completed");
    manager2.close();
  });

  it("resume() rejects a run that already finished cleanly", async () => {
    const manager = new RunManager();
    const session = await InteractiveSession.start(manager, {
      task: "finish cleanly",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "done" }], "stop")]),
    });
    await session.submit("finish cleanly");
    await session.end();
    // Terminal rows keep the explicit "not resumable" rejection contract.
    await expect(InteractiveSession.resume(manager, session.id, { model: FAKE_MODEL })).rejects.toThrow(
      /not resumable/,
    );
    manager.close();
  });
});
