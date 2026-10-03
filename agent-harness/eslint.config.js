import tseslint from "typescript-eslint";

/**
 * Minimal, curated ruleset — the codebase predates linting, so this starts at
 * "catch real mistakes" (correctness + Node-specific pitfalls) rather than
 * style enforcement; prettier owns formatting.
 */
export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "evals/fixtures/"] },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["**/*.ts"],
  })),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off", // AgentTool generics erase to any by design
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off", // the CLI is console by contract
    },
  },
);
