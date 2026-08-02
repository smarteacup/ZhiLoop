import {
  ASSERTION_KINDS,
  CONFIRMATION_KINDS,
  EVIDENCE_TYPES,
  EVENT_SOURCES,
  EVENT_TYPES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_RELATION_TYPES,
  KNOWLEDGE_STATUSES,
  SCOPE_LEVELS,
  type EventEnvelope,
  type KnowledgeAsset,
  type KnowledgeCandidate,
  type KnowledgeExtractionOutput,
  type ConfirmationRequest,
} from "@zhiloop/domain";
import { describe, expect, it } from "vitest";

import {
  parseEventEnvelope,
  parseConfirmationRequest,
  parseKnowledgeAsset,
  parseKnowledgeCandidate,
  parseKnowledgeExtractionOutput,
  schemas,
} from "./schema-registry.js";

const eventFixture = {
  schemaVersion: 1,
  eventId: "event-1",
  source: "codex-hook",
  eventType: "user.prompted",
  sessionId: "session-1",
  occurredAt: "2026-08-01T00:00:00Z",
  contentHash: "sha256:event",
  correlationId: "correlation-1",
  payload: { prompt: "design ZhiLoop" },
} satisfies EventEnvelope<{ prompt: string }>;

const candidateFixture = {
  schemaVersion: 1,
  candidateId: "candidate-1",
  compilerVersion: "1.0.0",
  status: "PROPOSED",
  subjectKey: "decision.codex.primary-source",
  kind: "DECISION",
  scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["REPO_MATCH"] },
  title: "Use Codex Hooks first",
  summary: "Use Hooks for existing clients.",
  body: "App Server remains a later adapter.",
  sourceEpisodes: ["episode-1"],
  confidence: 0.9,
  createdAt: "2026-08-01T00:00:00Z",
  correlationId: "correlation-1",
  assertions: [],
  evidenceHints: [
    {
      type: "USER_STATEMENT",
      sourceRef: "turn-1",
      correlationId: "correlation-1",
    },
  ],
} satisfies KnowledgeCandidate;

const assetFixture = {
  schemaVersion: 1,
  id: "decision.codex.primary-source",
  subjectKey: "decision.codex.primary-source",
  kind: "DECISION",
  scope: { level: "PROJECT", projectId: "project-1" },
  version: 1,
  status: "ACCEPTED",
  title: "Use Codex Hooks first",
  summary: "Use Hooks for existing clients.",
  body: "App Server remains a later adapter.",
  aliases: [],
  keywords: ["hooks"],
  applicability: [],
  nonApplicability: [],
  symbols: [],
  relations: [],
  evidence: [{ evidenceId: "evidence-1", verdict: "SUPPORTS" }],
  confidence: 0.9,
  sourceEpisodes: ["episode-1"],
  contentHash: "sha256:asset",
  correlationId: "correlation-1",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
} satisfies KnowledgeAsset;

const extractionFixture = {
  schemaVersion: 1,
  candidates: [{
    subjectKey: "decision.codex.primary-source",
    kind: "DECISION",
    scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["REPO_MATCH"] },
    title: "Use Codex Hooks first",
    summary: "Use Hooks for existing clients.",
    body: "App Server remains a later adapter.",
    confidence: 0.9,
    assertions: [],
    evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-1" }],
  }],
} satisfies KnowledgeExtractionOutput;

const confirmationFixture = {
  schemaVersion: 1,
  confirmationId: "confirmation-1",
  sessionId: "session-1",
  turnId: "turn-20",
  turnOrdinal: 20,
  triggerId: "trigger-1",
  kind: "SCOPE_PROMOTION",
  subjectIds: ["knowledge-1"],
  question: "是否提升为全局知识？",
  options: [
    { optionId: "keep-project", label: "仅保留在当前项目", effect: "KEEP_PROJECT" },
    { optionId: "promote-global", label: "提升为全局知识", effect: "PROMOTE_GLOBAL" },
  ],
  safeDefaultOptionId: "keep-project",
  createdAt: "2026-08-02T03:00:00.000Z",
} satisfies ConfirmationRequest;

