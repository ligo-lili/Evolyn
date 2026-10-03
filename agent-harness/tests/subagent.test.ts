import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import type { StreamFn, TranscriptContext } from "@earendil-works/pi-agent-core";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { withToolTimeout, ToolTimeoutError } from "../src/runtime/tools/timeout.js";
import { planRecovery } from "../src/execution/recovery.js";
import { permissionsFor } from "../src/runtime/permissions.js";
import { createExploreTool, EXPLORE_CHILD_TOOLS, type ExploreToolDeps } from "../src/runtime/tools/explore.js";
import { createCodingToolset } from "../src/runtime/tools/coding.js";
import { readFileTool } from "../src/runtime/tools/read-file.js";
import type { HarnessAuditEvent } from "../src/trace/schema.js";
import { FAKE_MODEL, makeTempCwd } from "./helpers.js";

const tmp = makeTempCwd();

// The E2E driver children resolve dist + node_modules relative to the package —
// capture the package root BEFORE any chdir (same pattern as fault.test.ts).
const PACKAGE_ROOT = process.cwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
    usage: { ...USAGE, cost: { ...USAGE.cost } },
    stopReason,
    timestamp: Date.now(),
  };
}

/** One shared scripted stream for parent AND child: the caller is identified
 * by its system prompt (the child's is the explorer prompt). When the script
 * runs dry the stream returns a fallback stop — pi may issue one more request
 * after a beforeToolCall deny (its terminate hint ends the TOOL BATCH, not
 * necessarily the run), and a throwing StreamFn would mask the real outcome. */
function parentChildStream(
  steps: { parent: AssistantMessage[]; child: AssistantMessage[] },
  captured: { caller: "parent" | "child"; context: TranscriptContext }[],
): StreamFn {
  const counters = { parent: 0, child: 0 };
  return (_model, context) => {
    const caller: "parent" | "child" = JSON.stringify(context.messages[0]).includes("read-only code explorer")
      ? "child"
      : "parent";
    captured.push({ caller, context });
    const message =
      steps[caller][counters[caller]++] ?? assistantMsg([{ type: "text", text: "(script exhausted)" }], "stop");
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    message.content.forEach((block, ci) => {
      if (block.type === "text") {
        stream.push({ type: "text_start", contentIndex: ci, partial: message });
        stream.push({ type: "text_end", contentIndex: ci, partial: message });
      }
      if (block.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex: ci, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: ci, toolCall: block, partial: message });
      }
    });
    stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    return stream;
  };
}

function exploreDeps(overrides: Partial<ExploreToolDeps> = {}): ExploreToolDeps {
  return {
    model: FAKE_MODEL,
    parentEvidenceDir: path.join(tmp.dir, "evidence", "subagent-test"),
    charge: () => {},
    audit: () => {},
    ...overrides,
  };
}

const CHILD_SUMMARY = async (): Promise<string> =>
  JSON.stringify({
    current_objective: "read the workspace",
    user_constraints: [],
    key_decisions: [],
    completed_work: ["read big.txt"],
    current_state: [],
    pending_work: [],
    important_facts: [],
  });

const EXPLORE_CALL = {
  type: "toolCall",
  id: "p-explore",
  name: "explore",
  arguments: { task: "read note.txt and report" },
} as const;

