import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { LedgerEventRecord } from "@zhiloop/conversation-ledger";
import type { EventEnvelope, ProjectContext } from "@zhiloop/domain";
import type { CommandAssertion, TestAssertion, UserAssertion } from "@zhiloop/evidence-engine";

import { SnapshotObservationIndex, snapshotCommandHash, snapshotTestId } from "./snapshot.js";

const observedAt = "2026-08-19T00:00:00.000Z";
const project: ProjectContext = { projectId: "project-1", repositoryRoot: "/repo", portable: false };
const context = { project, correlationId: "correlation-1", requestedAt: observedAt };

function event(sequence: number, eventType: EventEnvelope["eventType"], payload: unknown, eventId = `event-${sequence}`): LedgerEventRecord {
  return { sequence, storedPayloadHash: "a".repeat(64), redactionCount: 0, payloadPurged: false, insertedAt: observedAt,
    event: { schemaVersion: 1, eventId, source: "codex-app-server", eventType, sessionId: "session-1", occurredAt: observedAt,
      contentHash: "b".repeat(64), correlationId: "correlation-1", payload } };
}

function source(records: readonly LedgerEventRecord[]) {
  return { snapshotId: "snapshot-1", contentHash: createHash("sha256").update("snapshot").digest("hex"), records };
}

