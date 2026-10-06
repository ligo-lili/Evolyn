import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { TuiReporter } from "../src/modes/interactive/tui-reporter.js";
import type { ChatView } from "../src/modes/interactive/view.js";
import { assistantMessage } from "./helpers.js";

/** Recording ChatView: captures the call sequence for headless mapping tests. */
class RecordingView implements ChatView {
  readonly calls: string[] = [];

  private mark(name: string, detail?: string): void {
    this.calls.push(detail === undefined ? name : `${name}:${detail}`);
  }

  addUserMessage(text: string): void {
    this.mark("addUserMessage", text);
  }
  beginAssistant(): void {
    this.mark("beginAssistant");
  }
  appendAssistantText(delta: string): void {
    this.mark("text", delta);
  }
  appendAssistantThinking(delta: string): void {
    this.mark("thinking", delta);
  }
  endAssistantMessage(message: AssistantMessage): void {
    const text = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    this.mark("endAssistant", text);
  }
  addAssistantMessage(text: string): void {
    this.mark("addAssistant", text);
  }
  beginTool(toolCallId: string, toolName: string): void {
    this.mark("beginTool", `${toolCallId}:${toolName}`);
  }
  updateTool(toolCallId: string): void {
    this.mark("updateTool", toolCallId);
  }
  endTool(toolCallId: string, _result: unknown, isError: boolean): void {
    this.mark("endTool", `${toolCallId}:${isError ? "error" : "ok"}`);
  }
  showWorking(label: string): void {
    this.mark("showWorking", label);
  }
  hideWorking(): void {
    this.mark("hideWorking");
  }
  info(text: string): void {
    this.mark("info", text);
  }
  error(text: string): void {
    this.mark("error", text);
  }
}

const assistant = assistantMessage([{ type: "text", text: "hello!" }], "stop");

function userMessageEnd(text: string): AgentEvent {
  return {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  } as AgentEvent;
}

function textDelta(delta: string): AgentEvent {
  const event: AssistantMessageEvent = {
    type: "text_delta",
    contentIndex: 0,
    delta,
    partial: assistant,
  };
  return { type: "message_update", message: assistant, assistantMessageEvent: event };
}

describe("TuiReporter — AgentEvent → ChatView mapping", () => {
  it("maps a full turn: working indicator, user echo, streaming deltas, tool lifecycle", () => {
    const view = new RecordingView();
    const reporter = new TuiReporter(view);

    reporter.onEvent({ type: "agent_start" });
    reporter.onEvent(userMessageEnd("fix the bug"));
    reporter.onEvent({ type: "message_start", message: assistant });
    reporter.onEvent(textDelta("hel"));
    reporter.onEvent(textDelta("lo!"));
    reporter.onEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    reporter.onEvent({
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "bash",
      args: {},
      partialResult: { content: [{ type: "text", text: "running…" }] },
    });
    reporter.onEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "3 passed" }] },
      isError: false,
    });
    reporter.onEvent({ type: "message_end", message: assistant });
    reporter.onEvent({ type: "agent_end", messages: [] });

    expect(view.calls).toEqual([
      "showWorking:thinking…",
      "addUserMessage:fix the bug",
      "beginAssistant",
      "text:hel",
      "text:lo!",
      "showWorking:running bash…",
      "beginTool:call_1:bash",
      "updateTool:call_1",
      "endTool:call_1:ok",
      "endAssistant:hello!",
      "hideWorking",
    ]);
  });

  it("toolResult message_end events are ignored (the tool card already rendered)", () => {
    const view = new RecordingView();
    const reporter = new TuiReporter(view);
    reporter.onEvent({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "output" }],
        isError: false,
        timestamp: Date.now(),
      },
    } as AgentEvent);
    expect(view.calls).toEqual([]);
  });

  it("thinking deltas render through the thinking channel", () => {
    const view = new RecordingView();
    const reporter = new TuiReporter(view);
    const event: AssistantMessageEvent = {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "pondering",
      partial: assistant,
    };
    reporter.onEvent({ type: "message_update", message: assistant, assistantMessageEvent: event });
    expect(view.calls).toEqual(["thinking:pondering"]);
  });
});
