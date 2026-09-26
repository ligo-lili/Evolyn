import { Agent, type AgentOptions, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModelRegistry } from "../providers.js";
import type { AnyAgentTool } from "./tools/index.js";

export interface CreateAgentOptions {
  model: Model<Api>;
  systemPrompt: string;
  tools: AnyAgentTool[];
  /** Injectable for tests; defaults to the pi-ai registry stream function. */
  streamFn?: StreamFn;
  sessionId?: string;
  /** Initial transcript (recovery passes the reconstructed messages here). */
  messages?: AgentMessage[];
  /** Optional tool gate (approval policy, fault injection, …). */
  beforeToolCall?: AgentOptions["beforeToolCall"];
  /** Optional per-request context transform (compaction, injection, …). */
  transformContext?: AgentOptions["transformContext"];
}

/**
 * The only place the harness talks to pi-ai's Models registry for streaming.
 * `Models.streamSimple` normalizes Context and resolves provider auth
 * (env keys) itself, so no key plumbing is needed here.
 */
export function harnessStreamFn(): StreamFn {
  const models = getModelRegistry();
  return (model, context, options) => models.streamSimple(model, context, options);
}

export function createAgent(options: CreateAgentOptions): Agent {
  return new Agent({
    streamFn: options.streamFn ?? harnessStreamFn(),
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: [...options.tools],
      messages: options.messages ?? [],
    },
    sessionId: options.sessionId,
    beforeToolCall: options.beforeToolCall,
    transformContext: options.transformContext,
  });
}
