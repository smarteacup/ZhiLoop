import { ASSERTION_KINDS, KNOWLEDGE_KINDS } from "@zhiloop/domain";
import { z } from "zod";

const supportedEligibilityStatuses = ["VERIFIED", "IMPLEMENTED", "ACCEPTED"] as const;
const automaticInjectionLevels = [
  "L0_NONE",
  "L1_POINTER",
  "L2_COMPACT",
  "L3_EVIDENCED",
] as const;
const authorityClasses = [
  "BINDING_RULE",
  "ACCEPTED_DECISION",
  "VERIFIED_FACT",
  "REFERENCE",
] as const;
const expansionTools = ["ckl.search", "ckl.get", "ckl.related", "ckl.check"] as const;
const closureDecisions = [
  "PASS",
  "RETRY_WITH_CONTEXT",
  "RETRY_WITH_CORRECTION",
  "ASK_USER",
] as const;

const integer = (minimum: number, maximum: number) =>
  z.number().int().min(minimum).max(maximum);

const implementationAutoPublishSchema = z
  .strictObject({
    requiredAssertions: z.array(z.enum(ASSERTION_KINDS)).min(1),
    maxStatus: z.literal("IMPLEMENTED"),
  })
  .superRefine((rule, context) => {
    if (!rule.requiredAssertions.includes("SYMBOL_EXISTS")) {
      context.addIssue({
        code: "custom",
        path: ["requiredAssertions"],
        message: "IMPLEMENTATION auto-publish must require SYMBOL_EXISTS",
      });
    }
  });

const experienceAutoPublishSchema = z
  .strictObject({
    requiredAssertions: z.array(z.enum(ASSERTION_KINDS)).min(1),
    maxStatus: z.literal("VERIFIED"),
  })
  .superRefine((rule, context) => {
    if (!rule.requiredAssertions.includes("TEST_PASSED")) {
      context.addIssue({
        code: "custom",
        path: ["requiredAssertions"],
        message: "EXPERIENCE auto-publish must require TEST_PASSED",
      });
    }
  });

export const verificationPolicySchema = z.strictObject({
  autoPublish: z.strictObject({
    IMPLEMENTATION: implementationAutoPublishSchema,
    EXPERIENCE: experienceAutoPublishSchema,
  }),
  globalPromotion: z.strictObject({
    minVerifiedProjects: integer(2, 20),
  }),
  interaction: z.strictObject({
    maxQuestionsPerTurn: z.literal(1),
    questionWindowTurns: z.literal(20),
    defaultScope: z.literal("PROJECT"),
    unansweredBehavior: z.literal("SAFE_DEFAULT"),
    createReviewTasks: z.literal(false),
  }),
});

export const retrievalPolicySchema = z
  .strictObject({
    topK: z.strictObject({
      exact: integer(0, 100),
      fts: integer(0, 100),
      vector: integer(0, 100),
      relation: integer(0, 100),
    }),
    fusion: z.strictObject({
      algorithm: z.literal("rrf"),
      rrfK: integer(1, 1_000),
    }),
    rerank: z.strictObject({
      candidates: integer(1, 100),
    }),
    output: z.strictObject({
      minItems: integer(0, 50),
      maxItems: integer(0, 50),
    }),
    eligibility: z.strictObject({
      default: z.array(z.enum(supportedEligibilityStatuses)).min(1),
    }),
  })
  .superRefine((policy, context) => {
    if (policy.output.minItems > policy.output.maxItems) {
      context.addIssue({
        code: "custom",
        path: ["output", "minItems"],
        message: "minItems must not exceed maxItems",
      });
    }
    if (policy.rerank.candidates < policy.output.maxItems) {
      context.addIssue({
        code: "custom",
        path: ["rerank", "candidates"],
        message: "rerank candidates must cover maxItems",
      });
    }
  });

const injectionLevelPolicySchema = z.strictObject({
  maxItems: integer(0, 8),
  evidence: z.enum(["NONE", "POINTER", "SUMMARY"]),
});

