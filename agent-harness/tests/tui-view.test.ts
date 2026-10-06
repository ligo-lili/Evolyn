import { describe, expect, it } from "vitest";
import { Container, type TUI } from "@earendil-works/pi-tui";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { TuiReporter } from "../src/modes/interactive/tui-reporter.js";
import { TuiChatView } from "../src/modes/interactive/tui-view.js";
import { assistantMessage } from "./helpers.js";

/**
 * Headless rendering smoke: TuiChatView drives real pi-tui components with a
 * no-op TUI (requestRender stub) — no terminal needed. It verifies the full
 * event→component→rendered-text path, which the pure mapping test
 * (tui-reporter.test.ts) cannot.
 */

const fakeTui = { requestRender: () => {} } as unknown as TUI;

const assistant = assistantMessage([{ type: "text", text: "Fixed the bug." }], "stop");

function userMessageEnd(text: string): AgentEvent {
  return {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  } as AgentEvent;
}

describe("TuiChatView — headless render smoke", () => {
  it("renders a full turn: user echo, assistant markdown, tool card", () => {
    const transcript = new Container();
    const status = new Container();
    const view = new TuiChatView(transcript, status, fakeTui);
    const reporter = new TuiReporter(view);

    reporter.onEvent({ type: "agent_start" });
    reporter.onEvent(userMessageEnd("fix the bug in src/a.ts"));
    reporter.onEvent({ type: "message_start", message: assistant });
    reporter.onEvent({ type: "message_end", message: assistant });
    reporter.onEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "edit",
      args: { path: "src/a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
    });
    reporter.onEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "edited src/a.ts" }],
        details: { diff: "- const a = 1;\n+ const a = 2;" },
      },
      isError: false,
    });
    reporter.onEvent({ type: "agent_end", messages: [] });

    const rendered = transcript.render(100).join("\n");
    expect(rendered).toContain("fix the bug in src/a.ts");
    expect(rendered).toContain("Fixed the bug.");
    expect(rendered).toContain("edit src/a.ts");
    // The diff body rendered (removed line visible).
    expect(rendered).toContain("const a = 1;");
    // The working loader is gone after agent_end.
    expect(status.render(100).join("\n").trim()).toBe("");
  });

  it("showWorking mounts the loader into the status container; hideWorking removes it", () => {
    const transcript = new Container();
    const status = new Container();
    const view = new TuiChatView(transcript, status, fakeTui);

    view.showWorking("thinking…");
    expect(status.render(100).join("\n")).toContain("thinking…");
    view.hideWorking();
    expect(status.render(100).join("\n").trim()).toBe("");
  });

  it("steering-injected user messages render through the same path", () => {
    const transcript = new Container();
    const status = new Container();
    const view = new TuiChatView(transcript, status, fakeTui);
    view.addUserMessage("actually, stop");
    expect(transcript.render(100).join("\n")).toContain("actually, stop");
  });
});
