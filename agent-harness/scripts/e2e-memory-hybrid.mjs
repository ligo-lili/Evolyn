#!/usr/bin/env node
// Real-chain memory E2E — the ONE link the vitest suite cannot cover:
//
//   real model download (Xenova e5, ~30MB first run, cached afterwards)
//     → real run #1: the model surface (memory_create) writes a memory
//       through the wrapper chain
//     → backfill triggers at run end; drain waits for REAL embeddings
//     → real run #2: the next run recalls that memory — cue injected, the
//       real vector path fired in-run
//     → direct search over the same index reports mode=hybrid
//
//   npm run e2e:memory-hybrid          (NOT part of CI — downloads the model)
//
// Exit codes: 0 = chain green; 1 = chain assertion failed (a real finding);
// 2 = infrastructure failure (model download / network unreachable — report
// marked INVALID, nothing gated). The report lands in .harness/evals/
// memory-hybrid-e2e-<ts>.json, sharing the ledger vocabulary with the other
// evals.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";

const here = path.dirname(fileURLToPath(import.meta.url));
const harness = await import(pathToFileURL(path.join(here, "..", "dist", "index.js")).href);
const { RunManager, MemoryStore, MemorySearchIndex, openDatabase, sharedEmbedder, EMBEDDING_MODEL_ID } = harness;

const MODEL = {
  id: "e2e-fake",
  name: "E2E Fake",
  api: "openai-completions",
  provider: "e2e",
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

function scriptedStream(steps) {
  let call = 0;
  return (_model, _context) => {
    const message = steps[call++];
    if (!message) throw new Error(`unexpected stream call #${call}`);
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

function assert(condition, message) {
  if (!condition) {
    const err = new Error(message);
    err.e2eAssertion = true;
    throw err;
  }
}

const originalCwd = process.cwd();
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-memory-hybrid-"));
const dbPath = path.join(ws, "harness.db");
const chain = [];
let verdict = "pass";

try {
  process.chdir(ws);

  // ---- episode 1: memory_create through the real tool chain; backfill at run end
  const real = sharedEmbedder(); // process-wide singleton; the REAL model loads lazily at drain time
  const manager1 = new RunManager();
  const result1 = await manager1.run({
    task: "remember the branch workflow for this workspace",
    model: MODEL,
    streamFn: scriptedStream([
      assistantMessage(
        [
          {
            type: "toolCall",
            id: "c1",
            name: "memory_create",
            arguments: {
              title: "branch workflow",
              summary: "feature 分支先变基。",
              content: "prefer git rebase over merge for feature branches; never force push main.",
              keywords: ["rebase", "branch"],
            },
          },
        ],
        "toolUse",
      ),
      assistantMessage([{ type: "text", text: "stored." }], "stop"),
    ]),
    reporter: { onEvent() {} },
    database: dbPath,
    tools: "coding", // memory tools join the coding toolset by default
    memory: { embedder: real },
  });
  assert(
    result1.record.status === "completed",
    `run #1 must complete, got ${result1.record.status} (${result1.record.error ?? "-"})`,
  );
  chain.push({ step: "run1-memory-create", ok: true });

  // Backfill fired at run end; drain waits for the REAL model download + embeddings.
  const drained = await manager1.drainMemoryBackfill();
  assert(drained === true, "backfill must have started (chunks were pending)");
  const db1 = openDatabase(dbPath);
  const index1 = new MemorySearchIndex(db1);
  const vectors = index1.vectorCount();
  const pending = index1.backfillPending(EMBEDDING_MODEL_ID);
  const diag = index1.diagnostics(EMBEDDING_MODEL_ID);
  db1.close();
  if (diag.backfill_status === "failed") {
    throw Object.assign(new Error(`embedding backfill failed (infra): ${diag.backfill_error}`), { e2eInfra: true });
  }
  assert(
    vectors > 0 && pending === 0 && diag.backfill_status === "complete",
    `backfill must complete with real vectors (vectors=${vectors}, pending=${pending}, status=${diag.backfill_status})`,
  );
  chain.push({ step: "backfill-complete", ok: true, vectors, backfillStatus: diag.backfill_status });

  // ---- episode 2: the NEXT run recalls the memory with the real hybrid path
  let run2QueryEmbeds = 0;
  const counting = {
    embedPassages: real.embedPassages.bind(real),
    embedQuery: async (text) => {
      run2QueryEmbeds++;
      return real.embedQuery(text);
    },
  };
  const manager2 = new RunManager();
  const captured = [];
  const result2 = await manager2.run({
    task: "how should we rebase feature branches",
    model: MODEL,
    streamFn: (model, context) => {
      captured.push(JSON.stringify(context));
      return scriptedStream([assistantMessage([{ type: "text", text: "rebase." }], "stop")])(model, context);
    },
    reporter: { onEvent() {} },
    database: dbPath,
    tools: [],
    memory: { embedder: counting },
  });
  await manager2.drainMemoryBackfill();
  assert(result2.record.status === "completed", `run #2 must complete, got ${result2.record.status}`);
  const cue = captured.find((c) => c.includes("<relevant_experience>"));
  assert(cue !== undefined && cue.includes("M001"), "run #2 must recall the memory as a cue in its system prompt");
  assert(run2QueryEmbeds >= 1, "run #2's recall must fire the real vector path (query embedding)");
  chain.push({ step: "run2-hybrid-recall", ok: true, queryEmbeds: run2QueryEmbeds });

  // Durable proof over the same index: the recall reports mode=hybrid, M001 on top.
  const db2 = openDatabase(dbPath);
  const index2 = new MemorySearchIndex(db2);
  const store2 = new MemoryStore(path.join(ws, "memory"));
  const hits = await index2.search(store2, "how should we rebase feature branches", { limit: 5, embedder: real });
  db2.close();
  assert(
    hits.length > 0 && hits[0].record.id === "M001" && hits[0].mode === "hybrid",
    `direct search must report mode=hybrid with M001 on top (got ${hits[0]?.mode ?? "none"})`,
  );
  chain.push({
    step: "direct-search-hybrid",
    ok: true,
    mode: hits[0].mode,
    score: hits[0].score,
    boost: hits[0].boost,
  });
} catch (err) {
  const infra = err?.e2eInfra === true || !err?.e2eAssertion;
  verdict = infra ? "invalid" : "fail";
  chain.push({ step: "failed", ok: false, error: err instanceof Error ? err.message : String(err), infra });
  if (infra) {
    console.error(
      `[e2e:memory-hybrid] INFRASTRUCTURE FAILURE — report marked INVALID, nothing gated: ${err?.message ?? err}`,
    );
  } else {
    console.error(`[e2e:memory-hybrid] CHAIN RED — ${err?.message ?? err}`);
  }
} finally {
  process.chdir(originalCwd);
  const ledgerDir = path.join(originalCwd, ".harness", "evals");
  fs.mkdirSync(ledgerDir, { recursive: true });
  const report = {
    name: "memory-hybrid-e2e",
    embeddingModel: EMBEDDING_MODEL_ID,
    chain,
    verdict,
    timestamp: new Date().toISOString(),
  };
  const ledgerPath = path.join(ledgerDir, `memory-hybrid-e2e-${Date.now()}.json`);
  fs.writeFileSync(ledgerPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`ledger: ${ledgerPath} (verdict: ${verdict})`);
  try {
    fs.rmSync(ws, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  if (verdict === "pass") process.exit(0);
  process.exit(verdict === "fail" ? 1 : 2);
}