describe("SnapshotObservationIndex", () => {
  it("supports user, command, and inferred test observations from only the immutable records", async () => {
    const command = "npm test";
    const commandHash = snapshotCommandHash(command)!;
    const index = new SnapshotObservationIndex(source([
      event(1, "user.prompted", { prompt: "确认" }, "statement-1"),
      event(2, "tool.completed", { toolName: "commandExecution", toolInput: { command }, toolResponse: { exitCode: 0 } }),
    ]));
    const user: UserAssertion = { assertionId: "u", candidateId: "c", kind: "USER_ACCEPTED", createdAt: observedAt,
      parameters: { statementRef: "statement-1" } };
    const commandAssertion: CommandAssertion = { assertionId: "cmd", candidateId: "c", kind: "COMMAND_SUCCEEDED", createdAt: observedAt,
      parameters: { commandHash, expectedExitCode: 0 } };
    const test: TestAssertion = { assertionId: "test", candidateId: "c", kind: "TEST_PASSED", createdAt: observedAt,
      parameters: { testId: snapshotTestId(commandHash), commandHash } };
    await expect(index.userProbe().observe(user, context)).resolves.toMatchObject({ status: "SUPPORTED", reasonCode: "SNAPSHOT_USER_STATEMENT_FOUND" });
    await expect(index.commandProbe().observe(commandAssertion, context)).resolves.toMatchObject({ status: "SUPPORTED", reasonCode: "SNAPSHOT_COMMAND_EXIT_MATCHED" });
    await expect(index.testProbe().observe(test, context)).resolves.toMatchObject({ status: "SUPPORTED", reasonCode: "SNAPSHOT_TEST_PASSED" });
  });

  it("refutes an observed failure or mismatch but leaves absent execution proof UNKNOWN", async () => {
    const commandHash = snapshotCommandHash("npm test")!;
    const index = new SnapshotObservationIndex(source([
      event(1, "tool.completed", { toolName: "commandExecution", toolInput: { command: "npm test" }, toolResponse: { exitCode: 1 } }),
    ]));
    const failed: TestAssertion = { assertionId: "test", candidateId: "c", kind: "TEST_PASSED", createdAt: observedAt,
      parameters: { testId: snapshotTestId(commandHash), commandHash } };
    const absent: CommandAssertion = { assertionId: "absent", candidateId: "c", kind: "COMMAND_SUCCEEDED", createdAt: observedAt,
      parameters: { commandHash: "f".repeat(64), expectedExitCode: 0 } };
    await expect(index.testProbe().observe(failed, context)).resolves.toMatchObject({ status: "REFUTED", reasonCode: "SNAPSHOT_TEST_FAILED" });
    await expect(index.commandProbe().observe(absent, context)).resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "SNAPSHOT_COMMAND_OBSERVATION_NOT_FOUND" });
  });

  it("does not index purged payloads and enforces record boundaries", async () => {
    const purged = { ...event(1, "user.prompted", { prompt: "secret" }, "statement-1"), payloadPurged: true };
    const index = new SnapshotObservationIndex(source([purged]));
    const user: UserAssertion = { assertionId: "u", candidateId: "c", kind: "USER_REJECTED", createdAt: observedAt,
      parameters: { statementRef: "statement-1" } };
    await expect(index.userProbe().observe(user, context)).resolves.toMatchObject({ status: "REFUTED" });
    expect(() => new SnapshotObservationIndex(source([event(1, "user.prompted", {}), event(1, "user.prompted", {})])))
      .toThrow("SNAPSHOT_OBSERVATION_RECORD_INVALID");
    expect(() => new SnapshotObservationIndex(source([event(1, "user.prompted", {})]), { maxRecords: 0 }))
      .toThrow("SNAPSHOT_OBSERVATION_SOURCE_INVALID");
  });

  it("stores observation identities and status, not raw command output", () => {
    const index = new SnapshotObservationIndex(source([event(1, "tool.completed", {
      toolName: "commandExecution", toolInput: { command: "npm test" }, toolResponse: { exitCode: 0, aggregatedOutput: "TOP SECRET" },
    })]));
    expect(JSON.stringify(index)).not.toContain("TOP SECRET");
  });

  it("normalizes array commands, explicit test identities, paths, status responses, and source item references", async () => {
    const arrayCommand = ["pnpm", "test"];
    const arrayHash = snapshotCommandHash(arrayCommand)!;
    const failedCommand = "custom-check";
    const failedHash = snapshotCommandHash(failedCommand)!;
    const prompted = event(1, "user.prompted", { prompt: "accept" }, "event-user");
    const index = new SnapshotObservationIndex(source([
      { ...prompted, event: { ...prompted.event, sourceItemId: "source-user" } },
      event(2, "tool.completed", { toolName: "runner", toolInput: { command: arrayCommand },
        toolResponse: { status: "passed", testId: "suite-array", filePath: "src/a.ts" } }),
      event(3, "tool.completed", { toolName: "custom", toolInput: { cmd: failedCommand, test_id: "suite-failed", path: "src/b.ts" },
        toolResponse: { status: "failed" } }),
      event(4, "tool.completed", { toolName: "custom", toolInput: { command: "exit-code" }, toolResponse: { exit_code: 2 } }),
      event(5, "tool.completed", "invalid payload"),
      event(6, "tool.completed", { toolInput: { command: [] }, toolResponse: { success: true } }),
      event(7, "tool.completed", { toolInput: { command: "npm test", testId: "suite-completed" }, toolResponse: { status: "completed" } }),
    ]));
    const accepted: UserAssertion = { assertionId: "source", candidateId: "c", kind: "USER_ACCEPTED", createdAt: observedAt,
      parameters: { statementRef: "source-user" } };
    await expect(index.userProbe().observe(accepted, context)).resolves.toMatchObject({ status: "SUPPORTED" });
    const arrayTest: TestAssertion = { assertionId: "array", candidateId: "c", kind: "TEST_PASSED", createdAt: observedAt,
      parameters: { testId: "suite-array", commandHash: arrayHash, path: "src/a.ts" } };
    await expect(index.testProbe().observe(arrayTest, context)).resolves.toMatchObject({ status: "SUPPORTED" });
    const failedTest: TestAssertion = { assertionId: "failed", candidateId: "c", kind: "TEST_PASSED", createdAt: observedAt,
      parameters: { testId: "suite-failed", commandHash: failedHash, path: "src/b.ts" } };
    await expect(index.testProbe().observe(failedTest, context)).resolves.toMatchObject({ status: "REFUTED" });
    const noExit: CommandAssertion = { assertionId: "array-command", candidateId: "c", kind: "COMMAND_SUCCEEDED", createdAt: observedAt,
      parameters: { commandHash: arrayHash, expectedExitCode: 0 } };
    await expect(index.commandProbe().observe(noExit, context)).resolves.toMatchObject({ status: "UNKNOWN" });
    await expect(index.testProbe().observe({ ...arrayTest, assertionId: "completed", parameters: { testId: "suite-completed" } }, context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "SNAPSHOT_TEST_OBSERVATION_NOT_FOUND" });
    const exitHash = snapshotCommandHash("exit-code")!;
    await expect(index.commandProbe().observe({ ...noExit, assertionId: "exit", parameters: { commandHash: exitHash, expectedExitCode: 0 } }, context))
      .resolves.toMatchObject({ status: "REFUTED", reasonCode: "SNAPSHOT_COMMAND_EXIT_MISMATCH" });
  });

  it("rejects unsafe hash and source bounds", () => {
    expect(snapshotCommandHash(42)).toBeUndefined();
    expect(snapshotCommandHash([])).toBeUndefined();
    expect(snapshotCommandHash(["ok", 1])).toBeUndefined();
    expect(snapshotCommandHash(" ")).toBeUndefined();
    expect(snapshotCommandHash("too-long", 2)).toBeUndefined();
    expect(() => snapshotTestId("invalid")).toThrow("COMMAND_HASH_INVALID");
    expect(() => new SnapshotObservationIndex({ ...source([]), snapshotId: "" })).toThrow("SNAPSHOT_OBSERVATION_SOURCE_INVALID");
    expect(() => new SnapshotObservationIndex({ ...source([]), contentHash: "bad" })).toThrow("SNAPSHOT_OBSERVATION_SOURCE_INVALID");
    expect(() => new SnapshotObservationIndex(source([]), { maxIdentityBytes: 0 })).toThrow("SNAPSHOT_OBSERVATION_SOURCE_INVALID");
    expect(() => new SnapshotObservationIndex(source([event(0, "user.prompted", {})]))).toThrow("SNAPSHOT_OBSERVATION_RECORD_INVALID");
  });
});
