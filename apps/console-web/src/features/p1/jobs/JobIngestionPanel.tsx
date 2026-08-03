import { useState } from "react";

import { StatusBadge } from "../../../components/StatusBadge.js";
import { decideRevisionAction, type RevisionActionGate } from "../actionGuard.js";

export interface JobAttemptViewModel {
  readonly attempt: number;
  readonly status: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "RETRY_WAIT";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly checkpoint?: string | undefined;
  readonly reasonCode?: string | undefined;
  readonly retryable: boolean;
}

export interface JobRowViewModel {
  readonly jobId: string;
  readonly revision: number;
  readonly jobType: string;
  readonly status: "QUEUED" | "RUNNING" | "RETRY_WAIT" | "SUCCEEDED" | "FAILED" | "CANCEL_REQUESTED" | "CANCELLED";
  readonly progress: number;
  readonly completedUnits: number;
  readonly totalUnits: number;
  readonly checkpoint?: string | undefined;
  readonly nextRetryAt?: string | undefined;
  readonly attempts: readonly JobAttemptViewModel[];
  readonly retry: RevisionActionGate;
  readonly cancel: RevisionActionGate;
}

export interface IngestionCompletenessViewModel {
  readonly catalogCoverage: "COMPLETE" | "BOUNDED";
  readonly relationCoverage: "NOT_CONFIGURED" | "COMPLETE" | "BOUNDED" | "FAILED";
  readonly currentSessions: number;
  readonly partialSessions: number;
  readonly pendingSessions: number;
  readonly sourceUnavailableSessions: number;
  readonly lastSuccessfulIngestionAt?: string | undefined;
  readonly reasonCodes: readonly string[];
}

export interface JobIngestionViewModel {
  readonly observedAt: string;
  readonly backlog: {
    readonly queued: number;
    readonly running: number;
    readonly retryWait: number;
    readonly cancelRequested: number;
  };
  readonly jobs: readonly JobRowViewModel[];
  readonly completeness: IngestionCompletenessViewModel;
}

export interface JobCommandPort {
  retry(request: { readonly jobId: string; readonly expectedRevision: number; readonly idempotencyKey: string }): Promise<void>;
  cancel(request: { readonly jobId: string; readonly expectedRevision: number; readonly idempotencyKey: string }): Promise<void>;
}

function percentage(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.round(Math.max(0, Math.min(1, progress)) * 100);
}

