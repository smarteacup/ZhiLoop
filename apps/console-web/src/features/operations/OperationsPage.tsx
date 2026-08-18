import { useCallback } from "react";

import type { ConsoleApi } from "../../api/client.js";
import { useAsync } from "../../app/useAsync.js";
import { ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { p2EnumLabel } from "../p2/labels.js";

export function OperationsPage({ api }: { readonly api: ConsoleApi }): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => await Promise.all([api.jobs(signal), api.diagnostics(signal)]), [api]);
  const [state, retry] = useAsync(load);
  if (state.status === "loading") return <LoadingState label="正在读取任务与诊断" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const [jobs, diagnostics] = state.value;
  return <div className="page-stack"><header className="page-header"><div><p className="eyebrow">OPERATIONS</p><h1>任务与诊断</h1><p>这里只展示安全元数据，不显示 prompt 或凭证。</p></div></header>
    <section className="metric-grid"><article className="metric-card"><span>Ledger sequence</span><strong>{diagnostics.ledgerSequence}</strong></article><article className="metric-card"><span>Spool</span><strong>{diagnostics.spoolDepth}</strong></article><article className="metric-card"><span>Worker</span><strong>{diagnostics.worker.healthy ? "健康" : "异常"}</strong></article><article className="metric-card"><span>数据库</span><strong>{Math.round(diagnostics.storage.databaseBytes / 1024)} KB</strong></article></section>
    <section className="panel"><h2>后台任务</h2>{jobs.items.length === 0 ? <p className="muted">当前没有后台任务。</p> : <div className="job-list">{jobs.items.map((job) => <article key={job.jobId}><div><strong title={job.jobType}>{p2EnumLabel(job.jobType)}</strong><StatusBadge status={job.status} /></div><p>尝试 {job.attempt}/{job.maxAttempts} · 进度 {Math.round(job.progress * 100)}%</p><small title={job.reasonCode}>{p2EnumLabel(job.reasonCode)}</small></article>)}</div>}</section>
    <section className="panel"><h2>Consumer lag</h2><dl className="detail-grid">{diagnostics.consumerLags.map((item) => <div key={item.consumerId}><dt>{item.consumerId}</dt><dd>{item.lag}</dd></div>)}</dl></section>
  </div>;
}
