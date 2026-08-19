import { useCallback, useState } from "react";

import type { ConsoleApi } from "../../api/client.js";
import { useBoundedOperation } from "../../app/useBoundedOperation.js";
import { useInvalidationFeed } from "../p1/live/useInvalidationFeed.js";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState.js";
import { OperationDiagnostic } from "../../components/OperationDiagnostic.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { operationLabel } from "../p2/labels.js";

export function AlertsPage({ api }: { readonly api: ConsoleApi }): React.JSX.Element {
  const [failure, setFailure] = useState<Error | undefined>(); const [busy, setBusy] = useState<string | undefined>();
  const [projectFilter, setProjectFilter] = useState(""); const [projectId, setProjectId] = useState("");
  const [cursor, setCursor] = useState<string>();
  const load = useCallback(async (signal: AbortSignal) => {
    if (api.operationalAlerts === undefined) throw new Error("告警中心尚未接通"); return await api.operationalAlerts(projectId || undefined, cursor, signal);
  }, [api, cursor, projectId]);
  const [state, retry] = useBoundedOperation(load, () => false);
  const invalidate = useCallback((resources: readonly string[]) => { if (resources.includes("ALERTS")) retry(); }, [retry]);
  useInvalidationFeed(api, invalidate);
  const act = async (alertId: string, revision: number, kind: "ack" | "suppress"): Promise<void> => {
    setBusy(alertId); setFailure(undefined);
    try {
      const idempotencyKey = `alert:${kind}:${alertId}:${revision}`;
      if (kind === "ack") await api.acknowledgeOperationalAlert?.({ alertId, expectedRevision: revision, idempotencyKey });
      else await api.suppressOperationalAlert?.({ alertId, expectedRevision: revision, idempotencyKey,
        suppressedUntil: new Date(Date.now() + 60 * 60_000).toISOString() });
      retry();
    } catch (error) { setFailure(error instanceof Error ? error : new Error("告警操作失败")); }
    finally { setBusy(undefined); }
  };
  if (state.status === "loading") return <LoadingState label="正在加载本地告警" /> as React.JSX.Element;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} /> as React.JSX.Element;
  return <div className="page-stack"><header className="page-header"><span className="eyebrow">ALERTS</span><h1>告警中心</h1>
    <p>确认和静默只记录操作状态，不会删除告警或改变底层健康事实。</p></header>
    <section className="panel"><label>项目筛选<input value={projectFilter} onChange={(event) => setProjectFilter(event.currentTarget.value)} placeholder="留空查看全部" /></label>
      <button type="button" onClick={() => { setCursor(undefined); setProjectId(projectFilter.trim()); }}>应用筛选</button></section>
    {failure === undefined ? null : <OperationDiagnostic value={{ reasonCode: "ALERT_COMMAND_FAILED", message: failure.message, retryable: false,
      suggestedAction: "刷新告警 revision 后由操作者再次确认" }} />}
    {state.value.items.length === 0 ? <EmptyState title="当前没有持久化告警" detail="后台异常出现时会在这里聚合展示。" />
      : state.value.items.map((alert) => <section className="panel" key={alert.alertId}>
        <div className="section-heading"><div><h2 title={alert.type}>{operationLabel(alert.type)}</h2><p>{alert.entityRef ?? "无关联实体"}</p></div>
          <StatusBadge status={alert.severity} /></div>
        <p>累计 {alert.occurrenceCount} 次 · 最近 {new Date(alert.lastObservedAt).toLocaleString()} · <span title={alert.deliveryState}>{operationLabel(alert.deliveryState)}</span></p>
        <OperationDiagnostic value={alert.diagnostic} />
        {alert.entityRef === undefined ? null : <a href={alert.type === "PERMANENT_JOB_FAILURE" ? "#/jobs"
          : alert.type === "STALE_KNOWLEDGE" ? `#/knowledge/${encodeURIComponent(alert.entityRef.split("@", 1)[0] ?? alert.entityRef)}`
            : alert.type === "MIGRATION_FAILED" ? "#/migrations" : "#/codegraph"}>查看关联对象</a>}
        {alert.operatorState?.acknowledgedAt === undefined ? null : <p>已于 {new Date(alert.operatorState.acknowledgedAt).toLocaleString()} 确认</p>}
        {alert.operatorState?.suppressedUntil === undefined ? null : <p>静默至 {new Date(alert.operatorState.suppressedUntil).toLocaleString()}；严重告警仍保持可见。</p>}
        <button type="button" disabled={busy === alert.alertId} onClick={() => { void act(alert.alertId, alert.revision, "ack"); }}>确认已知</button>
        <button type="button" disabled={busy === alert.alertId} onClick={() => { void act(alert.alertId, alert.revision, "suppress"); }}>静默 1 小时</button>
      </section>)}
    {state.value.nextCursor === undefined ? null : <button type="button" className="secondary-button"
      onClick={() => setCursor(state.value.nextCursor)}>查看下一页告警</button>}
    {state.value.bounded ? <p className="muted">当前结果已按安全上限分页。</p> : null}
  </div>;
}
