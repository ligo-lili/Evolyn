import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RunReporter } from "../../runtime/reporter.js";
import type { ChatView } from "./view.js";

/**
 * Maps the agent event stream onto the ChatView. This is the ONLY place that
 * interprets pi's AgentEvent union for the UI — the view stays dumb, so the
 * mapping is unit-testable headlessly (tests drive a recording view).
 */
export class TuiReporter implements RunReporter {
  constructor(private readonly view: ChatView) {}

  onEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.view.showWorking("thinking…");
        break;
      case "message_start":
        if (event.message.role === "assistant") this.view.beginAssistant();
        break;
      case "message_update": {
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent.type === "text_delta") this.view.appendAssistantText(streamEvent.delta);
        else if (streamEvent.type === "thinking_delta") this.view.appendAssistantThinking(streamEvent.delta);
        break;
      }
      case "message_end": {
        const message = event.message;
        if (message.role === "assistant") this.view.endAssistantMessage(message);
        else if (message.role === "user") {
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((b): b is { type: "text"; text: string } => b.type === "text")
                  .map((b) => b.text)
                  .join("");
          this.view.addUserMessage(text);
        }
        // toolResult message_end: already rendered by the tool card.
        break;
      }
      case "tool_execution_start":
        this.view.showWorking(`running ${event.toolName}…`);
        this.view.beginTool(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_update":
        this.view.updateTool(event.toolCallId, event.partialResult);
        break;
      case "tool_execution_end":
        this.view.endTool(event.toolCallId, event.result, event.isError);
        break;
      case "agent_end":
        this.view.hideWorking();
        break;
      default:
        break;
    }
  }
}