export const injectionPolicySchema = z
  .strictObject({
    defaultLevel: z.enum(automaticInjectionLevels),
    defaultMaxTokens: integer(1, 4_000),
    userPromptDeadlineMs: integer(1, 500),
    failOpenOnTimeout: z.literal(true),
    levels: z.strictObject({
      L1_POINTER: injectionLevelPolicySchema,
      L2_COMPACT: injectionLevelPolicySchema,
      L3_EVIDENCED: injectionLevelPolicySchema,
      L4_EPISODE: z.strictObject({ automatic: z.literal(false) }),
    }),
    authorityOrder: z.array(z.enum(authorityClasses)).length(authorityClasses.length),
    expansion: z.strictObject({
      enabled: z.boolean(),
      tools: z.array(z.enum(expansionTools)).min(1),
    }),
  })
  .superRefine((policy, context) => {
    const { L1_POINTER, L2_COMPACT, L3_EVIDENCED } = policy.levels;
    if (!(L1_POINTER.maxItems <= L2_COMPACT.maxItems && L2_COMPACT.maxItems <= L3_EVIDENCED.maxItems)) {
      context.addIssue({
        code: "custom",
        path: ["levels"],
        message: "injection maxItems must be monotonic from L1 through L3",
      });
    }
    if (L1_POINTER.evidence !== "NONE") {
      context.addIssue({
        code: "custom",
        path: ["levels", "L1_POINTER", "evidence"],
        message: "L1 evidence must be NONE",
      });
    }
    if (L2_COMPACT.evidence !== "POINTER") {
      context.addIssue({
        code: "custom",
        path: ["levels", "L2_COMPACT", "evidence"],
        message: "L2 evidence must be POINTER",
      });
    }
    if (L3_EVIDENCED.evidence !== "SUMMARY") {
      context.addIssue({
        code: "custom",
        path: ["levels", "L3_EVIDENCED", "evidence"],
        message: "L3 evidence must be SUMMARY",
      });
    }
    if (new Set(policy.authorityOrder).size !== authorityClasses.length) {
      context.addIssue({
        code: "custom",
        path: ["authorityOrder"],
        message: "authorityOrder must contain every authority class exactly once",
      });
    }
    if (new Set(policy.expansion.tools).size !== policy.expansion.tools.length) {
      context.addIssue({
        code: "custom",
        path: ["expansion", "tools"],
        message: "expansion tools must be unique",
      });
    }
  });

export const closurePolicySchema = z
  .strictObject({
    enabled: z.boolean(),
    defaultMaxContinuations: integer(0, 1),
    highRiskMaxContinuations: integer(0, 2),
    deterministicDeadlineMs: integer(1, 500),
    semanticVerificationDeadlineMs: integer(1, 3_000),
    decisions: z.array(z.enum(closureDecisions)).min(2),
    failOpenOnTimeout: z.literal(true),
    forbidRequirementExpansion: z.literal(true),
  })
  .superRefine((policy, context) => {
    if (policy.defaultMaxContinuations > policy.highRiskMaxContinuations) {
      context.addIssue({
        code: "custom",
        path: ["defaultMaxContinuations"],
        message: "default continuation limit must not exceed high-risk limit",
      });
    }
    if (policy.deterministicDeadlineMs > policy.semanticVerificationDeadlineMs) {
      context.addIssue({
        code: "custom",
        path: ["deterministicDeadlineMs"],
        message: "deterministic deadline must not exceed semantic deadline",
      });
    }
    if (new Set(policy.decisions).size !== policy.decisions.length) {
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: "closure decisions must be unique",
      });
    }
    for (const requiredDecision of ["PASS", "ASK_USER"] as const) {
      if (!policy.decisions.includes(requiredDecision)) {
        context.addIssue({
          code: "custom",
          path: ["decisions"],
          message: `closure decisions must include ${requiredDecision}`,
        });
      }
    }
  });

