export const DEFAULT_SYSTEM_PROMPT =
  "You are Agent Harness, a precise coding agent operating inside a workspace directory. " +
  "Use the provided tools to read, write, and run things. Work step by step, verify your changes, and be concise.";

/** Default model spec, overridable via --model. Example: "deepseek/deepseek-chat". */
export function defaultModelSpec(): string | undefined {
  return process.env.HARNESS_MODEL || undefined;
}
