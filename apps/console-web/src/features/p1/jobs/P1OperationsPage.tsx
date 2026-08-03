import { useCallback } from "react";

import type { CapabilitySnapshot, Diagnostics, JobSnapshot, Overview, SessionSummary } from "@zhiloop/control-api";

import type { ConsoleApi } from "../../../api/client.js";
import { useAsync } from "../../../app/useAsync.js";
import { ErrorState, LoadingState } from "../../../components/AsyncState.js";
import type { CapabilityGate, RevisionActionGate } from "../actionGuard.js";
import { LiveOperationsPanel, type ConsoleAlertViewModel, type DegradedNotificationViewModel, type LiveOperationsViewModel } from "../live/LiveOperationsPanel.js";
import { useInvalidationFeed } from "../live/useInvalidationFeed.js";
import { JobIngestionPanel, type JobAttemptViewModel, type JobIngestionViewModel, type JobRowViewModel } from "./JobIngestionPanel.js";

export type OperationsPageMode = "combined" | "jobs" | "diagnostics";

const JOB_ACTION_UNAVAILABLE: CapabilityGate = Object.freeze({
  status: "NOT_CONFIGURED",
  reasonCode: "JOB_COMMAND_CONTRACT_NOT_CONFIGURED",
  observedAt: "1970-01-01T00:00:00.000Z",
});

function jobAction(job: JobSnapshot, action: "cancel" | "retry", capability?: CapabilitySnapshot): RevisionActionGate {
  const revision = job.revision ?? -1;
  const ready = capability?.status === "READY";
  const stateAllowed = action === "cancel"
    ? (job.status === "QUEUED" || job.status === "RUNNING" || job.status === "RETRY_WAIT") && job.cancellation?.status !== "REQUESTED"
    : job.status === "RETRY_WAIT" || (job.status === "FAILED" && job.lastFailure?.retryable === true);
  const allowed = job.revision !== undefined && stateAllowed;
  return {
    capability: ready ? {
      status: "READY",
      reasonCode: capability.reasonCode,
      observedAt: capability.observedAt,
    } : capability === undefined ? JOB_ACTION_UNAVAILABLE : {
      status: capability.status === "STARTING" || capability.status === "NOT_IMPLEMENTED" ? "NOT_CONFIGURED" : capability.status,
      reasonCode: capability.reasonCode,
      observedAt: capability.observedAt,
    },
    allowed,
    expectedRevision: revision,
    currentRevision: revision,
    idempotencyKey: `job-${action}-${job.revision === undefined ? "missing" : job.revision}-${job.jobId}`,
    blockedReason: job.revision === undefined
      ? "Job 快照缺少 revision"
      : action === "cancel" && job.cancellation?.status === "REQUESTED"
        ? "取消请求已提交"
        : `状态 ${job.status} 不允许${action === "cancel" ? "取消" : "重试"}`,
  };
}

function attempt(job: JobSnapshot): JobAttemptViewModel[] {
  if (job.attempt === 0) return [];
  const status: JobAttemptViewModel["status"] = job.status === "RUNNING"
    ? "RUNNING"
    : job.status === "SUCCEEDED"
      ? "SUCCEEDED"
      : job.status === "CANCELLED"
        ? "CANCELLED"
        : job.status === "RETRY_WAIT" ? "RETRY_WAIT" : "FAILED";
  return [{
    attempt: job.attempt,
    status,
    startedAt: job.startedAt ?? job.observedAt,
    ...(job.completedAt === undefined ? {} : { finishedAt: job.completedAt }),
    ...(job.checkpoint === undefined ? {} : { checkpoint: `revision ${job.checkpoint.revision}` }),
    reasonCode: job.lastFailure?.code ?? job.reasonCode,
    retryable: job.lastFailure?.retryable ?? job.retryable,
  }];
}

function jobRow(job: JobSnapshot, capability?: CapabilitySnapshot): JobRowViewModel {
  return {
    jobId: job.jobId,
    revision: job.revision ?? -1,
    jobType: job.jobType,
    status: job.status,
    progress: job.progress,
    completedUnits: Math.round(job.progress * 100),
    totalUnits: 100,
    ...(job.checkpoint === undefined ? {} : { checkpoint: `revision ${job.checkpoint.revision} · ${job.checkpoint.payloadHash.slice(0, 12)}` }),
    ...(job.nextAttemptAt === undefined ? {} : { nextRetryAt: job.nextAttemptAt }),
    attempts: attempt(job),
    retry: jobAction(job, "retry", capability),
    cancel: jobAction(job, "cancel", capability),
  };
}

