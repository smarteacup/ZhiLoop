import { describe, expect, it } from "vitest";

import {
  ActiveClosureOperationConflictError,
  SqliteActiveClosureOperationStore,
} from "./closure-operation-store.js";
import { fixedNow } from "./test-fixtures.js";
import type { ActiveClosureOperationOutcome } from "./types.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function outcome(delta = "run the missing test"): ActiveClosureOperationOutcome {
  return {
    stop: {
      status: "CONTINUED_WITH_CORRECTION",
      decision: "RETRY_WITH_CORRECTION",
      continuationCount: 1,
      output: { decision: "block", reason: delta },
    },
    audit: {
      schemaVersion: 1,
      closureRunId: "closure-1",
      sessionId: "session-1",
      turnId: "turn-1",
      taskContract: { contractId: "contract-1", objective: "finish", gates: ["test"], boundaries: [] },
      gates: [{ gateId: "test", status: "UNSATISFIED", reasonCodes: ["TEST_FAILED"], evidenceRefs: [] }],
      decision: "RETRY_WITH_CORRECTION",
      correctionDelta: delta,
      continuationCount: 1,
      recursiveStopRejected: false,
      createdAt: fixedNow,
    },
  };
}

describe("SqliteActiveClosureOperationStore", () => {
  it("enforces identity fencing and idempotent outcome/completion replay", () => {
    using store = new SqliteActiveClosureOperationStore(":memory:");
    expect(store.begin("operation-1", hashA)).toMatchObject({ status: "PENDING", requestHash: hashA });
    expect(store.begin("operation-1", hashA)).toMatchObject({ status: "PENDING" });
    expect(() => store.begin("operation-1", hashB)).toThrow(ActiveClosureOperationConflictError);
    expect(() => store.complete("operation-1", hashA)).toThrow("cannot complete before");

    const checkpoint = store.saveOutcome("operation-1", hashA, outcome());
    expect(checkpoint).toMatchObject({ status: "OUTCOME", outcome: { stop: { continuationCount: 1 } } });
    expect(store.saveOutcome("operation-1", hashA, outcome())).toEqual(checkpoint);
    expect(() => store.saveOutcome("operation-1", hashA, outcome("different"))).toThrow(ActiveClosureOperationConflictError);
    const completed = store.complete("operation-1", hashA);
    expect(completed.status).toBe("COMPLETED");
    expect(store.complete("operation-1", hashA)).toEqual(completed);
  });

  it("rejects invalid, missing and oversized operations and fails safely after close", () => {
    const store = new SqliteActiveClosureOperationStore(":memory:");
    expect(() => store.begin("bad/id", hashA)).toThrow("identity is invalid");
    expect(() => store.begin("operation-1", "short")).toThrow("identity is invalid");
    expect(() => store.saveOutcome("operation-missing", hashA, outcome())).toThrow("not prepared");
    store.begin("operation-large", hashA);
    expect(() => store.saveOutcome("operation-large", hashA, outcome("x".repeat(4 * 1024 * 1024)))).toThrow("byte limit");
    store.close();
    store.close();
    expect(() => store.begin("operation-closed", hashA)).toThrow("closed");
  });
});