export const scopePolicySchema = z.strictObject({
  defaultLevel: z.enum(["TASK", "SYMBOL", "MODULE", "PROJECT"]),
  allowCrossProjectFallback: z.literal(false),
  repositoryPublisherEnabled: z.boolean(),
});

export const retentionPolicySchema = z.strictObject({
  rawEventDays: integer(0, 30),
  logDays: integer(1, 30),
  tombstoneDays: integer(30, 3_650),
  storeTranscriptBody: z.literal(false),
});

export const legacyConfigurationSchema = z.strictObject({
  version: z.literal(1),
  verification: verificationPolicySchema,
  retrieval: retrievalPolicySchema,
  injection: injectionPolicySchema,
  closure: closurePolicySchema,
  scope: scopePolicySchema,
  retention: retentionPolicySchema,
});

export const compilationPolicySchema = z.strictObject({
  enabled: z.boolean(),
  mode: z.enum(["PREVIEW_ONLY", "POLICY_EVALUATION", "SAFE_AUTO_PUBLICATION"]),
  triggers: z.strictObject({
    minNewTurns: integer(1, 100),
    idleMs: integer(1_000, 86_400_000),
    onSessionEnd: z.boolean(),
    maxWaitMs: integer(1_000, 86_400_000),
    minNewEvents: integer(1, 1_000),
  }),
  worker: z.strictObject({
    pollIntervalMs: integer(100, 60_000),
    concurrency: integer(1, 8),
    retry: z.strictObject({
      maxAttempts: integer(1, 20),
      baseDelayMs: integer(100, 300_000),
      maximumDelayMs: integer(100, 3_600_000),
      jitterRatio: z.number().min(0).max(1),
    }),
  }),
  publication: z.strictObject({
    enabled: z.boolean(),
    allowedKinds: z.array(z.enum(KNOWLEDGE_KINDS)).max(KNOWLEDGE_KINDS.length),
    allowedProjectIds: z.array(z.string().min(1).max(200)).max(100),
    requireFreshCodeEvidence: z.literal(true),
    goldenDatasetId: z.string().min(1).max(200).optional(),
    goldenDatasetVersion: integer(1, 1_000_000).optional(),
    goldenConfigFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  }),
}).superRefine((policy, context) => {
  if (policy.worker.retry.baseDelayMs > policy.worker.retry.maximumDelayMs) {
    context.addIssue({ code: "custom", path: ["worker", "retry", "baseDelayMs"], message: "baseDelayMs must not exceed maximumDelayMs" });
  }
  if (policy.triggers.idleMs > policy.triggers.maxWaitMs) {
    context.addIssue({ code: "custom", path: ["triggers", "idleMs"], message: "idleMs must not exceed maxWaitMs" });
  }
  const publicationIdentity = [policy.publication.goldenDatasetId, policy.publication.goldenDatasetVersion, policy.publication.goldenConfigFingerprint];
  if (publicationIdentity.some((value) => value !== undefined) && publicationIdentity.some((value) => value === undefined)) {
    context.addIssue({ code: "custom", path: ["publication"], message: "golden publication identity must be configured atomically" });
  }
  if (policy.publication.enabled && (policy.mode !== "SAFE_AUTO_PUBLICATION" || policy.publication.allowedKinds.length === 0
    || policy.publication.allowedProjectIds.length === 0 || publicationIdentity.some((value) => value === undefined))) {
    context.addIssue({ code: "custom", path: ["publication", "enabled"], message: "automatic publication requires safe mode, allowlists and golden evidence identity" });
  }
  if (!policy.publication.enabled && policy.mode === "SAFE_AUTO_PUBLICATION") {
    context.addIssue({ code: "custom", path: ["mode"], message: "SAFE_AUTO_PUBLICATION requires publication.enabled" });
  }
  if (new Set(policy.publication.allowedKinds).size !== policy.publication.allowedKinds.length
    || new Set(policy.publication.allowedProjectIds).size !== policy.publication.allowedProjectIds.length) {
    context.addIssue({ code: "custom", path: ["publication"], message: "publication allowlists must be unique" });
  }
});

