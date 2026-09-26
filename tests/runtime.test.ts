import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { readFileTool } from "../src/runtime/tools/read-file.js";
import { sendNotificationTool } from "../src/runtime/tools/send-notification.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";

const tmp = makeTempCwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

describe("RunManager (fake StreamFn, no API key)", () => {
  it("runs a scripted task end to end: prompt → tool call → tool result → final answer", async () => {
    const steps = [
      assistantMessage(
        [{ type: "toolCall", id: "call_1", name: "write_file", arguments: { path: "out/hello.txt", content: "hello harness" } }],
        "toolUse",
      ),
      assistantMessage([{ type: "text", text: "done: wrote out/hello.txt" }], "stop"),
    ];
    const reporter = new CollectingReporter();
    const manager = new RunManager();

    const result = await manager.run({
      task: "write out/hello.txt with 'hello harness', then tell me when done",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(steps),
      reporter,
    });

    expect(result.record.status).toBe("completed");
    expect(result.record.error).toBeUndefined();
    expect(fs.readFileSync(path.join(tmp.dir, "out", "hello.txt"), "utf8")).toBe("hello harness");

    // The Agent synthesizes a leading system message from systemPrompt + tools.
    expect(result.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
    const last = result.messages.at(-1);
    expect(last?.role).toBe("assistant");
    if (last?.role === "assistant") {
      expect(last.content.some((b) => b.type === "text" && b.text.includes("done"))).toBe(true);
    }

    expect(reporter.of("tool_execution_start").map((e) => ("toolName" in e ? e.toolName : ""))).toEqual(["write_file"]);
    expect(result.usage?.totalTokens).toBe(2 * 15);
    manager.close(); // release the default SQLite connection before tmp cleanup
  });

  it("marks the run failed when the model surfaces an error", async () => {
    const failed = assistantMessage([{ type: "text", text: "" }], "error", "boom");
    const manager = new RunManager();
    const streamFn = () => {
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: failed });
      stream.push({ type: "error", reason: "error", error: failed });
      return stream;
    };

    const result = await manager.run({ task: "anything", model: FAKE_MODEL, streamFn });

    expect(result.record.status).toBe("failed");
    expect(result.record.error).toBe("boom");
    manager.close();
  });
});

describe("demo tools", () => {
  it("send_notification is deliberately non-idempotent: each call appends a new receipt", async () => {
    const first = await sendNotificationTool.execute("t1", { channel: "email", message: "hi" });
    const second = await sendNotificationTool.execute("t2", { channel: "email", message: "hi" });
    expect(first.details.receiptId).not.toBe(second.details.receiptId);
    const log = fs.readFileSync(path.join(tmp.dir, ".harness", "notifications.log"), "utf8");
    expect(log.trim().split("\n")).toHaveLength(2);
  });

  it("read_file refuses paths outside the workspace root", async () => {
    await expect(readFileTool.execute("t3", { path: "../secrets.txt" })).rejects.toThrow(/escapes workspace root/);
  });
});
