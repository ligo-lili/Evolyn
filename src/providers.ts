import { createProvider, envApiKeyAuth, type Api, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { HarnessError } from "./errors.js";

/**
 * Model registry: pi-ai built-ins (openai, anthropic, deepseek, and the full
 * OpenRouter catalog — the weak-eval-model path reads OPENROUTER_API_KEY) plus
 * our own "qwen" provider for DashScope's OpenAI-compatible endpoint. This is
 * the single place where harness-side provider wiring lives; everything
 * downstream only ever sees a resolved Model.
 */

const DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

function qwenModel(id: string, contextWindow: number, maxTokens: number): Model<"openai-completions"> {
  // Pricing is intentionally zero until we model DashScope rates; cost totals
  // will under-report for qwen until then.
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "qwen",
    baseUrl: DASHSCOPE_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

const QWEN_MODELS: Model<"openai-completions">[] = [
  qwenModel("qwen-max", 131_072, 8_192),
  qwenModel("qwen-plus", 131_072, 8_192),
  qwenModel("qwen-turbo", 131_072, 8_192),
  qwenModel("qwen3-max", 131_072, 8_192),
  qwenModel("qwen3.7-plus", 131_072, 8_192),
];

function qwenProvider(): Provider<"openai-completions"> {
  return createProvider({
    id: "qwen",
    name: "Qwen (DashScope compatible-mode)",
    baseUrl: DASHSCOPE_BASE_URL,
    auth: { apiKey: envApiKeyAuth("qwen", ["DASHSCOPE_API_KEY", "QWEN_API_KEY"]) },
    models: QWEN_MODELS,
    api: openAICompletionsApi(),
  });
}

let registry: MutableModels | undefined;

export function getModelRegistry(): MutableModels {
  registry ??= builtinModels();
  // setProvider is idempotent per run; guard keeps repeated calls cheap.
  if (!registry.getModel("qwen", "qwen-max")) registry.setProvider(qwenProvider());
  return registry;
}

export function resolveModel(spec: string): Model<Api> {
  const sep = spec.indexOf("/");
  if (sep <= 0 || sep === spec.length - 1) {
    throw new HarnessError(`model spec must look like "provider/model-id", got: "${spec}"`);
  }
  const provider = spec.slice(0, sep);
  const id = spec.slice(sep + 1);
  const model = getModelRegistry().getModel(provider, id);
  if (!model) {
    const available = getModelRegistry()
      .getModels(provider)
      .map((m) => `${provider}/${m.id}`)
      .join(", ");
    throw new HarnessError(`unknown model "${spec}"${available ? ` (available: ${available})` : ` (unknown provider "${provider}")`}`);
  }
  return model;
}

export function listProviderIds(): string[] {
  return [...new Set(getModelRegistry().getModels().map((m) => m.provider))].sort();
}
