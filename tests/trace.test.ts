import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { readTraceFile } from "../src/trace/read.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";

const tmp = makeTempCwd();

afterEach(() => {
  tmp.leave();
});

function writeHelloSteps(): AssistantMessage[] {
  return [
    assistantMessage(
      [
        {
          type: "toolCall",
          id: "call_1",
          name: "write_file",
          arguments: { path: "out/hello.txt", content: "hello harness" },
        },
      ],
      "toolUse",
    ),
    assistantMessage([{ type: "text", text: "done: wrote out/hello.txt" }], "stop"),
  ];
}

describe("TraceRecorder", () => {
  it("records a complete, schema-valid trace for a scripted run", async () => {
    tmp.enter();
    const manager = new RunManager();
    const reporter = new CollectingReporter();

    const result = await manager.run({
      task: "write out/hello.txt",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(writeHelloSteps()),
      reporter,
    });

    expect(result.record.status).toBe("completed");
    expect(result.tracePath).toBeTruthy();
    const tracePath = result.tracePath as string;
    expect(tracePath).toContain(path.join(".harness", "traces"));
    expect(fs.existsSync(tracePath)).toBe(true);

    const parsed = readTraceFile(tracePath);
    expect(parsed.runId).toBe(result.record.id);

    const [first, last] = [parsed.events[0], parsed.events.at(-1)];
    expect(first).toMatchObject({ type: "run_start", task: "write out/hello.txt", modelSpec: "test/fake-model" });
    expect(last).toMatchObject({ type: "run_end", status: "completed" });

    // Envelope: versioned, monotonic seq, consistent runId.
    expect(parsed.events.map((e) => e.seq)).toEqual(parsed.events.map((_, i) => i + 1));
    for (const ev of parsed.events) {
      expect(ev.v).toBe(1);
      expect(typeof ev.ts).toBe("string");
      expect(ev.runId).toBe(result.record.id);
    }

    // Agent events flow through: the tool call and its result are in the log.
    expect(parsed.events.some((e) => e.type === "tool_execution_start" && e.toolName === "write_file")).toBe(true);
    const toolEnds = parsed.events.filter((e) => e.type === "tool_execution_end");
    expect(toolEnds).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmp.dir, "out", "hello.txt"), "utf8")).toBe("hello harness");
    manager.close(); // release the default SQLite connection before tmp cleanup
  });

  it("tolerates a seq gap (a failed sink leaves a hole; 加固期 P0) but still rejects reordering", () => {
    tmp.enter();
    const gap = path.join(tmp.dir, "gap.jsonl");
    fs.writeFileSync(
      gap,
      [
        JSON.stringify({ v: 1, seq: 1, ts: "t", runId: "r1", type: "run_start", task: "t", modelSpec: "m" }),
        JSON.stringify({ v: 1, seq: 3, ts: "t", runId: "r1", type: "run_end", status: "completed", durationMs: 1 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const parsed = readTraceFile(gap);
    expect(parsed.events.map((e) => e.seq)).toEqual([1, 3]);

    const reordered = path.join(tmp.dir, "reordered.jsonl");
    fs.writeFileSync(
      reordered,
      [
        JSON.stringify({ v: 1, seq: 2, ts: "t", runId: "r1", type: "run_start", task: "t", modelSpec: "m" }),
        JSON.stringify({ v: 1, seq: 2, ts: "t", runId: "r1", type: "run_end", status: "completed", durationMs: 1 }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(() => readTraceFile(reordered)).toThrow(/reorder or duplicate/);
  });

  it("detects a truncated trace (killed before run_end)", () => {
    tmp.enter();
    const file = path.join(tmp.dir, "truncated.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({ v: 1, seq: 1, ts: "t", runId: "r1", type: "run_start", task: "t", modelSpec: "m" }) + "\n",
      "utf8",
    );
    expect(() => readTraceFile(file)).toThrow(/run_end/);
  });
});
