import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: [
        "packages/{domain,schemas,config,ingestion-codex,conversation-ledger,hook-runtime,conversation-normalizer,episode-builder,knowledge-compiler,model-codex-exec,candidate-repository,project-identity,scope-resolver,evidence-engine,evidence-policy,invalidation-engine,markdown-repository,knowledge-registry,knowledge-indexer,vector-index,knowledge-governance,query-context,retrieval-engine,knowledge-reranker,context-renderer,context-orchestrator,retrieval-evaluation,codex-context-injection,knowledge-mcp,closure-verifier,stop-continuation,interaction-policy,confirmation-writeback,feedback-engine,codex-backfill,plugin-runtime}/src/**/*.ts",
        "apps/cli/src/knowledge-cli.ts",
        "packages/daemon-runtime/src/runtime.ts",
        "packages/local-deployment/src/**/*.ts",
        "apps/sidecar/src/{application,config,diagnostic-log,hook-command,metadata,transport}.ts",
      ],
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
