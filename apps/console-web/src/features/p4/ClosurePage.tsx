import { useCallback, useEffect, useRef, useState } from "react";

import type { ClosureRunView, P4ConsoleApi } from "../../api/p4.js";
import { useAsync } from "../../app/useAsync.js";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";

export function ClosurePage({ api, sessionId }: { readonly api: Pick<P4ConsoleApi, "closureRuns" | "closureRun">; readonly sessionId?: string }): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => await api.closureRuns(sessionId, signal), [api, sessionId]);
  const [state, retry] = useAsync(load);
  const [selected, setSelected] = useState<ClosureRunView>();
  const [detailState, setDetailState] = useState<"idle" | "loading" | "error">("idle");
  const [detailError, setDetailError] = useState<string>();
  const detailController = useRef<AbortController | undefined>(undefined);
  useEffect(() => setSelected(undefined), [sessionId]);
  useEffect(() => () => detailController.current?.abort(), []);
  if (state.status === "loading") return <LoadingState label="正在读取闭环运行" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const view = state.value;
  const select = async (summary: ClosureRunView): Promise<void> => {
    setDetailState("loading"); setDetailError(undefined);
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    try {
      const detail = await api.closureRun(summary.closureRunId, controller.signal);
      if (!controller.signal.aborted) { setSelected(detail); setDetailState("idle"); }
    }
    catch (error) { if (!controller.signal.aborted) { setDetailError(error instanceof Error ? error.message : "CLOSURE_DETAIL_FAILED"); setDetailState("error"); } }
    finally { if (detailController.current === controller) detailController.current = undefined; }
  };
  return <div className="page-stack"><header className="page-header"><div><p className="eyebrow">CLOSURE</p><h1>闭环验证</h1><p>Task Contract、Gate 证据、定向修正与人工确认的服务端事实。</p></div><StatusBadge status={view.capabilityStatus} /></header>
    {view.capabilityStatus !== "READY" ? <section className="state-panel state-disabled"><div><h2>闭环能力不可用</h2><p>{view.capabilityReasonCode}</p></div></section> : undefined}
    <section className="panel"><h2>Closure runs</h2>{view.items.length === 0 ? <EmptyState title="没有闭环运行" detail="未接通能力时请以原因码为准，不把空列表解释为 PASS。" /> : <div className="table-scroll"><table><thead><tr><th>Run</th><th>Session / Turn</th><th>Decision</th><th>Continuation</th><th>时间</th></tr></thead><tbody>{view.items.map((item) => <tr key={item.closureRunId}><td><button type="button" className="link-button" onClick={() => void select(item)}>{item.closureRunId}</button></td><td>{item.sessionId} / {item.turnId}</td><td><StatusBadge status={item.decision} /></td><td>{item.continuationCount}/{item.continuationLimit}{item.recursiveStopRejected ? " · RECURSIVE_REJECTED" : ""}</td><td>{new Date(item.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}{view.truncated ? <p className="muted">列表已截断。</p> : undefined}</section>
    {detailState === "loading" ? <div className="panel"><LoadingState label="正在读取闭环详情" /><button type="button" className="secondary-button" onClick={() => { detailController.current?.abort(); setDetailState("idle"); }}>取消详情加载</button></div> : undefined}
    {detailState === "error" ? <div className="inline-alert error" role="alert">{detailError}</div> : undefined}
    {selected === undefined ? undefined : <ClosureDetail value={selected} />}
  </div>;
}

export function ClosureDetail({ value }: { readonly value: ClosureRunView }): React.JSX.Element {
  return <section className="panel" aria-labelledby="closure-detail-heading"><div className="section-heading"><div><h2 id="closure-detail-heading">{value.closureRunId}</h2><span>{value.sessionId} / {value.turnId}</span></div><StatusBadge status={value.decision} /></div>
    <section><h3>Task Contract</h3><p><strong>目标：</strong>{value.taskContract.objective}</p><dl className="detail-grid"><div><dt>边界</dt><dd>{value.taskContract.boundaries.join("；") || "无"}</dd></div><div><dt>完成门禁</dt><dd>{value.taskContract.completionGates.join("；") || "无"}</dd></div></dl></section>
    <section><h3>Gate evidence</h3><div className="table-scroll"><table><thead><tr><th>Gate</th><th>状态</th><th>证据</th><th>原因</th></tr></thead><tbody>{value.gates.map((gate) => <tr key={gate.gateId}><td>{gate.label}</td><td><StatusBadge status={gate.status} /></td><td>{gate.evidenceRefs.join(", ") || "无"}</td><td>{gate.reasonCode}</td></tr>)}</tbody></table></div></section>
    <dl className="detail-grid"><div><dt>Correction delta</dt><dd>{value.correctionDelta ?? "无"}</dd></div><div><dt>Continuation</dt><dd>{value.continuationCount}/{value.continuationLimit}</dd></div><div><dt>递归 Stop</dt><dd>{value.recursiveStopRejected ? "已拦截" : "未发生"}</dd></div><div><dt>Decision</dt><dd>{value.decision}</dd></div></dl>
    {value.interaction === undefined ? <p className="muted">没有人工交互记录。</p> : <div className="inline-alert"><strong>交互 / 确认：{value.interaction.confirmationStatus}</strong><p>{value.interaction.question ?? "无需提问"}</p><p>回答：{value.interaction.answer ?? `安全默认：${value.interaction.safeDefault ?? "无"}`}</p></div>}
  </section>;
}
