import { useCallback, useEffect, useState } from "react";

import type { ConsoleApi } from "../../../api/client.js";
import type { SessionExtractionView } from "../../../api/p2.js";
import { useAsync } from "../../../app/useAsync.js";
import { ErrorState, LoadingState } from "../../../components/AsyncState.js";
import { StatusBadge } from "../../../components/StatusBadge.js";
import { capabilityDecision } from "../capability.js";

export function SessionExtractionPanel({ api, sessionId }: { readonly api: ConsoleApi; readonly sessionId: string }): React.JSX.Element {
  const [result, setResult] = useState<SessionExtractionView>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const load = useCallback(async (signal: AbortSignal) => {
    const capabilities = await api.capabilities(signal);
    const capability = capabilityDecision(capabilities.items, ["knowledge.compiler", "session.extraction", "knowledge.worker"]);
    if (!capability.ready || api.sessionExtraction === undefined) return { capability, extraction: undefined };
    return { capability, extraction: await api.sessionExtraction(sessionId, signal) };
  }, [api, sessionId]);
  const [state, retry] = useAsync(load);
  useEffect(() => setResult(undefined), [sessionId]);
  if (state.status === "loading") return <LoadingState label="正在读取提取快照" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const { capability, extraction } = state.value;
  const view = result ?? extraction;
  if (!capability.ready || api.sessionExtraction === undefined) {
    return <section className="panel" role="tabpanel" aria-labelledby="extraction-heading"><div className="section-heading"><h2 id="extraction-heading">会话知识提取</h2><StatusBadge status={capability.status} /></div><div className="inline-alert warning"><strong>{capability.reasonCode}</strong><p>{capability.capabilityId} 未就绪；页面不推测后台已执行，也不会构造候选知识。</p></div></section>;
  }
  if (view === undefined) return <section className="panel"><p className="muted">服务端未返回提取视图。</p></section>;
  const gate = view.extractAction;
  const canExtract = gate.enabled && api.startSessionExtraction !== undefined && !pending;
  const canCommit = view.commitAction.enabled && view.previewId !== undefined && api.commitSessionExtraction !== undefined && !pending;
  const start = async (): Promise<void> => {
    if (!canExtract || api.startSessionExtraction === undefined) return;
    setPending(true);
    setMessage(undefined);
    try {
      const updated = await api.startSessionExtraction({ sessionId, expectedRevision: gate.expectedRevision, idempotencyKey: gate.idempotencyKey });
      setResult(updated);
      setMessage("提取请求已确认；下方状态来自服务端最新 revision。");
    } catch (error) {
      setMessage(error instanceof Error ? `提取失败：${error.message}。请刷新 revision 后重试。` : "提取失败，请刷新 revision 后重试。");
    } finally {
      setPending(false);
    }
  };
  const commit = async (): Promise<void> => {
    if (!canCommit || view.previewId === undefined || api.commitSessionExtraction === undefined) return;
    setPending(true); setMessage(undefined);
    try {
      const updated = await api.commitSessionExtraction({ sessionId, previewId: view.previewId, expectedPreviewRevision: view.commitAction.expectedRevision, idempotencyKey: view.commitAction.idempotencyKey });
      setResult(updated); setMessage("策略提交已受理；发布与索引状态仍以服务端阶段为准。");
    } catch (error) { setMessage(error instanceof Error ? `提交失败：${error.message}` : "提交失败"); }
    finally { setPending(false); }
  };
  return <section className="panel extraction-panel" role="tabpanel" aria-labelledby="extraction-heading">
    <div className="section-heading"><div><h2 id="extraction-heading">会话知识提取</h2><span>revision {view.revision} · 快照重试使用服务端幂等键</span></div><div className="capture-actions"><button type="button" className="primary-button" disabled={!canExtract} title={gate.reasonCode} onClick={() => void start()}>{pending ? "正在提取…" : "提取当前会话快照"}</button><button type="button" className="secondary-button" disabled={!canCommit} title={view.commitAction.reasonCode} onClick={() => void commit()}>明确提交策略并发布</button></div></div>
    {!gate.enabled ? <div className="inline-alert warning"><strong>{gate.reasonCode}</strong><p>当前 revision 不允许创建新快照。</p></div> : undefined}
    {gate.enabled && api.startSessionExtraction === undefined ? <div className="inline-alert warning"><strong>EXTRACTION_COMMAND_API_NOT_EXPOSED</strong><p>提取视图可读，但当前 Console API 没有暴露写命令。</p></div> : undefined}
    {message === undefined ? undefined : <p role="status" aria-live="polite" className="inline-alert">{message}</p>}
    {view.snapshot === undefined ? <p className="muted">尚无不可变提取快照。</p> : <article className="snapshot-card"><div className="section-heading"><h3>Snapshot {view.snapshot.snapshotId}</h3><StatusBadge status={view.snapshot.completeness} /></div><dl className="detail-grid"><div><dt>来源序列</dt><dd>{view.snapshot.sourceSequenceFrom}–{view.snapshot.sourceSequenceThrough}</dd></div><div><dt>编译器</dt><dd>{view.snapshot.compilerVersion}</dd></div><div><dt>策略哈希</dt><dd>{view.snapshot.policyHash}</dd></div><div><dt>创建时间</dt><dd>{new Date(view.snapshot.createdAt).toLocaleString()}</dd></div></dl>{view.snapshot.completeness === "PARTIAL_SNAPSHOT" ? <div className="inline-alert warning"><strong>PARTIAL_SNAPSHOT</strong><p>活跃会话只覆盖到固定序列；不支持事件类型：{view.snapshot.unsupportedEventTypes.join(", ") || "无"}</p></div> : undefined}</article>}
    <div className="p2-grid"><section aria-labelledby="extraction-progress"><h3 id="extraction-progress">提取进度</h3><ol className="stage-list">{view.stages.map((stage) => <li key={stage.stage}><div><strong>{stage.stage}</strong><small>{stage.reasonCode}{stage.totalUnits === undefined ? "" : ` · ${stage.completedUnits ?? 0}/${stage.totalUnits}`}{stage.retryable ? " · RETRYABLE" : ""}</small></div><StatusBadge status={stage.status} /></li>)}</ol></section><section aria-labelledby="candidate-preview"><h3 id="candidate-preview">候选预览与策略</h3>{view.candidates.length === 0 ? <p className="muted">当前快照没有候选知识。</p> : <div className="candidate-list">{view.candidates.map((candidate) => <article key={candidate.candidateId}><div><strong>{candidate.title}</strong><StatusBadge status={candidate.status} /></div><p>{candidate.summary}</p><small>{candidate.kind} · {candidate.scope} · confidence {candidate.confidence.toFixed(2)}</small><div className="policy-result"><strong>{candidate.policy.action} → {candidate.policy.targetStatus}</strong><span>{candidate.policy.shouldPublish ? "允许发布" : "不进入召回"}</span><small>{candidate.policy.reasonCodes.join(", ")}</small></div><details><summary>双向追溯</summary><Provenance value={candidate.provenance} /></details></article>)}</div>}</section></div>
    {view.reverseProvenance.length === 0 ? undefined : <section aria-labelledby="reverse-provenance"><h3 id="reverse-provenance">知识版本反向追溯</h3>{view.reverseProvenance.map((item, index) => <Provenance key={index} value={item} />)}</section>}
  </section>;
}

function Provenance({ value }: { readonly value: SessionExtractionView["reverseProvenance"][number] }): React.JSX.Element {
  return <dl className="provenance-grid"><div><dt>Session / Turn</dt><dd>{value.sessionIds.join(", ")} / {value.turnIds.join(", ")}</dd></div><div><dt>Event / Snapshot</dt><dd>{value.eventIds.join(", ")} / {value.snapshotIds.join(", ")}</dd></div><div><dt>Episode</dt><dd>{value.episodeIds.join(", ")}</dd></div><div><dt>Knowledge version</dt><dd>{value.knowledgeVersions.map((item) => <a key={`${item.knowledgeId}:${item.version}`} href={`#/knowledge/${encodeURIComponent(item.knowledgeId)}`}>{item.knowledgeId}@{item.version}</a>)}</dd></div></dl>;
}
