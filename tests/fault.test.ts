import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyFaultToTools, FaultController, parseFaultSpec } from "../src/execution/fault.js";
import { sendNotificationTool } from "../src/runtime/tools/send-notification.js";
import { makeTempCwd } from "./helpers.js";

const tmp = makeTempCwd();

afterEach(() => tmp.leave());

describe("fault injection (阶段 5)", () => {
  it("parses fault specs", () => {
    expect(parseFaultSpec(undefined)).toBeUndefined();
    expect(parseFaultSpec("after_tool_call:send_notification")).toEqual({ point: "after_tool_call", toolName: "send_notification" });
    expect(() => parseFaultSpec("nope:tool")).toThrow(/unknown fault point/);
    expect(() => parseFaultSpec("after_tool_call:")).toThrow(/tool name/);
  });

  it("mid_tool_execution: side effect lands, then kill fires before the result is used", async () => {
    tmp.enter();
    const kills: string[] = [];
    const wrapped = applyFaultToTools(
      [sendNotificationTool],
      { point: "mid_tool_execution", toolName: "send_notification" },
      () => kills.push("kill"),
    );

    const result = await wrapped[0]!.execute("t1", { channel: "email", message: "deploy done" });

    expect(result.details.receiptId).toBeTruthy();
    expect(kills).toEqual(["kill"]);
    const log = fs.readFileSync(path.join(tmp.dir, ".harness", "notifications.log"), "utf8");
    expect(log).toContain("deploy done");
    tmp.leave();
  });

  it("leaves non-matching tools untouched", () => {
    const wrapped = applyFaultToTools([sendNotificationTool], { point: "mid_tool_execution", toolName: "read_file" }, () => {});
    expect(wrapped[0]).toBe(sendNotificationTool);
  });

  it("FaultController fires only on the matching tool_execution_end", () => {
    const kills: string[] = [];
    const controller = new FaultController({ point: "after_tool_call", toolName: "send_notification" }, () => kills.push("k"));

    controller.onEvent({ type: "tool_execution_end", toolCallId: "1", toolName: "read_file", result: { content: [], details: undefined }, isError: false });
    expect(kills).toEqual([]);

    controller.onEvent({ type: "tool_execution_end", toolCallId: "2", toolName: "send_notification", result: { content: [], details: undefined }, isError: false });
    expect(kills).toEqual(["k"]);
  });
});
