import { createHash } from "node:crypto";

import type { LedgerEventRecord } from "@zhiloop/conversation-ledger";
import type {
  CommandAssertion,
  ProbeContext,
  TestAssertion,
  UserAssertion,
  VerificationObservation,
  VerificationProbe,
} from "@zhiloop/evidence-engine";

export interface SnapshotObservationSource {
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly records: readonly LedgerEventRecord[];
}

export interface SnapshotObservationLimits {
  readonly maxRecords?: number;
  readonly maxIdentityBytes?: number;
}

interface CommandObservation {
  readonly commandHash: string;
  readonly exitCode?: number;
  readonly succeeded?: boolean;
  readonly eventId: string;
  readonly sequence: number;
}

interface TestObservation extends CommandObservation {
  readonly testId: string;
  readonly path?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safe(value: unknown, maximum = 1_000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value);
}

function commandValue(input: unknown): unknown {
  if (!record(input)) return undefined;
  return input["cmd"] ?? input["command"];
}

function commandLooksLikeTest(command: unknown): boolean {
  const text = typeof command === "string" ? command
    : Array.isArray(command) && command.every((part) => typeof part === "string") ? command.join(" ") : "";
  return /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|mvn\s+test|gradle\w*\s+test|cargo\s+test|go\s+test)\b/iu.test(text);
}

export function snapshotCommandHash(command: unknown, maxIdentityBytes = 32_768): string | undefined {
  let identity: string;
  if (typeof command === "string") identity = command.trim().replace(/\r\n/gu, "\n");
  else if (Array.isArray(command) && command.length > 0 && command.length <= 1_024
    && command.every((part) => typeof part === "string" && Buffer.byteLength(part, "utf8") <= maxIdentityBytes)) {
    identity = command.map((part) => part.trim().replace(/\r\n/gu, "\n")).join("\0");
  } else return undefined;
  if (identity.length === 0 || Buffer.byteLength(identity, "utf8") > maxIdentityBytes) return undefined;
  return createHash("sha256").update(identity).digest("hex");
}

export function snapshotTestId(commandHash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(commandHash)) throw new Error("COMMAND_HASH_INVALID");
  return `command:${commandHash}`;
}

function responseState(response: unknown): { readonly exitCode?: number; readonly succeeded?: boolean } {
  if (!record(response)) return {};
  const exitCode = response["exitCode"] ?? response["exit_code"];
  if (Number.isSafeInteger(exitCode) && Math.abs(exitCode as number) <= 255) {
    return { exitCode: exitCode as number, succeeded: exitCode === 0 };
  }
  const status = response["status"];
  if (typeof status === "string") {
    if (/^(?:ok|passed|success|succeeded)$/iu.test(status)) return { succeeded: true };
    if (/^(?:error|failed|failure|cancelled|canceled)$/iu.test(status)) return { succeeded: false };
  }
  const success = response["success"];
  return typeof success === "boolean" ? { succeeded: success } : {};
}

function textField(value: unknown, keys: readonly string[]): string | undefined {
  if (!record(value)) return undefined;
  for (const key of keys) if (safe(value[key], 1_000)) return String(value[key]);
  return undefined;
}

function sourceRef(snapshot: SnapshotObservationSource, observation: { readonly eventId: string; readonly sequence: number }): string {
  return `snapshot:${snapshot.snapshotId}:sha256:${snapshot.contentHash}:sequence:${observation.sequence}:event:${observation.eventId}`;
}

function result(
  status: VerificationObservation["status"],
  context: ProbeContext,
  target: string,
  source: string,
  reasonCode: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): VerificationObservation {
  return Object.freeze({ status, observedAt: context.requestedAt, target, sourceRef: source, reasonCode,
    ...(details === undefined ? {} : { details }) });
}

export class SnapshotObservationIndex {
  readonly #source: SnapshotObservationSource;
  readonly #userRefs = new Map<string, { readonly eventId: string; readonly sequence: number }>();
  readonly #commands = new Map<string, CommandObservation[]>();
  readonly #tests = new Map<string, TestObservation[]>();