export function jobIngestionViewModel(
  jobs: readonly JobSnapshot[],
  sessions: readonly SessionSummary[],
  sessionsBounded: boolean,
  observedAt: string,
  jobCapability?: CapabilitySnapshot,
): JobIngestionViewModel {
  const successful = jobs.filter((job) => job.status === "SUCCEEDED" && job.completedAt !== undefined)
    .map((job) => job.completedAt as string)
    .sort()
    .at(-1);
  const reasonCodes = new Set<string>();
  if (sessionsBounded) reasonCodes.add("SESSION_PAGE_BOUNDED");
  if (sessions.some((session) => session.sourceStatus !== "AVAILABLE")) reasonCodes.add("SOURCE_UNAVAILABLE");
  return {
    observedAt,
    backlog: {
      queued: jobs.filter((job) => job.status === "QUEUED").length,
      running: jobs.filter((job) => job.status === "RUNNING").length,
      retryWait: jobs.filter((job) => job.status === "RETRY_WAIT").length,
      cancelRequested: jobs.filter((job) => job.cancellation?.status === "REQUESTED").length,
    },
    jobs: jobs.map((job) => jobRow(job, jobCapability)),
    completeness: {
      catalogCoverage: sessionsBounded ? "BOUNDED" : "COMPLETE",
      relationCoverage: "NOT_CONFIGURED",
      currentSessions: sessions.filter((session) => session.captureStatus === "CAPTURED_CURRENT").length,
      partialSessions: sessions.filter((session) => session.captureStatus === "CAPTURED_PARTIAL").length,
      pendingSessions: sessions.filter((session) => session.captureStatus === "DISCOVERED_NOT_CAPTURED").length,
      sourceUnavailableSessions: sessions.filter((session) => session.sourceStatus !== "AVAILABLE").length,
      ...(successful === undefined ? {} : { lastSuccessfulIngestionAt: successful }),
      reasonCodes: [...reasonCodes],
    },
  };
}

function alerts(overview: Overview, diagnostics: Diagnostics): ConsoleAlertViewModel[] {
  const reportedAlerts: ConsoleAlertViewModel[] = (diagnostics.alerts?.activeAlerts ?? []).map((alert) => ({
    alertId: alert.alertId,
    severity: alert.severity === "ERROR" ? "CRITICAL" : "WARNING",
    code: alert.reasonCodes.join("+") || "ALERT_THRESHOLD_EXCEEDED",
    title: `${alert.entityType} · ${alert.entityId}`,
    detail: `观测值 ${alert.observedValue}，阈值 ${alert.threshold}`,
    healthState: diagnostics.alerts?.health === "FAILED" ? "FAILED" : "DEGRADED",
    triggeredAt: alert.observedAt,
    quietHoursSuppressed: diagnostics.alerts?.quietHoursActive === true && !alert.notificationDelivered,
  }));
  const result: ConsoleAlertViewModel[] = [...reportedAlerts];
  if (overview.alertCount > reportedAlerts.length) result.push({
    alertId: "reported-alert-count",
    severity: "WARNING",
    code: "ACTIVE_ALERTS_REPORTED",
    title: `${overview.alertCount - reportedAlerts.length} 个未展开活动告警`,
    detail: "Overview 告警计数高于 Diagnostics 明细；保留差额提示，不猜测具体内容。",
    healthState: "DEGRADED",
    triggeredAt: overview.observedAt,
    quietHoursSuppressed: false,
  });
  if (!diagnostics.worker.healthy) result.push({
    alertId: "worker-unhealthy",
    severity: "CRITICAL",
    code: "WORKER_UNHEALTHY",
    title: "后台 Worker 异常",
    detail: `retryable failures ${diagnostics.worker.retryableFailures}`,
    healthState: "FAILED",
    triggeredAt: diagnostics.observedAt,
    quietHoursSuppressed: false,
  });
  if (!diagnostics.storage.healthy) result.push({
    alertId: "storage-unhealthy",
    severity: "CRITICAL",
    code: "STORAGE_UNHEALTHY",
    title: "本地存储异常",
    detail: `database bytes ${diagnostics.storage.databaseBytes}`,
    healthState: "FAILED",
    triggeredAt: diagnostics.observedAt,
    quietHoursSuppressed: false,
  });
  return result;
}

function notifications(overview: Overview, connection: LiveOperationsViewModel["live"]["connection"]): DegradedNotificationViewModel[] {
  const result: DegradedNotificationViewModel[] = overview.capabilities
    .filter((capability) => capability.status === "DEGRADED" || capability.status === "FAILED" || capability.status === "NOT_VERIFIED")
    .map((capability) => ({
      notificationId: `capability-${capability.capabilityId}`,
      area: capability.capabilityId,
      state: capability.status as DegradedNotificationViewModel["state"],
      reasonCode: capability.reasonCode,
      detail: capability.retryable ? "能力处于可重试异常状态" : "能力尚无可用成功证据",
      observedAt: capability.observedAt,
      ...(capability.nextAction === undefined ? {} : { nextAction: capability.nextAction }),
    }));
  if (connection !== "LIVE") result.push({
    notificationId: "live-invalidation-degraded",
    area: "Console 实时更新",
    state: "DEGRADED",
    reasonCode: connection === "OFFLINE" ? "INVALIDATION_CHANNEL_OFFLINE" : "INVALIDATION_POLLING_FALLBACK",
    detail: "实时通道未处于 LIVE；页面使用有界轮询或等待重连。",
    observedAt: overview.observedAt,
    nextAction: "检查 Gateway 后继续安全轮询",
  });
  return result;
}

