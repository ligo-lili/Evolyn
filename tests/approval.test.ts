import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { readTraceFile } from "../src/trace/read.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";

const tmp = makeTempCwd();

afterEach(() => tmp.leave());

function notifySteps(): AssistantMessage[] {
  return [
    assistantMessage(
      [{ type: "toolCall", id: "call_n1", name: "send_notification", arguments: { channel: "email", message: "deploy done" } }],
      "toolUse",
    ),
    assistantMessage([{ type: "text", text: "notification handled" }], "stop"),
  ];
}

function approvalEvents(tracePath: string) {
  return readTraceFile(tracePath).events.filter((e) => e.type === "approval");
}

describe("approval hook (阶段 4)", () => {
  it("auto-deny blocks send_notification: model sees the denial, no side effect, audit in trace", async () => {
    tmp.enter();
    const manager = new RunManager();
    const result = await manager.run({
      task: "send a notification",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(notifySteps()),
      reporter: new CollectingReporter(),
      approval: { mode: "auto-deny" },
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    expect(fs.existsSync(path.join(tmp.dir, ".harness", "notifications.log"))).toBe(false);

    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult && toolResult.role === "toolResult" ? toolResult.isError : false).toBe(true);
    if (toolResult?.role === "toolResult") {
      expect(toolResult.content.some((b) => b.type === "text" && b.text.includes("denied by the approval policy"))).toBe(true);
    }

    const events = approvalEvents(result.tracePath as string);
    expect(events).toEqual([{ type: "approval", toolName: "send_notification", decision: "deny", reason: "mode=auto-deny", v: 1, seq: events[0]?.seq, ts: events[0]?.ts, runId: result.record.id }]);
  });

  it("auto-approve delivers and records the allow decision", async () => {
    tmp.enter();
    const manager = new RunManager();
    const result = await manager.run({
      task: "send a notification",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(notifySteps()),
      reporter: new CollectingReporter(),
      approval: { mode: "auto-approve" },
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    const log = fs.readFileSync(path.join(tmp.dir, ".harness", "notifications.log"), "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(approvalEvents(result.tracePath as string)).toHaveLength(1);
  });

  it("always-allowed tools bypass the hook with no audit noise", async () => {
    tmp.enter();
    fs.writeFileSync(path.join(tmp.dir, "plain.txt"), "contents", "utf8");
    const steps: AssistantMessage[] = [
      assistantMessage([{ type: "toolCall", id: "call_r1", name: "read_file", arguments: { path: "plain.txt" } }], "toolUse"),
      assistantMessage([{ type: "text", text: "read it" }], "stop"),
    ];
    const manager = new RunManager();
    const result = await manager.run({
      task: "read a file",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(steps),
      reporter: new CollectingReporter(),
      approval: { mode: "auto-deny" },
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    expect(approvalEvents(result.tracePath as string)).toEqual([]);
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult && toolResult.role === "toolResult" ? toolResult.isError : false).toBe(false);
  });
});