  constructor(source: SnapshotObservationSource, limits: SnapshotObservationLimits = {}) {
    const maxRecords = limits.maxRecords ?? 10_000;
    const maxIdentityBytes = limits.maxIdentityBytes ?? 32_768;
    if (!safe(source.snapshotId, 500) || !/^[a-f0-9]{64}$/u.test(source.contentHash)
      || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100_000
      || !Number.isSafeInteger(maxIdentityBytes) || maxIdentityBytes < 1 || maxIdentityBytes > 262_144
      || source.records.length > maxRecords) throw new Error("SNAPSHOT_OBSERVATION_SOURCE_INVALID");
    this.#source = source;
    const seenSequences = new Set<number>();
    for (const item of source.records) {
      if (!Number.isSafeInteger(item.sequence) || item.sequence < 1 || seenSequences.has(item.sequence)
        || !safe(item.event.eventId, 500)) throw new Error("SNAPSHOT_OBSERVATION_RECORD_INVALID");
      seenSequences.add(item.sequence);
      if (item.payloadPurged) continue;
      if (item.event.eventType === "user.prompted") {
        this.#userRefs.set(item.event.eventId, { eventId: item.event.eventId, sequence: item.sequence });
        if (safe(item.event.sourceItemId, 500)) this.#userRefs.set(item.event.sourceItemId, { eventId: item.event.eventId, sequence: item.sequence });
      }
      if (item.event.eventType !== "tool.completed" || !record(item.event.payload)) continue;
      const input = item.event.payload["toolInput"];
      const response = item.event.payload["toolResponse"];
      const command = commandValue(input);
      const commandHash = snapshotCommandHash(command, maxIdentityBytes);
      if (commandHash === undefined) continue;
      const state = responseState(response);
      const observation: CommandObservation = {
        commandHash, eventId: item.event.eventId, sequence: item.sequence,
        ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
        ...(state.succeeded === undefined ? {} : { succeeded: state.succeeded }),
      };
      const commands = this.#commands.get(commandHash) ?? [];
      commands.push(observation);
      this.#commands.set(commandHash, commands);
      const explicitTestId = textField(input, ["testId", "test_id"])
        ?? textField(response, ["testId", "test_id"]);
      const toolName = textField(item.event.payload, ["toolName"]);
      const inferredTest = commandLooksLikeTest(command)
        || (toolName !== undefined && /(?:test|spec|jest|vitest|pytest|maven|gradle|cargo)/iu.test(toolName));
      const testId = explicitTestId ?? (inferredTest ? snapshotTestId(commandHash) : undefined);
      if (testId === undefined) continue;
      const path = textField(input, ["path", "filePath", "file_path"])
        ?? textField(response, ["path", "filePath", "file_path"]);
      const test: TestObservation = { ...observation, testId, ...(path === undefined ? {} : { path }) };
      const tests = this.#tests.get(testId) ?? [];
      tests.push(test);
      this.#tests.set(testId, tests);
    }
  }

  userProbe(): VerificationProbe<UserAssertion> {
    return Object.freeze({ observe: async (assertion: UserAssertion, context: ProbeContext): Promise<VerificationObservation> => {
      const target = `statement:${assertion.parameters.statementRef}`;
      const found = this.#userRefs.get(assertion.parameters.statementRef);
      return found === undefined
        ? result("REFUTED", context, target, `snapshot:${this.#source.snapshotId}:sha256:${this.#source.contentHash}`,
          "SNAPSHOT_USER_STATEMENT_NOT_FOUND")
        : result("SUPPORTED", context, target, sourceRef(this.#source, found), "SNAPSHOT_USER_STATEMENT_FOUND");
    } });
  }

  commandProbe(): VerificationProbe<CommandAssertion> {
    return Object.freeze({ observe: async (assertion: CommandAssertion, context: ProbeContext): Promise<VerificationObservation> => {
      const target = `command:${assertion.parameters.commandHash}:${assertion.parameters.expectedExitCode}`;
      const observations = this.#commands.get(assertion.parameters.commandHash) ?? [];
      const known = [...observations].reverse().find((item) => item.exitCode !== undefined);
      if (known === undefined) return result("UNKNOWN", context, target,
        `snapshot:${this.#source.snapshotId}:sha256:${this.#source.contentHash}`, "SNAPSHOT_COMMAND_OBSERVATION_NOT_FOUND");
      const matched = known.exitCode === assertion.parameters.expectedExitCode;
      return result(matched ? "SUPPORTED" : "REFUTED", context, target, sourceRef(this.#source, known),
        matched ? "SNAPSHOT_COMMAND_EXIT_MATCHED" : "SNAPSHOT_COMMAND_EXIT_MISMATCH", { exitCode: known.exitCode! });
    } });
  }

  testProbe(): VerificationProbe<TestAssertion> {
    return Object.freeze({ observe: async (assertion: TestAssertion, context: ProbeContext): Promise<VerificationObservation> => {
      const target = `test:${assertion.parameters.testId}${assertion.parameters.path === undefined ? "" : `:${assertion.parameters.path}`}`;
      const observations = this.#tests.get(assertion.parameters.testId) ?? [];
      const matching = [...observations].reverse().find((item) =>
        (assertion.parameters.commandHash === undefined || item.commandHash === assertion.parameters.commandHash)
        && (assertion.parameters.path === undefined || item.path === assertion.parameters.path));
      if (matching === undefined || matching.succeeded === undefined) return result("UNKNOWN", context, target,
        `snapshot:${this.#source.snapshotId}:sha256:${this.#source.contentHash}`, "SNAPSHOT_TEST_OBSERVATION_NOT_FOUND");
      return result(matching.succeeded ? "SUPPORTED" : "REFUTED", context, target, sourceRef(this.#source, matching),
        matching.succeeded ? "SNAPSHOT_TEST_PASSED" : "SNAPSHOT_TEST_FAILED");
    } });
  }
}
