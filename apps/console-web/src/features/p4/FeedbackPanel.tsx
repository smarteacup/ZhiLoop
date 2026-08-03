import { useCallback, useState } from "react";

import type { FeedbackKind, FeedbackTargetView, P4ActionGate, P4ConsoleApi } from "../../api/p4.js";
import { useAsync } from "../../app/useAsync.js";
import { ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";

const LABELS: Readonly<Record<FeedbackKind, string>> = {
  RELEVANT: "相关", IRRELEVANT: "不相关", PIN: "固定", SUPPRESS: "停止召回", MCP_USED: "标记 MCP 已使用",
};

export function FeedbackPanel({ api, sessionId }: { readonly api: Pick<P4ConsoleApi, "feedbackTargets" | "recordFeedback">; readonly sessionId: string }): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => await api.feedbackTargets(sessionId, signal), [api, sessionId]);
  const [state, retry] = useAsync(load);
  const [pending, setPending] = useState<string>();
  const [message, setMessage] = useState<string>();
  if (state.status === "loading") return <LoadingState label="正在读取反馈目标与门禁" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const submit = async (target: FeedbackTargetView, kind: FeedbackKind): Promise<void> => {
    const gate = target.actions[kind];
    if (!feedbackEnabled(target, kind, gate) || gate.expectedRevision === undefined || gate.idempotencyKey === undefined) return;
    const key = `${target.knowledgeId}:${kind}`; setPending(key); setMessage(undefined);
    try {
      const receipt = await api.recordFeedback({
        knowledgeId: target.knowledgeId, version: target.version, kind,
        expectedRevision: gate.expectedRevision, idempotencyKey: gate.idempotencyKey,
        scopeKey: target.scopeKey, traceId: target.traceId,
        ...(target.expansionId === undefined ? {} : { expansionId: target.expansionId }),
      });
      setMessage(`${kind}：${receipt.result} · revision ${receipt.revision} · ${receipt.reasonCode} · 写入后资格 ${String(receipt.eligibleAfterWrite)}`);
    } catch (error) { setMessage(error instanceof Error ? `反馈失败：${error.message}` : "反馈失败"); }
    finally { setPending(undefined); }
  };
  return <section className="panel" aria-labelledby="feedback-heading"><div className="section-heading"><div><h2 id="feedback-heading">反馈与实际使用</h2><span>反馈不能绕过 current-version、Scope、Evidence 或 suppress 资格策略</span></div></div>
    {state.value.length === 0 ? <p className="muted">没有可反馈的知识版本。</p> : state.value.map((target) => <article className="fact-row" key={`${target.knowledgeId}:${target.version}`}><div className="section-heading"><div><strong>{target.title}</strong><small>{target.knowledgeId}@{target.version}</small></div><div><StatusBadge status={target.eligible ? "ELIGIBLE" : "INELIGIBLE"} /><StatusBadge status={target.mcpUsed ? "MCP_USED" : "MCP_NOT_USED"} /></div></div>{!target.eligible ? <p className="muted">{target.eligibilityReasonCodes.join(", ") || "服务端未提供可用资格原因"}</p> : undefined}<div className="button-row">{(Object.keys(LABELS) as FeedbackKind[]).map((kind) => { const gate = target.actions[kind]; const enabled = feedbackEnabled(target, kind, gate) && pending === undefined; return <button type="button" key={kind} className={kind === "SUPPRESS" ? "danger-button" : "secondary-button"} disabled={!enabled} title={gate.reasonCode} onClick={() => void submit(target, kind)}>{pending === `${target.knowledgeId}:${kind}` ? "提交中…" : LABELS[kind]}</button>; })}</div></article>)}
    {message === undefined ? undefined : <p className="inline-alert" role="status" aria-live="polite">{message}</p>}
  </section>;
}

export function feedbackEnabled(target: FeedbackTargetView, kind: FeedbackKind, gate: P4ActionGate): boolean {
  if (!gate.enabled || gate.capabilityStatus !== "READY" || gate.expectedRevision !== target.version || gate.idempotencyKey === undefined) return false;
  if (target.scopeKey.length === 0 || target.traceId.length === 0 || (kind === "MCP_USED" && target.expansionId === undefined)) return false;
  if ((kind === "RELEVANT" || kind === "PIN" || kind === "MCP_USED") && !target.eligible) return false;
  return true;
}