function DiagnosticsSummary({ diagnostics }: { readonly diagnostics: Diagnostics }): React.JSX.Element {
  return <section className="panel" aria-labelledby="diagnostics-summary-heading"><h2 id="diagnostics-summary-heading">运行诊断</h2><dl className="detail-grid">
    <div><dt>Ledger sequence</dt><dd>{diagnostics.ledgerSequence}</dd></div><div><dt>Spool depth</dt><dd>{diagnostics.spoolDepth}</dd></div>
    <div><dt>Worker</dt><dd>{diagnostics.worker.healthy ? "健康" : "异常"}</dd></div><div><dt>Storage</dt><dd>{diagnostics.storage.healthy ? "健康" : "异常"}</dd></div>
  </dl>{diagnostics.consumerLags.length === 0 ? <p className="muted">没有 Consumer lag 记录。</p> : <ul>{diagnostics.consumerLags.map((lag) => <li key={lag.consumerId}>{lag.consumerId}: {lag.lag}</li>)}</ul>}</section>;
}

export function P1OperationsPage({ api, mode = "combined" }: { readonly api: ConsoleApi; readonly mode?: OperationsPageMode }): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => await Promise.all([api.jobs(signal), api.diagnostics(signal), api.overview(signal), api.sessions(signal)]), [api]);
  const [state, retry] = useAsync(load);
  const invalidate = useCallback((resources: readonly string[]) => {
    if (resources.some((resource) => resource === "JOBS" || resource === "SESSIONS" || resource === "ALERTS")) retry();
  }, [retry]);
  const feed = useInvalidationFeed(api, invalidate);
  if (state.status === "loading") return <LoadingState label="正在读取任务、采集与诊断状态" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const [jobPage, diagnostics, overview, sessionPage] = state.value;
  const jobCapability = overview.capabilities.find(({ capabilityId }) => capabilityId === "durable.jobs");
  const jobView = jobIngestionViewModel(jobPage.items, sessionPage.items, sessionPage.nextCursor !== undefined, diagnostics.observedAt, jobCapability);
  const liveView: LiveOperationsViewModel = {
    live: {
      connection: feed.connection,
      revision: feed.revision,
      ...(feed.lastEventId === undefined ? {} : { lastEventId: feed.lastEventId }),
      ...(feed.lastEventAt === undefined ? {} : { lastEventAt: feed.lastEventAt }),
      ...(feed.pollingIntervalMs === undefined ? {} : { pollingIntervalMs: feed.pollingIntervalMs }),
      invalidatedResources: feed.invalidatedResources,
      refresh: {
        capability: {
          status: feed.connection === "OFFLINE" ? "DEGRADED" : "READY",
          reasonCode: feed.connection === "OFFLINE" ? "INVALIDATION_CHANNEL_OFFLINE" : "INVALIDATION_QUERY_AVAILABLE",
          observedAt: diagnostics.observedAt,
        },
        allowed: feed.invalidatedResources.length > 0,
        expectedRevision: feed.revision,
        currentRevision: feed.revision,
        idempotencyKey: `invalidation-refresh-${feed.revision}`,
        blockedReason: "没有待刷新的资源",
      },
    },
    alerts: alerts(overview, diagnostics),
    notifications: notifications(overview, feed.connection),
  };
  const refresh = async (): Promise<void> => {
    retry();
    feed.acknowledge();
  };
  const jobCommands = api.cancelJob === undefined || api.retryJob === undefined ? undefined : {
    cancel: async (command: Parameters<NonNullable<ConsoleApi["cancelJob"]>>[0]) => { await api.cancelJob?.(command); retry(); },
    retry: async (command: Parameters<NonNullable<ConsoleApi["retryJob"]>>[0]) => { await api.retryJob?.(command); retry(); },
  };
  return <div className="page-stack"><header className="page-header"><div><p className="eyebrow">P1 OPERATIONS</p><h1>{mode === "jobs" ? "后台任务" : mode === "diagnostics" ? "诊断与告警" : "任务、采集与诊断"}</h1><p>状态与安全写命令来自 typed Control API；命令受 revision、幂等键与 Job 状态机保护。</p></div></header>
    {mode === "diagnostics" ? undefined : <JobIngestionPanel viewModel={jobView} {...(jobCommands === undefined ? {} : { commands: jobCommands })} />}
    {mode === "jobs" ? undefined : <><DiagnosticsSummary diagnostics={diagnostics} /><LiveOperationsPanel viewModel={liveView} commands={{ refresh }} /></>}
  </div>;
}
