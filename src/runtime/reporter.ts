import type { AgentEvent } from "@earendil-works/pi-agent-core";

export interface RunReporter {
  onEvent(event: AgentEvent): void;
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function snippet(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** Human-facing console output for a run. */
export class ConsoleReporter implements RunReporter {
  onEvent(event: AgentEvent): void {
    switch (event.type) {
      case "tool_execution_start":
        console.log(`→ ${event.toolName} ${snippet(JSON.stringify(event.args))}`);
        break;
      case "message_end": {
        const m = event.message;
        if (m.role === "assistant") {
          const text = textOf(m.content);
          if (text.trim()) console.log(`\nassistant: ${text.trim()}`);
          if (m.errorMessage) console.error(`assistant error: ${m.errorMessage}`);
        } else if (m.role === "toolResult") {
          console.log(`  [${m.toolName}] ${snippet(textOf(m.content))}${m.isError ? " (error)" : ""}`);
        }
        break;
      }
      default:
        break;
    }
  }
}

/** Silent reporter that records every event; used by tests and later by the Trace recorder. */
export class CollectingReporter implements RunReporter {
  readonly events: AgentEvent[] = [];
  onEvent(event: AgentEvent): void {
    this.events.push(event);
  }
  of(type: AgentEvent["type"]): AgentEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}
