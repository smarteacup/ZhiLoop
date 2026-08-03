import { useCallback } from "react";

import type { P4ConsoleApi, RolloutView } from "../../api/p4.js";
import { useAsync } from "../../app/useAsync.js";
import { ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";

export function RolloutPage({ api }: { readonly api: Pick<P4ConsoleApi, "rollout"> }): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => await api.rollout(signal), [api]);
  const [state, retry] = useAsync(load);
  if (state.status === "loading") return <LoadingState label="正在读取 rollout 证据" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const view = state.value;
  return <div className="page-stack"><header className="page-header"><div><p className="eyebrow">ROLLOUT</p><h1>SHADOW 质量与灰度</h1><p>ACTIVE 必须绑定真实 trace、dataset/config/version 指纹与范围，不提供单布尔开关。</p></div><StatusBadge status={view.capabilityStatus} /></header>
    {view.capabilityStatus !== "READY" ? <div className="inline-alert warning"><strong>{view.capabilityReasonCode}</strong><p>rollout 能力未就绪，页面保持只读且不会显示可激活状态。</p></div> : undefined}
    <section className="panel"><div className="section-heading"><h2>Effective revision {view.stateRevision}</h2><StatusBadge status={view.effective.mode} /></div><dl className="detail-grid"><div><dt>Policy</dt><dd>r{view.effective.policyRevision}</dd></div><div><dt>Config fingerprint</dt><dd>{view.effective.configFingerprint}</dd></div><div><dt>Version fingerprint</dt><dd>{view.effective.versionFingerprint}</dd></div><div><dt>Evidence</dt><dd>{view.effective.evidenceId ?? "未绑定"}</dd></div></dl><CanaryScope value={view.effective.canary} /></section>
    <section className="panel"><h2>Last-known-good</h2><p><StatusBadge status={view.lastKnownGood.mode} /> policy r{view.lastKnownGood.policyRevision} · {view.lastKnownGood.configFingerprint}</p>{view.lastTransition === undefined ? <p className="muted">没有 transition 记录。</p> : <div className={`inline-alert ${view.lastTransition.kind === "DOWNGRADED" ? "warning" : ""}`}><strong>{view.lastTransition.kind}</strong><p>{view.lastTransition.reasonCodes.join(", ")} · {new Date(view.lastTransition.occurredAt).toLocaleString()}</p></div>}</section>
    <section className="panel"><h2>SHADOW eligibility evidence</h2>{view.eligibility.length === 0 ? <p className="muted">没有资格证据，因此不能推断可进入 ACTIVE。</p> : view.eligibility.map((evidence) => <article className="fact-row" key={evidence.evidenceId}><div className="section-heading"><div><strong>{evidence.evidenceId}</strong><small>{evidence.traceCount} persisted traces · {new Date(evidence.createdAt).toLocaleString()}</small></div><StatusBadge status={evidence.eligible ? "ELIGIBLE" : "INELIGIBLE"} /></div><dl className="detail-grid"><div><dt>Dataset</dt><dd>{evidence.datasetFingerprint}</dd></div><div><dt>Config</dt><dd>{evidence.configFingerprint}</dd></div><div><dt>Versions</dt><dd>{evidence.versionFingerprint}</dd></div></dl><ul>{evidence.checks.map((check) => <li key={check.code}><StatusBadge status={check.passed ? "SATISFIED" : "UNSATISFIED"} /> {check.code} · {check.detail}</li>)}</ul></article>)}</section>
  </div>;
}

function CanaryScope({ value }: { readonly value: RolloutView["effective"]["canary"] }): React.JSX.Element {
  if (value === undefined) return <div className="inline-alert warning"><strong>没有 scoped canary</strong><p>当前 revision 不包含灰度范围。</p></div>;
  return <div><h3>Scoped canary</h3><dl className="detail-grid"><div><dt>项目</dt><dd>{value.projectIds?.join(", ") || "无"}</dd></div><div><dt>会话</dt><dd>{value.sessionIds?.join(", ") || "无"}</dd></div><div><dt>任务</dt><dd>{value.taskIds?.join(", ") || "无"}</dd></div><div><dt>比例</dt><dd>{value.percentageBasisPoints === undefined ? "无" : `${(value.percentageBasisPoints / 100).toFixed(2)}%`}</dd></div></dl></div>;
}