export const evolutionPolicySchema = z.strictObject({
  maxMatchCandidates: integer(1, 20),
  semanticJudgeEnabled: z.boolean(),
  failClosed: z.literal(true),
});

export const codeIntelligencePolicySchema = z.strictObject({
  provider: z.literal("codegraph"),
  initializeAutomatically: z.literal(false),
  queryTimeoutMs: integer(10, 10_000),
  circuitBreakerFailures: integer(1, 100),
  circuitBreakerResetMs: integer(1_000, 3_600_000),
});

export const freshnessPolicySchema = z.strictObject({
  enabled: z.boolean(),
  changeDebounceMs: integer(100, 60_000),
  fallbackScanIntervalMs: integer(10_000, 86_400_000),
  preInjectionGate: z.literal(true),
  gateTimeoutMs: integer(10, 1_000),
  maxAffectedPerJob: integer(1, 10_000),
});

export const prewarmPolicySchema = z.strictObject({
  enabled: z.boolean(),
  onSessionStart: z.boolean(),
  ttlMs: integer(1_000, 86_400_000),
  maxItems: integer(1, 50),
  maxTokens: integer(1, 4_000),
});

export const evolutionAlertsPolicySchema = z.strictObject({
  enabled: z.boolean(),
  onPermanentJobFailure: z.boolean(),
  onCodeGraphUnavailable: z.boolean(),
  onStaleKnowledgeDetected: z.boolean(),
});

export const configurationSchema = z.strictObject({
  version: z.literal(2),
  verification: verificationPolicySchema,
  retrieval: retrievalPolicySchema,
  injection: injectionPolicySchema,
  closure: closurePolicySchema,
  scope: scopePolicySchema,
  retention: retentionPolicySchema,
  compilation: compilationPolicySchema,
  evolution: evolutionPolicySchema,
  codeIntelligence: codeIntelligencePolicySchema,
  freshness: freshnessPolicySchema,
  prewarm: prewarmPolicySchema,
  alerts: evolutionAlertsPolicySchema,
}).superRefine((configuration, context) => {
  if (configuration.prewarm.maxItems > configuration.injection.levels.L1_POINTER.maxItems) {
    context.addIssue({ code: "custom", path: ["prewarm", "maxItems"], message: "prewarm maxItems must not exceed L1 maxItems" });
  }
  if (configuration.prewarm.maxTokens > configuration.injection.defaultMaxTokens) {
    context.addIssue({ code: "custom", path: ["prewarm", "maxTokens"], message: "prewarm maxTokens must not exceed injection budget" });
  }
});

export type VerificationPolicy = z.infer<typeof verificationPolicySchema>;
export type RetrievalPolicy = z.infer<typeof retrievalPolicySchema>;
export type InjectionPolicy = z.infer<typeof injectionPolicySchema>;
export type ClosurePolicy = z.infer<typeof closurePolicySchema>;
export type ScopePolicy = z.infer<typeof scopePolicySchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type CompilationPolicy = z.infer<typeof compilationPolicySchema>;
export type EvolutionPolicy = z.infer<typeof evolutionPolicySchema>;
export type CodeIntelligencePolicy = z.infer<typeof codeIntelligencePolicySchema>;
export type FreshnessPolicy = z.infer<typeof freshnessPolicySchema>;
export type PrewarmPolicy = z.infer<typeof prewarmPolicySchema>;
export type EvolutionAlertsPolicy = z.infer<typeof evolutionAlertsPolicySchema>;
export type LegacyZhiLoopConfiguration = z.infer<typeof legacyConfigurationSchema>;
export type ZhiLoopConfiguration = z.infer<typeof configurationSchema>;

function freezeDefault<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDefault(child);
  return Object.freeze(value);
}

