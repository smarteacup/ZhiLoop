import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["packages/{domain,schemas,config,ingestion-codex,conversation-ledger,hook-runtime,conversation-normalizer,episode-builder,knowledge-compiler,candidate-repository,project-identity,scope-resolver,evidence-engine,evidence-policy,invalidation-engine,markdown-repository,knowledge-registry,knowledge-indexer,vector-index}/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
      },
      reporter: ["text", "json-summary"],
    },
  },
});
