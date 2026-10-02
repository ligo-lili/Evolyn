#!/usr/bin/env node
// Chaos driver: one RunManager episode (run or resume) with a deterministic,
// TRANSCRIPT-DRIVEN scripted stream — no API key, no network. Both the chaos
// fuzzer (scripts/chaos.mjs) and the E2E fault-window tests spawn this.
//
// The stream decides from the transcript state, so after ANY kill the resumed
// run drives itself to the same deterministic completion:
//   write out.txt → send_notification (the conserved side effect) → read back → done
//
// Modes:
//   run <dbPath> [faultSpec]           start a new run (the fault kills this process)
//   resume <runId> <dbPath> [faultSpec]  resume an interrupted run
//
// Clean exit prints one JSON line: {"status": "..."} — killed runs print nothing.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = pathToFileURL(path.join(here, "..", "dist", "index.js")).href;
const harness = await import(distPath);

const MODEL = {
  id: "chaos-fake",
  name: "Chaos Fake",
  api: "openai-completions",
  provider: "chaos",
  baseUrl: "http://localhost:9",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content, stopReason) {
  return {
    role: "assistant",
    content,
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: { ...USAGE, cost: { ...USAGE.cost } },
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * Transcript-driven decision stream: a MULTI-STEP plan — the first tool step
 * without a matching toolCall signature in the transcript is the next action.
 * After any kill, a resumed run rebuilds the transcript from durable state and
 * picks the plan up exactly where it left off. 24 steps give the fuzzer a
 * wide mid-run kill window (the run itself takes ~0.5s after setup).
 */
const PLAN = [];
for (let i = 1; i <= 8; i++) {
  PLAN.push({ tool: "write_file", args: { path: `out-${i}.txt`, content: `payload ${i}` } });
  PLAN.push({ tool: "send_notification", args: { channel: "email", message: `chaos notice ${i}` } });
  PLAN.push({ tool: "read_file", args: { path: `out-${i}.txt` } });
}

function scriptedStreamFn() {
  let call = 0;
  // Artificial per-step pacing: a fake-model run completes in ~150ms, which is
  // narrower than the fuzzer's scheduling jitter — spreading the steps gives
  // random kills a real window across ALL phases of the plan.
  const STEP_DELAY_MS = Number(process.env.CHAOS_STEP_DELAY ?? 30);
  return async (_model, context) => {
    await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
    call++;
    const messages = context?.messages ?? [];
    // A step is done when the transcript contains a toolCall with the SAME
    // name + arguments signature (stable across resumes — ids are not).
    const doneSignatures = new Set(
      messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) =>
          m.content.filter((b) => b.type === "toolCall").map((b) => b.name + JSON.stringify(b.arguments)),
        ),
    );
    let message;
    const pending = PLAN.find((s) => !doneSignatures.has(s.tool + JSON.stringify(s.args)));
    if (pending) {
      message = assistantMessage(
        [{ type: "toolCall", id: `c${call}-${pending.tool}`, name: pending.tool, arguments: pending.args }],
        "toolUse",
      );
    } else {
      message = assistantMessage([{ type: "text", text: "chaos task complete" }], "stop");
    }
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    message.content.forEach((block, contentIndex) => {
      if (block.type === "text") {
        stream.push({ type: "text_start", contentIndex, partial: message });
        stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
        stream.push({ type: "text_end", contentIndex, partial: message });
      } else if (block.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
      }
    });
    stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    return stream;
  };
}

const [, , mode, argA, argB, argC] = process.argv;
// run:    argA = dbPath, argB = fault
// resume: argA = runId,  argB = dbPath, argC = fault
let dbPath;
let runId;
let fault;
if (mode === "run") {
  dbPath = argA;
  fault = argB;
} else if (mode === "resume") {
  runId = argA;
  dbPath = argB;
  fault = argC;
} else {
  console.error("usage: chaos-driver.mjs run <dbPath> [fault] | resume <runId> <dbPath> [fault]");
  process.exit(2);
}
if (!dbPath) {
  console.error("usage: chaos-driver.mjs run <dbPath> [fault] | resume <runId> <dbPath> [fault]");
  process.exit(2);
}
// The workspace IS the DB's directory: tools resolve relative paths against it.
import fs from "node:fs";
const workspace = path.dirname(path.resolve(dbPath));
fs.mkdirSync(workspace, { recursive: true });
process.chdir(workspace);

const manager = new harness.RunManager();
const reporter = { onEvent: () => {} };
// The fuzzer kills only AFTER setup is done — otherwise most random kills land
// in module-import time and the episode is trivially empty.
process.stderr.write("##READY##\n");
try {
  if (mode === "run") {
    const result = await manager.run({
      task: "chaos: write out.txt, send one notification, verify by reading it back",
      model: MODEL,
      streamFn: scriptedStreamFn(),
      database: path.resolve(dbPath),
      tools: harness.DEMO_TOOLS,
      fault: fault || undefined,
      reporter,
    });
    console.log(JSON.stringify({ status: result.record.status, runId: result.record.id }));
    process.exit(result.record.status === "completed" ? 0 : 1);
  } else {
    const result = await manager.resume(runId, {
      database: path.resolve(dbPath),
      model: MODEL,
      streamFn: scriptedStreamFn(),
      tools: harness.DEMO_TOOLS,
      fault: fault || undefined,
      reporter,
    });
    console.log(JSON.stringify({ status: result.record.status, runId: result.record.id }));
    process.exit(result.record.status === "completed" ? 0 : 1);
  }
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(1);
}