function JobRow({ job, commands }: { readonly job: JobRowViewModel; readonly commands?: JobCommandPort | undefined }): React.JSX.Element {
  const [pending, setPending] = useState<"retry" | "cancel" | undefined>();
  const [result, setResult] = useState<string>();
  const guardedRetry = decideRevisionAction(job.retry, commands !== undefined);
  const guardedCancel = decideRevisionAction(job.cancel, commands !== undefined);
  const retryStateAllowed = job.status === "FAILED" || job.status === "RETRY_WAIT";
  const cancelStateAllowed = job.status === "QUEUED" || job.status === "RUNNING" || job.status === "RETRY_WAIT";
  const retryDecision = retryStateAllowed ? guardedRetry : { enabled: false, reason: `状态 ${job.status} 不允许重试` };
  const cancelDecision = cancelStateAllowed ? guardedCancel : { enabled: false, reason: `状态 ${job.status} 不允许取消` };

  const execute = async (action: "retry" | "cancel"): Promise<void> => {
    const gate = action === "retry" ? job.retry : job.cancel;
    const decision = action === "retry" ? retryDecision : cancelDecision;
    if (!decision.enabled || commands === undefined || pending !== undefined) return;
    setPending(action);
    setResult(undefined);
    try {
      await commands[action]({ jobId: job.jobId, expectedRevision: gate.expectedRevision, idempotencyKey: gate.idempotencyKey });
      setResult(action === "retry" ? "已提交安全重试请求，等待状态刷新。" : "已提交取消请求；任务将在安全边界停止。" );
    } catch (error) {
      setResult(error instanceof Error ? error.message : "命令执行失败");
    } finally {
      setPending(undefined);
    }
  };

  const progress = percentage(job.progress);
  return <article className="panel" aria-labelledby={`job-${job.jobId}`}>
    <div className="section-heading"><div><h3 id={`job-${job.jobId}`}>{job.jobType}</h3><small>{job.jobId}</small></div><StatusBadge status={job.status} /></div>
    <div role="progressbar" aria-label={`${job.jobType} 进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
      <strong>{progress}%</strong> · {job.completedUnits}/{job.totalUnits}
    </div>
    <p className="muted">checkpoint: {job.checkpoint ?? "尚未生成"}{job.nextRetryAt === undefined ? "" : ` · 下次重试 ${new Date(job.nextRetryAt).toLocaleString()}`}</p>
    <details><summary>Attempt 历史（{job.attempts.length}）</summary>
      <ol>{job.attempts.map((attempt) => <li key={attempt.attempt}><strong>#{attempt.attempt}</strong> <StatusBadge status={attempt.status} /> <span>{new Date(attempt.startedAt).toLocaleString()}</span><small>{attempt.reasonCode ?? (attempt.retryable ? "可重试" : "无诊断")}</small></li>)}</ol>
    </details>
    <div className="capture-actions">
      <button type="button" className="secondary-button" aria-label={`${job.jobType} 安全重试`} disabled={!retryDecision.enabled || pending !== undefined} title={retryDecision.reason} onClick={() => void execute("retry")}>{pending === "retry" ? "正在请求重试…" : "安全重试"}</button>
      <button type="button" className="secondary-button" aria-label={`${job.jobType} 请求取消`} disabled={!cancelDecision.enabled || pending !== undefined} title={cancelDecision.reason} onClick={() => void execute("cancel")}>{pending === "cancel" ? "正在请求取消…" : "请求取消"}</button>
    </div>
    {!retryDecision.enabled ? <p className="muted">重试不可用：{retryDecision.reason}</p> : undefined}
    {!cancelDecision.enabled ? <p className="muted">取消不可用：{cancelDecision.reason}</p> : undefined}
    {result === undefined ? undefined : <p role="status" aria-live="polite">{result}</p>}
  </article>;
}

export function JobIngestionPanel({ viewModel, commands }: { readonly viewModel: JobIngestionViewModel; readonly commands?: JobCommandPort }): React.JSX.Element {
  const completeness = viewModel.completeness;
  return <div className="page-stack">
    <section className="metric-grid" aria-label="任务积压">
      <article className="metric-card"><span>排队</span><strong>{viewModel.backlog.queued}</strong></article>
      <article className="metric-card"><span>运行</span><strong>{viewModel.backlog.running}</strong></article>
      <article className="metric-card"><span>等待重试</span><strong>{viewModel.backlog.retryWait}</strong></article>
      <article className="metric-card"><span>请求取消</span><strong>{viewModel.backlog.cancelRequested}</strong></article>
    </section>
    <section className="panel" aria-labelledby="ingestion-completeness-heading">
      <div className="section-heading"><div><h2 id="ingestion-completeness-heading">自动采集完整性</h2><p>最后观测 {new Date(viewModel.observedAt).toLocaleString()}</p></div><StatusBadge status={completeness.catalogCoverage} /></div>
      <dl className="detail-grid">
        <div><dt>当前</dt><dd>{completeness.currentSessions}</dd></div><div><dt>部分</dt><dd>{completeness.partialSessions}</dd></div>
        <div><dt>待处理</dt><dd>{completeness.pendingSessions}</dd></div><div><dt>来源不可用</dt><dd>{completeness.sourceUnavailableSessions}</dd></div>
        <div><dt>子会话关系</dt><dd>{completeness.relationCoverage}</dd></div><div><dt>最近成功</dt><dd>{completeness.lastSuccessfulIngestionAt === undefined ? "尚未成功" : new Date(completeness.lastSuccessfulIngestionAt).toLocaleString()}</dd></div>
      </dl>
      {completeness.reasonCodes.length === 0 ? undefined : <ul aria-label="采集完整性诊断">{completeness.reasonCodes.map((code) => <li key={code}>{code}</li>)}</ul>}
    </section>
    <section aria-labelledby="job-progress-heading"><h2 id="job-progress-heading">任务进度</h2>
      {viewModel.jobs.length === 0 ? <p className="muted">当前没有任务。</p> : viewModel.jobs.map((job) => <JobRow key={job.jobId} job={job} commands={commands} />)}
    </section>
  </div>;
}
