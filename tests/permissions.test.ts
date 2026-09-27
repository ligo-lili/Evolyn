import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { readTraceFile } from "../src/trace/read.js";
import { RunManager } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import {
  assessRisk,
  hasAllCapabilities,
  permissionsFor,
  type ApprovalRequest,
} from "../src/runtime/permissions.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";

const tmp = makeTempCwd();

afterEach(() => tmp.leave());

function notificationSteps(): AssistantMessage[] {
  return [
    assistantMessage(
      [{ type: "toolCall", id: "call_n1", name: "send_notification", arguments: { channel: "email", message: "deploy done" } }],
      "toolUse",
    ),
    assistantMessage([{ type: "text", text: "notification handled" }], "stop"),
  ];
}

function permissionEvents(tracePath: string) {
  return readTraceFile(tracePath).events.filter((e) => e.type === "permission");
}

describe("permission model (阶段 9.7)", () => {
  it("static metadata: read-only tool, mutating tool, unknown tool assumes worst case", () => {
    expect(permissionsFor("read_file")).toEqual({ capabilities: ["fs:read"], risk: "readonly" });
    expect(permissionsFor("write_file").risk).toBe("mutating");
    expect(permissionsFor("never_heard_of_it")).toEqual({
      capabilities: ["fs:read", "fs:write", "process:exec", "net:outbound", "notify:send"],
      risk: "destructive",
    });
  });

  it("argument-aware escalation: destructive shell commands raise exec to destructive", () => {
    expect(assessRisk("exec", { command: "echo hello" }).risk).toBe("destructive"); // exec is destructive by default
    const escalated = assessRisk("exec", { command: "rm -rf build/" });
    expect(escalated.risk).toBe("destructive");
    expect(escalated.reasons.join(" ")).toContain("destructive pattern");
    expect(assessRisk("exec", { command: "del /s /q tmp" }).reasons.length).toBeGreaterThan(0);
  });

  it("hasAllCapabilities checks the granted set", () => {
    expect(hasAllCapabilities(["fs:read"], ["fs:read"])).toBe(true);
    expect(hasAllCapabilities(["fs:read"], ["fs:read", "fs:write"])).toBe(false);
  });
});

describe("permission gate on runs (阶段 9.7)", () => {
  it("denies calls whose capabilities are not granted, and the model sees the denial", async () => {
    tmp.enter();
    const manager = new RunManager();
    const result = await manager.run({
      task: "send a notification",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(notificationSteps()),
      reporter: new CollectingReporter(),
      approval: { capabilities: ["fs:read"] }, // notify:send NOT granted
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    expect(fs.existsSync(path.join(tmp.dir, ".harness", "notifications.log"))).toBe(false);

    const toolResult = result.messages.find((m) => m.role === "toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content.some((b) => b.type === "text" && b.text.includes("capabilities not granted"))).toBe(true);
    }

    const events = permissionEvents(result.tracePath as string);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "permission", toolName: "send_notification", decision: "deny", risk: "external" });

    // run_start records the effective capability set (audit requirement)
    const runStart = readTraceFile(result.tracePath as string).events[0]!;
    expect(runStart).toMatchObject({ type: "run_start", capabilities: ["fs:read"] });
  });

  it("least privilege: read_file still works while exec is blocked", async () => {
    tmp.enter();
    fs.writeFileSync(path.join(tmp.dir, "plain.txt"), "contents", "utf8");
    const steps: AssistantMessage[] = [
      assistantMessage([{ type: "toolCall", id: "c_r", name: "read_file", arguments: { path: "plain.txt" } }], "toolUse"),
      assistantMessage([{ type: "toolCall", id: "c_e", name: "exec", arguments: { command: "echo nope" } }], "toolUse"),
      assistantMessage([{ type: "text", text: "done" }], "stop"),
    ];
    const manager = new RunManager();
    const result = await manager.run({
      task: "read a file then run a command",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(steps),
      reporter: new CollectingReporter(),
      approval: { capabilities: ["fs:read", "fs:write"] }, // process:exec NOT granted
    });
    manager.close();

    const toolResults = result.messages.filter((m) => m.role === "toolResult");
    const readOk = toolResults.some((m) => m.role === "toolResult" && m.toolName === "read_file" && !m.isError);
    const execBlocked = toolResults.some((m) => m.role === "toolResult" && m.toolName === "exec" && m.isError);
    expect(readOk).toBe(true);
    expect(execBlocked).toBe(true);

    const events = permissionEvents(result.tracePath as string);
    const byTool = new Map(events.map((e) => [e.toolName, e.decision]));
    expect(byTool.get("read_file")).toBe("allow");
    expect(byTool.get("exec")).toBe("deny");
    tmp.leave();
  });

  it("interactive mode: readonly passes without prompting, destructive asks the approver", async () => {
    tmp.enter();
    fs.writeFileSync(path.join(tmp.dir, "plain.txt"), "contents", "utf8");
    const prompts: ApprovalRequest[] = [];
    const steps: AssistantMessage[] = [
      assistantMessage([{ type: "toolCall", id: "c1", name: "read_file", arguments: { path: "plain.txt" } }], "toolUse"),
      assistantMessage([{ type: "toolCall", id: "c2", name: "exec", arguments: { command: "echo hi" } }], "toolUse"),
      assistantMessage([{ type: "text", text: "done" }], "stop"),
    ];
    const manager = new RunManager();
    const result = await manager.run({
      task: "read then exec",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(steps),
      reporter: new CollectingReporter(),
      approval: {
        mode: "interactive",
        approveFn: async (request) => {
          prompts.push(request);
          return false; // deny everything asked
        },
      },
    });
    manager.close();

    // read_file (readonly) never reached the approver
    expect(prompts.map((p) => p.toolName)).toEqual(["exec"]);
    expect(prompts[0]!.assessment.risk).toBe("destructive");

    const events = permissionEvents(result.tracePath as string);
    const byTool = new Map(events.map((e) => [e.toolName, e.decision]));
    expect(byTool.get("read_file")).toBe("allow");
    expect(byTool.get("exec")).toBe("deny");
    tmp.leave();
  });

  it("interactive approval can grant a destructive call", async () => {
    tmp.enter();
    const manager = new RunManager();
    const result = await manager.run({
      task: "send a notification",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(notificationSteps()),
      reporter: new CollectingReporter(),
      approval: {
        mode: "interactive",
        approveFn: async () => true,
      },
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    expect(fs.readFileSync(path.join(tmp.dir, ".harness", "notifications.log"), "utf8")).toContain("deploy done");
    expect(permissionEvents(result.tracePath as string)[0]).toMatchObject({ decision: "allow", risk: "external" });
    tmp.leave();
  });

  it("auto-deny still blocks non-readonly tools (ported from stage 4)", async () => {
    tmp.enter();
    const manager = new RunManager();
    const result = await manager.run({
      task: "send a notification",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn(notificationSteps()),
      reporter: new CollectingReporter(),
      approval: { mode: "auto-deny" },
    });
    manager.close();

    expect(result.record.status).toBe("completed");
    expect(fs.existsSync(path.join(tmp.dir, ".harness", "notifications.log"))).toBe(false);
    expect(permissionEvents(result.tracePath as string)[0]).toMatchObject({ decision: "deny", risk: "external" });
    tmp.leave();
  });
});
