import type { CodexBackfillService } from "@zhiloop/codex-backfill";

import type {
  BackfillRecoveryPort,
  BackfillRecoveryRequest,
  BackfillRequestFactory,
  SourceCheckpointRecoveryPort,
} from "./types.js";

/** Reuses codex-backfill's own durable run/thread checkpoints for idempotent recovery. */
export class CodexBackfillRecoveryAdapter implements BackfillRecoveryPort {
  constructor(
    private readonly backfill: Pick<CodexBackfillService, "execute">,
    private readonly requests: BackfillRequestFactory,
    private readonly sourceCheckpoints: SourceCheckpointRecoveryPort,
  ) {}

  async recover(request: BackfillRecoveryRequest) {
    const backfillRequest = this.requests.create(request);
    if (backfillRequest.dryRun !== false) throw new Error("automatic recovery requires live codex backfill");
    const report = await this.backfill.execute(backfillRequest);
    const sourceCheckpoint = report.status === "COMPLETED"
      ? await this.sourceCheckpoints.rebase(request)
      : "NOT_REBASED";
    return Object.freeze({ report, sourceCheckpoint });
  }
}
