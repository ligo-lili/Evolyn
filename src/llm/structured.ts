import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { Api, Context, Message, Model, Models, Tool } from "@earendil-works/pi-ai";
import { getModelRegistry } from "../providers.js";

/**
 * 阶段 9.8: structured output with tiered recovery, shared by every harness
 * LLM-extraction call (distiller today; miner / eval-judge later). The MAIN
 * agent loop is NOT a consumer — pi validates tool arguments and feeds errors
 * back to the model there.
 *
 * Pipeline: direct parse → re-prompt with the parse error → constrained
 * decoding fallback (a typebox-schema tool with constrainedSampling, when the
 * provider supports it) → throw (caller applies its own last-resort fallback).
 */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SchemaTool {
  name: string;
  description: string;
  parameters: TSchema;
}

export type ChatFn = (messages: readonly ChatTurn[], opts?: { schemaTool?: SchemaTool }) => Promise<string>;

export interface StructuredOptions<T> {
  prompt: string;
  parse: (raw: string) => T;
  /** Injected chat function (owns the system prompt); default goes through the pi-ai registry. */
  complete: ChatFn;
  maxReprompts?: number;
  /** Optional constrained-decoding fallback tool. */
  schemaTool?: SchemaTool;
}

export interface StructuredResult<T> {
  value: T;
  attempts: number;
  method: "direct" | "reprompt" | "constrained";
}

export function defaultChat(model: Model<Api>, opts: { models?: Models; systemPrompt?: string } = {}): ChatFn {
  const registry = opts.models ?? getModelRegistry();
  return async (messages, chatOpts) => {
    const context: Context = {
      systemPrompt: opts.systemPrompt,
      messages: messages.map(
        (m): AgentMessage => ({ role: m.role, content: m.content, timestamp: Date.now() }) as AgentMessage,
      ) as Message[],
      tools: chatOpts?.schemaTool
        ? [
            {
              name: chatOpts.schemaTool.name,
              description: chatOpts.schemaTool.description,
              parameters: chatOpts.schemaTool.parameters,
              constrainedSampling: { type: "json_schema", strict: "prefer" },
            } as Tool,
          ]
        : undefined,
    };
    const assistant = await registry.completeSimple(model, context);
    // Constrained path: the payload may arrive as a tool call — its arguments
    // ARE the JSON, and they must not be lost to text extraction.
    const schemaTool = chatOpts?.schemaTool;
    if (schemaTool) {
      const call = assistant.content.find((b) => b.type === "toolCall" && b.name === schemaTool.name);
      if (call && call.type === "toolCall") return JSON.stringify(call.arguments);
    }
    return assistant.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
  };
}

export async function completeStructured<T>(options: StructuredOptions<T>): Promise<StructuredResult<T>> {
  const maxReprompts = options.maxReprompts ?? 1;
  const messages: ChatTurn[] = [{ role: "user", content: options.prompt }];
  let attempts = 0;
  let lastError: unknown;

  for (let i = 0; i <= maxReprompts; i++) {
    attempts++;
    const raw = await options.complete(messages);
    try {
      return { value: options.parse(raw), attempts, method: i === 0 ? "direct" : "reprompt" };
    } catch (err) {
      lastError = err;
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `Your previous response failed validation: ${err instanceof Error ? err.message : String(err)}. Return ONLY a corrected response in the required format.`,
      });
    }
  }

  if (options.schemaTool) {
    attempts++;
    const raw = await options.complete(messages, { schemaTool: options.schemaTool });
    // The model answers by calling the schema tool; its arguments ARE the payload.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return { value: options.parse(raw.slice(start, end + 1)), attempts, method: "constrained" };
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