describe("explore subagent (Phase 1)", () => {
  it("runs a read-only child agent and returns its final answer as the tool result", async () => {
    tmp.enter();
    fs.writeFileSync(path.join(tmp.dir, "note.txt"), "hello explore", "utf8");
    const captured: { caller: "parent" | "child"; context: TranscriptContext }[] = [];
    const audit: HarnessAuditEvent[] = [];
    const streamFn = parentChildStream(
      {
        parent: [assistantMsg([EXPLORE_CALL]), assistantMsg([{ type: "text", text: "parent done" }], "stop")],
        child: [assistantMsg([{ type: "text", text: "The note says: hello explore" }], "stop")],
      },
      captured,
    );
    const manager = new RunManager();
    const result = await manager.run({
      task: "use the explorer",
      model: FAKE_MODEL,
      streamFn,
      reporter: new CollectingReporter(),
      tools: [createExploreTool(exploreDeps({ streamFn, audit: (e) => audit.push(e) }))],
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    const exploreResult = result.messages.find(
      (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "explore",
    );
    expect(JSON.stringify(exploreResult)).toContain("The note says: hello explore");
    expect(JSON.stringify(exploreResult)).toContain("[subagent transcript:");

    // The child ran with the restricted readonly toolset — no explore (no
    // recursion), no shell, no write path.
    const childContexts = captured.filter((c) => c.caller === "child");
    expect(childContexts.length).toBeGreaterThanOrEqual(1);
    for (const { context } of childContexts) {
      const json = JSON.stringify(context);
      expect(json).toContain('"grep"');
      expect(json).not.toContain('"explore"');
      expect(json).not.toContain('"powershell"');
      expect(json).not.toContain('"write"');
    }
    // The parent saw the explore tool declared, not the child's reads.
    const parentContexts = captured.filter((c) => c.caller === "parent");
    expect(JSON.stringify(parentContexts[0]!.context)).toContain('"explore"');

    // Subagent accounting landed on the audit channel.
    const starts = audit.filter((e) => e.type === "subagent_start");
    const ends = audit.filter((e) => e.type === "subagent_end");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ task: "read note.txt and report", tools: [...EXPLORE_CHILD_TOOLS] });
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ status: "completed", turns: 1 });
    tmp.leave();
  });

  it("charges the child's usage onto the parent's token fuse", async () => {
    tmp.enter();
    fs.writeFileSync(path.join(tmp.dir, "note.txt"), "hello explore", "utf8");
    const captured: { caller: "parent" | "child"; context: TranscriptContext }[] = [];
    const charged: number[] = [];
    const streamFn = parentChildStream(
      {
        parent: [
          assistantMsg([EXPLORE_CALL]),
          assistantMsg([{ type: "toolCall", id: "p-read", name: "read_file", arguments: { path: "note.txt" } }]),
        ],
        child: [assistantMsg([{ type: "text", text: "child answer" }], "stop")],
      },
      captured,
    );
    const manager = new RunManager();
    // Child (15, charged) + parent turn 1 (15) = 30 > 20 → the read_file gate denies.
    const result = await manager.run({
      task: "trip the fuse",
      model: FAKE_MODEL,
      streamFn,
      reporter: new CollectingReporter(),
      tools: [createExploreTool(exploreDeps({ streamFn, charge: (u) => charged.push(u.totalTokens) })), readFileTool],
      limits: { maxTotalTokens: 20 },
    });
    manager.close();

    expect(charged).toEqual([15]); // the child's spend reached the parent's fuse
    expect(result.record.status).toBe("failed");
    expect(result.record.error).toMatch(/token budget/);
    tmp.leave();
  });

  it("planRecovery re-executes a crashed explore (replay: safe)", async () => {
    const tool = createExploreTool(exploreDeps());
    const action = planRecovery({
      toolCallId: "c1",
      toolName: "explore",
      tool,
      state: "executing",
    } as never);
    expect(action.kind).toBe("reexecute");
  });

  it("per-tool timeout override: timeoutMs wins over the run-wide default", async () => {
    tmp.enter();
    const slow = {
      name: "slow",
      label: "slow",
      description: "slow",
      parameters: { type: "object", properties: {} } as never,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { content: [{ type: "text", text: "done" }], details: undefined };
      },
    };
    // Run-wide default is generous (120s); the tool's own 80ms override fires.
    const [wrapped] = withToolTimeout([{ ...slow, timeoutMs: 80, replay: "safe" }] as never, 120_000);
    await expect(wrapped!.execute("t1", {})).rejects.toBeInstanceOf(ToolTimeoutError);
    tmp.leave();
  });

  it("child context management compacts the child, never the parent", async () => {
    tmp.enter();
    fs.writeFileSync(path.join(tmp.dir, "big.txt"), "b".repeat(2500), "utf8");
    const captured: { caller: "parent" | "child"; context: TranscriptContext }[] = [];
    const smallWindow = { ...FAKE_MODEL, contextWindow: 300 };
    const streamFn = parentChildStream(
      {
        parent: [assistantMsg([EXPLORE_CALL]), assistantMsg([{ type: "text", text: "parent done" }], "stop")],
        child: [
          assistantMsg([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "big.txt" } }]),
          assistantMsg([{ type: "toolCall", id: "c2", name: "read", arguments: { path: "big.txt" } }]),
          assistantMsg([{ type: "toolCall", id: "c3", name: "read", arguments: { path: "big.txt" } }]),
          assistantMsg([{ type: "text", text: "child summarized its reads" }], "stop"),
        ],
      },
      captured,
    );
    const manager = new RunManager();
    const result = await manager.run({
      task: "explore with a tiny window",
      model: smallWindow,
      streamFn,
      reporter: new CollectingReporter(),
      tools: [
        createExploreTool({
          ...exploreDeps({ model: smallWindow, streamFn }),
          summaryChat: CHILD_SUMMARY,
        }),
      ],
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    const childContexts = captured.filter((c) => c.caller === "child").map((c) => JSON.stringify(c.context));
    const parentContexts = captured.filter((c) => c.caller === "parent").map((c) => JSON.stringify(c.context));
    expect(childContexts.some((c) => c.includes("<context-summary>"))).toBe(true);
    expect(parentContexts.every((c) => !c.includes("<context-summary>"))).toBe(true);
    tmp.leave();
  });

  it("the child toolset cannot recurse or escape readonly", () => {
    const withExplore = createCodingToolset(undefined, { explore: exploreDeps() });
    expect(withExplore.map((t) => t.name)).toContain("explore");
    // The child's readonly set mirrors pi's canonical createReadOnlyTools —
    // the two lists may not drift apart.
    const piReadonly = createReadOnlyTools(process.cwd())
      .map((t) => t.name)
      .sort();
    expect([...EXPLORE_CHILD_TOOLS].sort()).toEqual(piReadonly);
    const child = withExplore.filter((t) => (EXPLORE_CHILD_TOOLS as readonly string[]).includes(t.name));
    const names = child.map((t) => t.name);
    expect(names).toEqual([...EXPLORE_CHILD_TOOLS]);
    expect(names).not.toContain("explore");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("powershell");
    expect(names).not.toContain("write");
    expect(permissionsFor("explore")).toEqual({ capabilities: ["fs:read"], risk: "readonly" });
  });

  it("a failed child surfaces an error result to the parent model", async () => {
    tmp.enter();
    const captured: { caller: "parent" | "child"; context: TranscriptContext }[] = [];
    const audit: HarnessAuditEvent[] = [];
    const streamFn = parentChildStream(
      {
        parent: [assistantMsg([EXPLORE_CALL]), assistantMsg([{ type: "text", text: "recovered anyway" }], "stop")],
        child: [
          assistantMsg([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "big.txt" } }]),
          assistantMsg([{ type: "toolCall", id: "c2", name: "read", arguments: { path: "big.txt" } }]),
          assistantMsg([{ type: "toolCall", id: "c3", name: "read", arguments: { path: "big.txt" } }]),
          assistantMsg([{ type: "toolCall", id: "c4", name: "read", arguments: { path: "big.txt" } }]),
          assistantMsg([{ type: "toolCall", id: "c5", name: "read", arguments: { path: "big.txt" } }]),
        ],
      },
      captured,
    );
    const manager = new RunManager();
    const result = await manager.run({
      task: "child hits its turn budget",
      model: FAKE_MODEL,
      streamFn,
      reporter: new CollectingReporter(),
      tools: [
        createExploreTool({
          ...exploreDeps({ streamFn, limits: { maxTurns: 2, maxToolCalls: 3 } }),
          audit: (e) => audit.push(e),
        }),
      ],
    });
    manager.close();

    expect(result.record.status).toBe("completed"); // the PARENT survives a failed child
    const exploreResult = result.messages.find(
      (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "explore",
    );
    expect(JSON.stringify(exploreResult)).toMatch(/explore subagent failed/i);
    expect(audit.filter((e) => e.type === "subagent_end").at(-1)).toMatchObject({ status: "failed" });
    tmp.leave();
  });

  it("E2E: a kill mid-subagent re-executes the whole child on resume", async () => {
    tmp.enter();
    const ws = path.join(tmp.dir, "e2e-explore");
    fs.mkdirSync(ws, { recursive: true });
    const dbPath = path.join(ws, "harness.db");
    const driver = path.join(PACKAGE_ROOT, "scripts", "chaos-driver.mjs");
    const dist = path.join(PACKAGE_ROOT, "dist", "index.js");
    if (!fs.existsSync(dist)) {
      // The E2E needs a build; skip when dist is absent (documented pattern).
      return;
    }
    const { spawn } = await import("node:child_process");
    const spawnDriver = (args: string[]) => {
      const child = spawn(process.execPath, [driver, ...args], {
        cwd: ws,
        env: { ...process.env, CHAOS_EPISODE: "explore" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (c) => (out += String(c)));
      child.stderr?.on("data", (c) => (out += String(c)));
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`driver timeout: ${out.slice(0, 400)}`));
        }, 30_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
      });
    };

    const killCode = await spawnDriver(["run", dbPath, "mid_tool_execution:explore"]);
    expect(killCode).toBe(137);

    const { openDatabase } = await import("../src/storage/db.js");
    const { RunRepo } = await import("../src/storage/repos/runs.js");
    const { TraceEventRepo } = await import("../src/storage/repos/trace-events.js");
    const db = openDatabase(dbPath);
    let runId: string;
    try {
      runId = new RunRepo(db).getByStatus("running")[0]!.id;
      // The crash left the explore call mid-execution (started, never ended —
      // the driver's audit channel is a noop, so no subagent_* events here).
      const events = new TraceEventRepo(db).getByRun(runId);
      const types = events.map((e) => e.type);
      const exploreStart = events.find(
        (e) => e.type === "tool_execution_start" && (e as { toolName?: string }).toolName === "explore",
      );
      expect(exploreStart).toBeDefined();
      expect(types).not.toContain("run_end");
      expect(types).not.toContain("tool_execution_end");
    } finally {
      db.close();
    }

    const resumeCode = await spawnDriver(["resume", runId, dbPath]);
    expect(resumeCode).toBe(0);

    const db2 = openDatabase(dbPath);
    try {
      const events = new TraceEventRepo(db2).getByRun(runId);
      expect(new RunRepo(db2).get(runId)?.status).toBe("completed");
      // The child ran TWICE: once before the kill, once re-executed on resume —
      // the resumed run's explore result carries the child's actual answer.
      const exploreEnds = events.filter(
        (e) => e.type === "tool_execution_end" && (e as { toolName?: string }).toolName === "explore",
      ) as { result?: { content?: { text?: string }[] } }[];
      expect(exploreEnds).toHaveLength(1);
      expect(JSON.stringify(exploreEnds[0]!.result?.content)).toContain("explored: hello explore");
      const lastAssistant = [...events]
        .reverse()
        .find(
          (e) => e.type === "message_end" && (e as { message?: { role?: string } }).message?.role === "assistant",
        ) as { message?: { content?: { text?: string }[] } } | undefined;
      expect(JSON.stringify(lastAssistant?.message?.content)).toContain("parent done");
    } finally {
      db2.close();
    }
    tmp.leave();
  }, 60_000);
});
