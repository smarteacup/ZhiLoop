import { useCallback, useState } from "react";

import type { InjectionAttemptView, P4ConsoleApi } from "../../api/p4.js";
import { useAsync } from "../../app/useAsync.js";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";

export function InjectionPanel({ api, sessionId }: { readonly api: Pick<P4ConsoleApi, "sessionInjections"> & Partial<Pick<P4ConsoleApi, "refreshSessionContext">>; readonly sessionId: string }): React.JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string>();
  const load = useCallback(async (signal: AbortSignal) => await api.sessionInjections(sessionId, signal), [api, sessionId]);
  const [state, retry] = useAsync(load);
  if (state.status === "loading") return <LoadingState label="正在读取实际与影子注入记录" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const view = state.value;
  return <section className="panel" aria-labelledby="p4-injection-heading">
    <div className="section-heading"><div><h2 id="p4-injection-heading">Context Envelope 与 MCP 展开</h2><span>{new Date(view.observedAt).toLocaleString()} · 最多展示 {view.attempts.length} 条</span></div><div className="capture-actions"><StatusBadge status={view.capabilityStatus} /><button type="button" className="secondary-button" disabled={refreshing || api.refreshSessionContext === undefined} onClick={() => {
      if (api.refreshSessionContext === undefined) return;
      setRefreshing(true); setRefreshMessage(undefined);
      void api.refreshSessionContext(sessionId).then((receipt) => {
        setRefreshMessage(`本会话稳定知识目录已刷新，清除 ${receipt.removedEntries} 条缓存；下一轮将重新预热。`);
        retry();
      }).catch((error: unknown) => setRefreshMessage(error instanceof Error ? `刷新失败：${error.message}` : "刷新失败"))
        .finally(() => setRefreshing(false));
    }}>{refreshing ? "刷新中…" : "刷新本会话知识"}</button></div></div>
    {refreshMessage === undefined ? undefined : <p className="inline-alert" role="status" aria-live="polite">{refreshMessage}</p>}
    {view.capabilityStatus !== "READY" ? <div className="inline-alert warning"><strong>{view.capabilityReasonCode}</strong><p>注入能力未就绪；下方仅展示已持久化事实，不推测投递结果。</p></div> : undefined}
    {view.attempts.length === 0 ? <EmptyState title="没有注入尝试" detail="空列表不代表已注入；请结合能力原因码判断链路状态。" /> : <div className="p4-attempt-list">{view.attempts.map((attempt) => <InjectionAttempt key={attempt.attemptId} value={attempt} />)}</div>}
    {view.truncated ? <p className="muted">结果已由服务端截断，请缩小会话范围后查看。</p> : undefined}
  </section>;
}

function InjectionAttempt({ value }: { readonly value: InjectionAttemptView }): React.JSX.Element {
  const actual = value.status === "INJECTED" && value.envelope.mode === "ACTUAL" && value.deliveryEvidenceRef !== undefined;
  const deliveryLabel = actual ? "实际进入模型上下文" : value.status === "SHADOWED" ? "计划注入（未进入模型上下文）" : "未确认进入模型上下文";
  return <article className="fact-row" aria-label={`Turn ${value.turnId} 注入 ${value.status}`}>
    <div className="section-heading"><div><strong>{value.turnId}</strong><small>{value.attemptId} · rollout r{value.rolloutRevision}</small></div><StatusBadge status={value.status} /></div>
    <p><strong>{deliveryLabel}</strong> · {value.reasonCode}</p>
    <dl className="detail-grid"><div><dt>Envelope</dt><dd>{value.envelope.mode} / {value.envelope.detailLevel}</dd></div><div><dt>Token</dt><dd>{value.envelope.estimatedTokens}/{value.envelope.maxTokens}</dd></div><div><dt>Run / Trace</dt><dd>{value.runId} / {value.retrievalTraceId}</dd></div><div><dt>投递证据</dt><dd>{actual ? value.deliveryEvidenceRef : "无"}</dd></div></dl>
    <details><summary>知识指针与裁剪原因</summary><ul>{value.envelope.items.map((item) => <li key={`${item.knowledgeId}:${item.version}`}>{item.knowledgeId}@{item.version} · {item.detailLevel} · {item.estimatedTokens ?? "?"} tokens</li>)}</ul>{value.envelope.omitted.length === 0 ? <p className="muted">没有服务端报告的 omitted 项（服务端计数 {value.envelope.omittedCount ?? 0}）。</p> : <ul>{value.envelope.omitted.map((item) => <li key={`${item.knowledgeId}:${item.version}`}>{item.knowledgeId}@{item.version} · {item.reasonCode}</li>)}</ul>}</details>
    <details><summary>MCP 展开（{value.mcpExpansions.length}）</summary>{value.mcpExpansions.length === 0 ? <p className="muted">没有按需展开记录。</p> : <div className="table-scroll"><table><thead><tr><th>工具</th><th>知识版本</th><th>层级</th><th>耗时</th><th>实际使用</th></tr></thead><tbody>{value.mcpExpansions.map((item) => <tr key={item.expansionId}><td>{item.tool}</td><td>{item.knowledgeId}@{item.knowledgeVersion}</td><td>{item.fromDetailLevel} → {item.toDetailLevel}</td><td>{item.latencyMs}ms</td><td>{item.used ? "是" : "否"}</td></tr>)}</tbody></table></div>}</details>
  </article>;
}
