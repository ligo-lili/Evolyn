import type { ParsedTrace } from "./read.js";
import type { ReplayState } from "./replay.js";
import type { TraceSummary } from "./query.js";

function stamp(ev: { seq: number; ts: string }): string {
  return `#${String(ev.seq).padStart(4, " ")} ${ev.ts.slice(11, 23)}`;
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * Human-readable timeline for a run. Compact mode keeps assistant messages,
 * tool calls/results and lifecycle events; --all additionally prints every
 * other recorded event (streaming deltas, queue updates, …).
 */
export function renderTimeline(parsed: ParsedTrace, options: { all?: boolean } = {}): string {
  const lines: string[] = [];
  const start = parsed.events[0];
  if (!start || start.type !== "run_start") {
    return "(corrupt trace: first event is not run_start)";
  }
  lines.push(`run ${parsed.runId}  model=${start.modelSpec}`);
  lines.push(`  task: ${start.task}`);

  for (const ev of parsed.events) {
    switch (ev.type) {
      case "run_start":
        continue;
      case "run_end":
        lines.push(
          `  ${stamp(ev)}  run_end status=${ev.status} duration=${(ev.durationMs / 1000).toFixed(1)}s` +
            (ev.error ? ` error="${ev.error}"` : ""),
        );
        continue;
      case "message_end": {
        const m = ev.message;
        if (m.role === "assistant") {
          const text = textOf(m.content);
          if (text.trim()) lines.push(`  ${stamp(ev)}  assistant: ${clip(text)}`);
          for (const block of m.content) {
            if (block.type === "toolCall") {
              lines.push(`  ${stamp(ev)}  tool_call ${block.name} ${clip(JSON.stringify(block.arguments))}`);
            }
          }
          lines.push(
            `  ${stamp(ev)}  assistant_end stopReason=${m.stopReason}` +
              (m.usage ? ` tokens in=${m.usage.input} out=${m.usage.output}` : "") +
              (m.errorMessage ? ` error="${m.errorMessage}"` : ""),
          );
        } else if (m.role === "toolResult") {
          lines.push(
            `  ${stamp(ev)}  tool_result ${m.toolName}${m.isError ? " (ERROR)" : ""}: ${clip(textOf(m.content))}`,
          );
        } else if (options.all) {
          const raw: unknown = "content" in m ? m.content : undefined;
          const text = Array.isArray(raw) ? clip(textOf(raw as readonly { type: string; text?: string }[])) : "";
          lines.push(`  ${stamp(ev)}  ${m.role}: ${text}`);
        }
        continue;
      }
      case "tool_execution_start":
        lines.push(`  ${stamp(ev)}  exec ${ev.toolName} ${clip(JSON.stringify(ev.args))}`);
        continue;
      case "tool_execution_end":
        lines.push(`  ${stamp(ev)}  exec_done ${ev.toolName}${ev.isError ? " (ERROR)" : ""}`);
        continue;
      case "permission":
        lines.push(
          `  ${stamp(ev)}  permission ${ev.decision} ${ev.risk} ${ev.toolName}${ev.reason ? ` (${ev.reason})` : ""}`,
        );
        continue;
      case "recovery_action":
        lines.push(`  ${stamp(ev)}  recovery ${ev.action} ${ev.toolName}${ev.error ? ` "${clip(ev.error, 80)}"` : ""}`);
        continue;
      case "compaction":
        lines.push(
          `  ${stamp(ev)}  compaction (${ev.trigger}) tokens=${ev.tokensBefore} cut=@${ev.cutIndex} summary=${ev.summaryChars} chars`,
        );
        continue;
      default:
        if (options.all) lines.push(`  ${stamp(ev)}  ${ev.type}`);
    }
  }
  return lines.join("\n");
}

export function renderSummary(s: TraceSummary): string {
  const lines: string[] = [];
  lines.push(`run ${s.runId}  model=${s.modelSpec}${s.fault ? `  fault=${s.fault}` : ""}`);
  lines.push(`  task: ${s.task}`);
  lines.push(
    `  status: ${s.status ?? "(interrupted — no run_end)"}` +
      (s.durationMs !== undefined ? `  duration=${(s.durationMs / 1000).toFixed(1)}s` : ""),
  );
  lines.push(`  events: ${s.eventCount}  assistant turns: ${s.assistantTurns}`);
  for (const t of s.toolCalls) {
    lines.push(`  tool ${t.toolName}: ${t.calls} call(s)${t.errors ? `, ${t.errors} error(s)` : ""}`);
  }
  if (s.toolCalls.length === 0) lines.push("  tools: (none)");
  lines.push(
    `  tokens: in=${s.tokens.input} out=${s.tokens.output} total=${s.tokens.total} cost=$${s.tokens.cost.toFixed(4)}`,
  );
  lines.push(
    `  errors: ${s.errorCount}  permission denials: ${s.permissionDenials}  recovery actions: ${s.recoveryActions}`,
  );
  return lines.join("\n");
}

export function renderReplay(state: ReplayState, why: string[]): string {
  const lines: string[] = [];
  lines.push(`replay @seq ${state.seq} (${state.consumed} events consumed)  run ${state.runId ?? "?"}`);
  if (state.task) lines.push(`  task: ${state.task}`);
  if (state.modelSpec) lines.push(`  model: ${state.modelSpec}${state.fault ? `  fault: ${state.fault}` : ""}`);
  lines.push(`  transcript (${state.messages.length} msgs):`);
  const shown = state.messages.slice(-6);
  const shownSeqs = state.messageSeqs.slice(-6);
  shown.forEach((m, i) => {
    const raw: unknown = "content" in m ? m.content : undefined;
    const text = Array.isArray(raw)
      ? clip(textOf(raw as readonly { type: string; text?: string }[]))
      : typeof raw === "string"
        ? clip(raw)
        : "";
    const seq = shownSeqs[i] ?? "?";
    if (m.role === "assistant") {
      const calls = m.content.filter((b) => b.type === "toolCall");
      lines.push(`    #${seq} assistant: ${clip(text) || "(tool call only)"}`);
      for (const c of calls)
        if (c.type === "toolCall") lines.push(`    #${seq}   → ${c.name} ${clip(JSON.stringify(c.arguments), 100)}`);
    } else if (m.role === "toolResult") {
      lines.push(`    #${seq} toolResult [${m.toolName}]${m.isError ? " (ERROR)" : ""}: ${clip(text, 120)}`);
    } else if (m.role === "user") {
      lines.push(`    #${seq} user: ${clip(text)}`);
    } else if (m.role === "system") {
      lines.push(`    #${seq} system`);
    }
  });
  const pending = [...state.calls.values()].filter((c) => !c.resolved);
  if (pending.length > 0) {
    lines.push(`  in-flight calls:`);
    for (const c of pending) lines.push(`    ${c.toolCallId} ${c.toolName} state=${c.state}`);
  }
  lines.push("  why:");
  for (const w of why) lines.push(`    - ${w}`);
  return lines.join("\n");
}
