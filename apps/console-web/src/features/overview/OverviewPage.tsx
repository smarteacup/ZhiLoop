import { useCallback } from "react";

import type { ConsoleApi } from "../../api/client.js";
import { useAsync } from "../../app/useAsync.js";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";

export function OverviewPage({ api }: { readonly api: ConsoleApi }): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => await api.overview(signal), [api]);
  const [state, retry] = useAsync(load);
  if (state.status === "loading") return <LoadingState label="正在读取 ZhiLoop 状态" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const overview = state.value;
  return <div className="page-stack">
    <header className="page-header"><div><p className="eyebrow">LOCAL KNOWLEDGE CONTROL PLANE</p><h1>运行总览</h1><p>最后更新 {new Date(overview.observedAt).toLocaleString()}</p></div><StatusBadge status={overview.rolloutMode} /></header>
    <section className="metric-grid" aria-label="运行指标">
      <article className="metric-card"><span>Sidecar</span><strong>{overview.sidecarVersion}</strong></article>
      <article className="metric-card"><span>最近会话</span><strong>{overview.recentSessions.length}</strong></article>
      <article className="metric-card"><span>运行任务</span><strong>{overview.jobs.running}</strong></article>
      <article className="metric-card"><span>告警</span><strong>{overview.alertCount}</strong></article>
    </section>
    <section className="panel"><div className="section-heading"><h2>能力矩阵</h2><a href="#/deployment">查看部署详情</a></div>
      <div className="capability-grid">{overview.capabilities.map((item) => <article className="capability-card" key={item.capabilityId}><div><strong>{item.capabilityId}</strong><StatusBadge status={item.status} /></div><p>{item.reasonCode}</p><small>{item.nextAction ?? "无需操作"}</small></article>)}</div>
    </section>
    <section className="panel"><div className="section-heading"><h2>最近会话</h2><a href="#/sessions">全部会话</a></div>
      {overview.recentSessions.length === 0 ? <EmptyState title="尚未发现会话" detail="Session Catalog 可用后会在这里显示只读会话。" /> : <div className="session-list">{overview.recentSessions.map((session) => <a className="session-row" key={session.sessionId} href={`#/sessions/${encodeURIComponent(session.sessionId)}`}><div><strong>{session.title}</strong><span>{session.projectHint ?? "未识别项目"}</span></div><StatusBadge status={session.captureStatus} /><time>{new Date(session.lastActivityAt).toLocaleString()}</time></a>)}</div>}
    </section>
  </div>;
}
