import { randomUUID } from "node:crypto";

import { atomicWriteFile } from "./secure-files.js";
import type {
  DeploymentJournal,
  DeploymentStep,
  DeploymentTransactionOptions,
  DeploymentTransactionResult,
} from "./types.js";

function timestamp(clock: () => Date): string {
  const value = clock();
  if (Number.isNaN(value.getTime())) throw new Error("deployment clock returned an invalid date");
  return value.toISOString();
}

async function persist(path: string, journal: DeploymentJournal): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

export async function executeDeploymentTransaction(
  steps: readonly DeploymentStep[],
  options: DeploymentTransactionOptions,
): Promise<DeploymentTransactionResult> {
  if (steps.length === 0 || new Set(steps.map(({ id }) => id)).size !== steps.length
    || steps.some(({ id }) => id.length === 0 || id.length > 100 || /[\0\r\n]/u.test(id))) {
    throw new Error("deployment steps must have unique safe identifiers");
  }
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const transactionId = randomId();
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(transactionId)) throw new Error("transaction id must be a safe token");
  let journal: DeploymentJournal = Object.freeze({
    schemaVersion: 1,
    transactionId,
    operation: options.operation,
    state: "PREPARED",
    startedAt: timestamp(clock),
    completedSteps: Object.freeze([]),
  });
  await persist(options.journalPath, journal);
  const rollbacks: Array<{ readonly id: string; readonly action: () => Promise<void> }> = [];
  let applyingStep: string | undefined;
  try {
    journal = Object.freeze({ ...journal, state: "APPLYING" });
    await persist(options.journalPath, journal);
    for (const step of steps) {
      applyingStep = step.id;
      const rollback = await step.apply();
      rollbacks.push({ id: step.id, action: rollback });
      journal = Object.freeze({ ...journal, completedSteps: Object.freeze([...journal.completedSteps, step.id]) });
      await persist(options.journalPath, journal);
      if (options.failAfterStep === step.id) throw new Error(`injected deployment failure after ${step.id}`);
    }
    journal = Object.freeze({ ...journal, state: "COMMITTED" });
    await persist(options.journalPath, journal);
    return Object.freeze({ journal });
  } catch (error) {
    const failures: string[] = [];
    for (const rollback of [...rollbacks].reverse()) {
      try {
        await rollback.action();
      } catch {
        failures.push(rollback.id);
      }
    }
    journal = Object.freeze({
      ...journal,
      state: "ROLLED_BACK",
      ...(applyingStep === undefined ? {} : { failedStep: applyingStep }),
    });
    await persist(options.journalPath, journal).catch(() => undefined);
    if (failures.length > 0) {
      throw new AggregateError([error], `deployment failed and rollback failed for: ${failures.join(", ")}`, { cause: error });
    }
    throw error;
  }
}