export const LEGACY_DEFAULT_CONFIGURATION: LegacyZhiLoopConfiguration = freezeDefault({
  version: 1,
  verification: {
    autoPublish: {
      IMPLEMENTATION: {
        requiredAssertions: ["SYMBOL_EXISTS"],
        maxStatus: "IMPLEMENTED",
      },
      EXPERIENCE: {
        requiredAssertions: ["TEST_PASSED"],
        maxStatus: "VERIFIED",
      },
    },
    globalPromotion: { minVerifiedProjects: 2 },
    interaction: {
      maxQuestionsPerTurn: 1,
      questionWindowTurns: 20,
      defaultScope: "PROJECT",
      unansweredBehavior: "SAFE_DEFAULT",
      createReviewTasks: false,
    },
  },
  retrieval: {
    topK: { exact: 30, fts: 30, vector: 30, relation: 20 },
    fusion: { algorithm: "rrf", rrfK: 60 },
    rerank: { candidates: 30 },
    output: { minItems: 0, maxItems: 8 },
    eligibility: { default: ["VERIFIED", "IMPLEMENTED", "ACCEPTED"] },
  },
  injection: {
    defaultLevel: "L1_POINTER",
    defaultMaxTokens: 800,
    userPromptDeadlineMs: 500,
    failOpenOnTimeout: true,
    levels: {
      L1_POINTER: { maxItems: 8, evidence: "NONE" },
      L2_COMPACT: { maxItems: 8, evidence: "POINTER" },
      L3_EVIDENCED: { maxItems: 8, evidence: "SUMMARY" },
      L4_EPISODE: { automatic: false },
    },
    authorityOrder: ["BINDING_RULE", "ACCEPTED_DECISION", "VERIFIED_FACT", "REFERENCE"],
    expansion: {
      enabled: true,
      tools: ["ckl.search", "ckl.get", "ckl.related", "ckl.check"],
    },
  },
  closure: {
    enabled: true,
    defaultMaxContinuations: 1,
    highRiskMaxContinuations: 2,
    deterministicDeadlineMs: 500,
    semanticVerificationDeadlineMs: 3_000,
    decisions: ["PASS", "RETRY_WITH_CONTEXT", "RETRY_WITH_CORRECTION", "ASK_USER"],
    failOpenOnTimeout: true,
    forbidRequirementExpansion: true,
  },
  scope: {
    defaultLevel: "PROJECT",
    allowCrossProjectFallback: false,
    repositoryPublisherEnabled: false,
  },
  retention: {
    rawEventDays: 30,
    logDays: 14,
    tombstoneDays: 365,
    storeTranscriptBody: false,
  },
});

export const DEFAULT_CONFIGURATION: ZhiLoopConfiguration = freezeDefault({
  ...LEGACY_DEFAULT_CONFIGURATION,
  version: 2,
  compilation: {
    enabled: true,
    mode: "PREVIEW_ONLY",
    triggers: { minNewTurns: 3, idleMs: 120_000, onSessionEnd: true, maxWaitMs: 1_800_000, minNewEvents: 2 },
    worker: { pollIntervalMs: 1_000, concurrency: 1, retry: { maxAttempts: 5, baseDelayMs: 1_000, maximumDelayMs: 60_000, jitterRatio: 0.2 } },
    publication: { enabled: false, allowedKinds: [], allowedProjectIds: [], requireFreshCodeEvidence: true },
  },
  evolution: { maxMatchCandidates: 5, semanticJudgeEnabled: false, failClosed: true },
  codeIntelligence: { provider: "codegraph", initializeAutomatically: false, queryTimeoutMs: 2_000, circuitBreakerFailures: 3, circuitBreakerResetMs: 30_000 },
  freshness: { enabled: true, changeDebounceMs: 1_000, fallbackScanIntervalMs: 3_600_000, preInjectionGate: true, gateTimeoutMs: 200, maxAffectedPerJob: 500 },
  prewarm: { enabled: true, onSessionStart: true, ttlMs: 1_800_000, maxItems: 8, maxTokens: 800 },
  alerts: { enabled: false, onPermanentJobFailure: true, onCodeGraphUnavailable: false, onStaleKnowledgeDetected: false },
});
