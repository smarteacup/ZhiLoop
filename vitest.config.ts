import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: [
        "packages/{domain,schemas,config,control-api,session-catalog,operational-read-model,job-runtime,automatic-ingestion,knowledge-compilation-scheduler,configuration-service,observability,ingestion-codex,codex-session-capture,conversation-ledger,hook-runtime,conversation-normalizer,episode-builder,knowledge-compiler,model-codex-exec,candidate-repository,project-identity,scope-resolver,evidence-engine,evidence-policy,invalidation-engine,markdown-repository,knowledge-registry,knowledge-indexer,vector-index,knowledge-governance,active-knowledge-runtime,active-rollout-service,p3-console-runtime,p4-console-runtime,query-context,retrieval-engine,knowledge-reranker,context-renderer,context-orchestrator,retrieval-evaluation,codex-context-injection,knowledge-mcp,closure-verifier,stop-continuation,interaction-policy,confirmation-writeback,feedback-engine,codex-backfill,plugin-runtime}/src/**/*.ts",
        "apps/cli/src/knowledge-cli.ts",
        "apps/console-gateway/src/**/*.ts",
        "apps/console-web/src/**/*.{ts,tsx}",
        "packages/daemon-runtime/src/runtime.ts",
        "packages/local-deployment/src/**/*.ts",
        "apps/sidecar/src/{application,config,control-plane,diagnostic-log,hook-command,mcp-command,metadata,p1-runtime,p2-automatic-compilation,p2-preview-coordinator,p4-active-runtime,p4-console,p4-retrieval,transport}.ts",
      ],
      exclude: ["**/*.test.{ts,tsx}", "**/index.ts"],
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
