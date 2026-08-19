import { useState } from "react";

import { StatusBadge } from "../../../components/StatusBadge.js";
import { decideRevisionAction, type RevisionActionGate } from "../actionGuard.js";

export interface ConsoleAlertViewModel {
  readonly alertId: string;
  readonly severity: "INFO" | "WARNING" | "CRITICAL";
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly healthState: "READY" | "DEGRADED" | "FAILED";
  readonly triggeredAt: string;
  readonly quietHoursSuppressed: boolean;
}

export interface LiveInvalidationViewModel {
  readonly connection: "LIVE" | "RECONNECTING" | "POLLING" | "RESYNC_REQUIRED" | "OFFLINE";
  readonly revision: number;
  readonly lastEventId?: string | undefined;
  readonly lastEventAt?: string | undefined;
  readonly pollingIntervalMs?: number | undefined;
  readonly invalidatedResources: readonly ("JOBS" | "SESSIONS" | "CONFIGURATION" | "ALERTS" | "OPERATIONS" | "CODEGRAPH" | "MIGRATIONS" | "KNOWLEDGE")[];
  readonly refresh: RevisionActionGate;
}

export interface DegradedNotificationViewModel {
  readonly notificationId: string;
  readonly area: string;
  readonly state: "DEGRADED" | "FAILED" | "NOT_VERIFIED";
  readonly reasonCode: string;
  readonly detail: string;
  readonly observedAt: string;
  readonly nextAction?: string;
}

export interface LiveOperationsViewModel {
  readonly alerts: readonly ConsoleAlertViewModel[];
  readonly live: LiveInvalidationViewModel;
  readonly notifications: readonly DegradedNotificationViewModel[];
}

export interface LiveRefreshPort {
  refresh(request: { readonly expectedRevision: number; readonly resources: readonly string[]; readonly idempotencyKey: string }): Promise<void>;
}

export function LiveOperationsPanel({ viewModel, commands }: { readonly viewModel: LiveOperationsViewModel; readonly commands?: LiveRefreshPort }): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const guardedRefresh = decideRevisionAction(viewModel.live.refresh, commands !== undefined);
  const decision = viewModel.live.invalidatedResources.length === 0
    ? { enabled: false, reason: "没有待刷新的失效资源" }
    : guardedRefresh;
  const refresh = async (): Promise<void> => {
    if (!decision.enabled || commands === undefined || pending) return;
    setPending(true);
    setMessage(undefined);
    try {
      await commands.refresh({
        expectedRevision: viewModel.live.refresh.expectedRevision,
        resources: viewModel.live.invalidatedResources,
        idempotencyKey: viewModel.live.refresh.idempotencyKey,
      });
      setMessage("已按当前 revision 请求刷新失效视图。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "刷新失败；保留当前降级提示并继续安全轮询");
    } finally {
      setPending(false);
    }
  };

  return <div className="page-stack">
    <section className="panel" aria-labelledby="live-update-heading"><div className="section-heading"><div><h2 id="live-update-heading">实时更新</h2><p>revision {viewModel.live.revision} · {viewModel.live.lastEventId ?? "尚无事件"} · {viewModel.live.lastEventAt === undefined ? "尚无事件时间" : new Date(viewModel.live.lastEventAt).toLocaleString()}</p></div><StatusBadge status={viewModel.live.connection} /></div>
      <p>{viewModel.live.connection === "LIVE" ? "SSE 正常；业务正文仍通过有界查询读取。" : viewModel.live.connection === "POLLING" ? `SSE 已降级，按 ${viewModel.live.pollingIntervalMs ?? "受控"}ms 轮询。` : "实时通道不可用；不会据此隐藏后端健康状态。"}</p>
      <p>待刷新：{viewModel.live.invalidatedResources.length === 0 ? "无" : viewModel.live.invalidatedResources.join(", ")}</p>
      <button type="button" className="secondary-button" disabled={!decision.enabled || pending} title={decision.reason} onClick={() => void refresh()}>{pending ? "正在刷新…" : "刷新失效视图"}</button>
      {!decision.enabled ? <p className="muted">刷新不可用：{decision.reason}</p> : undefined}
      {message === undefined ? undefined : <p role="status" aria-live="polite">{message}</p>}
    </section>
    <section className="panel" aria-labelledby="alerts-heading"><h2 id="alerts-heading">控制台内告警</h2>
      {viewModel.alerts.length === 0 ? <p className="muted">当前没有活动告警。</p> : <ul>{viewModel.alerts.map((alert) => <li key={alert.alertId}><div><strong>{alert.title}</strong> <StatusBadge status={alert.severity} /> <StatusBadge status={alert.healthState} /></div><p>{alert.code} — {alert.detail}</p><small>{new Date(alert.triggeredAt).toLocaleString()}{alert.quietHoursSuppressed ? " · 通知处于静默时段，但健康状态仍可见" : ""}</small></li>)}</ul>}
    </section>
    <section aria-labelledby="degraded-notifications-heading"><h2 id="degraded-notifications-heading">降级与未验证状态</h2>
      {viewModel.notifications.length === 0 ? <p className="muted">没有降级通知。</p> : viewModel.notifications.map((item) => <article className="inline-alert warning" role="status" key={item.notificationId}><div><strong>{item.area}</strong> <StatusBadge status={item.state} /></div><p>{item.reasonCode} — {item.detail}</p><small>{new Date(item.observedAt).toLocaleString()} · {item.nextAction ?? "等待后端证据更新"}</small></article>)}
    </section>
  </div>;
}