describe("schema registry", () => {
  it("parses an EventEnvelope and separates unknown fields", () => {
    const result = parseEventEnvelope({ ...eventFixture, futureField: "preserved" });
    expect(result).toEqual({
      ok: true,
      value: eventFixture,
      extensions: { futureField: "preserved" },
    });
    if (result.ok) expect(Object.hasOwn(result.value, "futureField")).toBe(false);
  });

  it("returns a diagnostic for unsupported versions", () => {
    expect(parseEventEnvelope({ ...eventFixture, schemaVersion: 2 })).toEqual({
      ok: false,
      error: {
        code: "UNSUPPORTED_SCHEMA_VERSION",
        schema: "event",
        message: "unsupported event schemaVersion: 2",
        receivedVersion: 2,
        issues: [],
      },
    });
  });

  it("does not misclassify a missing version as an unsupported future version", () => {
    const withoutVersion = Object.fromEntries(
      Object.entries(eventFixture).filter(([key]) => key !== "schemaVersion"),
    );
    const result = parseEventEnvelope(withoutVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCHEMA_VALIDATION_FAILED");
      expect(result.error.issues.some((issue) => issue.keyword === "required")).toBe(true);
    }
  });

  it("accepts Candidate support from evidence or assertions", () => {
    expect(parseKnowledgeCandidate(candidateFixture).ok).toBe(true);
    expect(
      parseKnowledgeCandidate({
        ...candidateFixture,
        assertions: [
          {
            assertionId: "assertion-1",
            candidateId: "candidate-1",
            kind: "USER_ACCEPTED",
            parameters: { statementRef: "turn-1" },
            createdAt: "2026-08-01T00:00:00Z",
          },
        ],
        evidenceHints: [],
      }).ok,
    ).toBe(true);
  });

  it("requires every Candidate to remain explicitly PROPOSED", () => {
    expect(parseKnowledgeCandidate({ ...candidateFixture, status: "ACCEPTED" }).ok).toBe(false);
    const withoutStatus = Object.fromEntries(Object.entries(candidateFixture).filter(([key]) => key !== "status"));
    expect(parseKnowledgeCandidate(withoutStatus).ok).toBe(false);
  });

  it("separates Candidate top-level extensions", () => {
    const result = parseKnowledgeCandidate({ ...candidateFixture, futureField: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extensions).toEqual({ futureField: 42 });
      expect(Object.hasOwn(result.value, "futureField")).toBe(false);
    }
  });

  it("rejects a Candidate without assertions and evidence hints", () => {
    const result = parseKnowledgeCandidate({
      ...candidateFixture,
      assertions: [],
      evidenceHints: [],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed assertion parameters and nested extensions", () => {
    const malformedAssertion = parseKnowledgeCandidate({
      ...candidateFixture,
      assertions: [
        {
          assertionId: "assertion-1",
          candidateId: "candidate-1",
          kind: "SYMBOL_EXISTS",
          parameters: {},
          createdAt: "2026-08-01T00:00:00Z",
        },
      ],
      evidenceHints: [],
    });
    expect(malformedAssertion.ok).toBe(false);

    const nestedExtension = parseKnowledgeCandidate({
      ...candidateFixture,
      scopeHint: { ...candidateFixture.scopeHint, futureField: true },
    });
    expect(nestedExtension.ok).toBe(false);
  });

  it("rejects an Assertion that belongs to another Candidate", () => {
    const result = parseKnowledgeCandidate({
      ...candidateFixture,
      assertions: [
        {
          assertionId: "assertion-1",
          candidateId: "candidate-other",
          kind: "USER_ACCEPTED",
          parameters: { statementRef: "turn-1" },
          createdAt: "2026-08-01T00:00:00Z",
        },
      ],
      evidenceHints: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues[0]?.keyword).toBe("candidateIdMatch");
  });

  it("rejects malformed timestamps", () => {
    expect(parseEventEnvelope({ ...eventFixture, occurredAt: "not-a-date" }).ok).toBe(false);
    expect(parseKnowledgeCandidate({ ...candidateFixture, createdAt: "not-a-date" }).ok).toBe(
      false,
    );
  });

  it("validates an atomic Knowledge Extraction output", () => {
    expect(parseKnowledgeExtractionOutput(extractionFixture).ok).toBe(true);
    expect(parseKnowledgeExtractionOutput({
      ...extractionFixture,
      candidates: [...extractionFixture.candidates, { ...extractionFixture.candidates[0], title: "" }],
    }).ok).toBe(false);
    expect(parseKnowledgeExtractionOutput({ ...extractionFixture, extra: true }).ok).toBe(false);
  });

  it("validates KnowledgeAsset scope and version", () => {
    expect(parseKnowledgeAsset(assetFixture).ok).toBe(true);
    const result = parseKnowledgeAsset({
      ...assetFixture,
      scope: { level: "GLOBAL", projectId: "project-1" },
    });
    expect(result.ok).toBe(false);
  });

  it("validates a ConfirmationRequest and rejects unsafe or ambiguous defaults", () => {
    expect(parseConfirmationRequest(confirmationFixture).ok).toBe(true);
    const unsafe = parseConfirmationRequest({ ...confirmationFixture, safeDefaultOptionId: "promote-global" });
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) expect(unsafe.error.issues[0]?.keyword).toBe("safeDefault");
    expect(parseConfirmationRequest({
      ...confirmationFixture,
      options: [confirmationFixture.options[0], confirmationFixture.options[0]],
    }).ok).toBe(false);
    expect(parseConfirmationRequest({
      ...confirmationFixture,
      options: [confirmationFixture.options[0], { optionId: "apply-override", label: "覆盖规则", effect: "APPLY_OVERRIDE" }],
    }).ok).toBe(false);
  });

  it("keeps schema enums synchronized with Domain constants", () => {
    expect(schemas.event.properties.source.enum).toEqual(EVENT_SOURCES);
    expect(schemas.event.properties.eventType.enum).toEqual(EVENT_TYPES);
    expect(schemas["knowledge-candidate"].properties.kind.enum).toEqual(KNOWLEDGE_KINDS);
    expect(schemas["knowledge-extraction-output"].definitions.candidateDraft.properties.kind.enum).toEqual(KNOWLEDGE_KINDS);
    expect(
      schemas["knowledge-candidate"].properties.assertions.items.properties.kind.enum,
    ).toEqual(ASSERTION_KINDS);
    expect(schemas["knowledge-candidate"].properties.evidenceHints.items.properties.type.enum).toEqual(
      EVIDENCE_TYPES,
    );
    expect(schemas["knowledge-extraction-output"].definitions.assertionDraft.properties.kind.enum).toEqual(
      ASSERTION_KINDS,
    );
    expect(schemas["knowledge-extraction-output"].definitions.evidenceHintDraft.properties.type.enum).toEqual(
      EVIDENCE_TYPES,
    );
    expect(schemas["knowledge-candidate"].properties.scopeHint.properties.level.enum).toEqual(
      SCOPE_LEVELS,
    );
    expect(schemas["knowledge-asset"].properties.kind.enum).toEqual(KNOWLEDGE_KINDS);
    expect(schemas["knowledge-asset"].properties.status.enum).toEqual(KNOWLEDGE_STATUSES);
    expect(schemas["knowledge-asset"].properties.relations.items.properties.type.enum).toEqual(
      KNOWLEDGE_RELATION_TYPES,
    );
    expect(schemas["confirmation-request"].properties.kind.enum).toEqual(
      CONFIRMATION_KINDS.filter((kind) => kind !== "LOW_IMPACT_UNKNOWN"),
    );
  });
});
