import { useCallback } from "react";

import type { ConsoleApi } from "../../api/client.js";
import { useAsync } from "../../app/useAsync.js";
import { useInvalidationFeed } from "../p1/live/useInvalidationFeed.js";
import { ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { p2EnumLabel } from "../p2/labels.js";

export function SessionEvolutionTimeline({ api, sessionId, captureStatus, capturedAt }: {
  readonly api: ConsoleApi; readonly sessionId: string; readonly captureStatus: string; readonly capturedAt: string;
}): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => {
    const extraction = await api.sessionExtraction?.(sessionId, signal);
    const knowledgeIds = [...new Set((extraction?.candidates ?? []).flatMap((candidate) => [
      ...candidate.provenance.knowledgeVersions.map((item) => item.knowledgeId),
      ...(candidate.evolution?.targetKnowledgeVersions.map((item) => item.knowledgeId) ?? []),
    ]))].slice(0, 20);
    const [injections, knowledgeEvolution] = await Promise.all([
      api.sessionInjections?.(sessionId, signal),
      api.knowledgeEvolution === undefined ? Promise.resolve([]) : Promise.all(knowledgeIds.map(async (knowledgeId) =>
        await api.knowledgeEvolution!(knowledgeId, signal))),
    ]); return { extraction, injections, knowledgeEvolution };
  }, [api, sessionId]);
  const [state, retry] = useAsync(load);
  const invalidate = useCallback((resources: readonly string[]) => { if (resources.includes("SESSIONS")) retry(); }, [retry]);
  useInvalidationFeed(api, invalidate);
  if (state.status === "loading") return <LoadingState label="正在组合会话演进时间线" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const { extraction, injections, knowledgeEvolution } = state.value;
  return <section className="panel" role="tabpanel" aria-labelledby="session-evolution-heading">
    <div className="section-heading"><div><h2 id="session-evolution-heading">会话演进时间线</h2><p className="muted">来自会话、提取和注入的服务端事实；页面不推测未记录的阶段。</p></div></div>
    <ol className="stage-list">
      <li><div><strong>对话采集</strong><small title={captureStatus}>{new Date(capturedAt).toLocaleString()} · {p2EnumLabel(captureStatus)}</small></div><StatusBadge status={captureStatus} /></li>
      {extraction?.snapshot === undefined ? null : <li><div><strong>不可变提取快照</strong>
        <small>{extraction.snapshot.snapshotId} · sequence {extraction.snapshot.sourceSequenceFrom}–{extraction.snapshot.sourceSequenceThrough}</small></div>
        <StatusBadge status={extraction.snapshot.completeness} /></li>}
      {(extraction?.stages ?? []).map((stage, index) => <li key={`${stage.stage}:${index}`}><div><strong>{p2EnumLabel(stage.stage)}</strong>
        <small title={stage.reasonCode}>{p2EnumLabel(stage.reasonCode)}{stage.jobId === undefined ? "" : ` · ${stage.jobId}`}</small></div><StatusBadge status={stage.status} /></li>)}
      {(extraction?.candidates ?? []).map((candidate) => <li key={candidate.candidateId}><div><strong>知识候选：{candidate.title}</strong>
        <small title={candidate.evolution?.action}>{candidate.evolution?.action === undefined ? "等待演进决策" : p2EnumLabel(candidate.evolution.action)} · {candidate.candidateId}</small></div><StatusBadge status={candidate.status} /></li>)}
      {(extraction?.candidates ?? []).map((candidate) => <li key={`evidence:${candidate.candidateId}`}><div><strong>候选证据：{candidate.title}</strong>
        <small title={candidate.evidenceVerdict}>{candidate.assertions.length} 条断言 · {candidate.assertions.map((item) => item.assertionId).join("、") || "无结构化断言"}</small></div>
        <StatusBadge status={candidate.evidenceVerdict} /></li>)}
      {(extraction?.candidates ?? []).flatMap((candidate) => candidate.commitments.map((commitment) => <li key={`commitment:${commitment.signalId}`}><div>
        <strong>用户承诺：{p2EnumLabel(commitment.kind)}</strong><small>{commitment.turnId} · {commitment.statement}</small></div>
        <StatusBadge status={commitment.kind} /></li>))}
      {(extraction?.commitmentAmbiguities ?? []).map((ambiguity, index) => <li key={`ambiguity:${ambiguity.turnId}:${index}`}><div>
        <strong>承诺歧义</strong><small title={ambiguity.reasonCode}>{ambiguity.statement} · {ambiguity.candidateIds.join("、")}</small></div>
        <StatusBadge status="UNKNOWN" /></li>)}
      {(extraction?.candidates ?? []).flatMap((candidate) => candidate.provenance.knowledgeVersions.map((knowledge) => <li
        key={`knowledge:${candidate.candidateId}:${knowledge.knowledgeId}:${knowledge.version}`}><div><strong>已发布知识引用</strong>
        <small>{candidate.candidateId} → <a href={`#/knowledge/${encodeURIComponent(knowledge.knowledgeId)}`}>{knowledge.knowledgeId}@{knowledge.version}</a></small></div><StatusBadge status="COMPLETED" /></li>))}
      {knowledgeEvolution.flatMap((knowledge) => knowledge.repairDrafts.map((draft) => <li key={`repair:${draft.draftId}`}><div>
        <strong>知识修复草稿</strong><small><a href={`#/knowledge/${encodeURIComponent(knowledge.knowledgeId)}`}>{knowledge.knowledgeId}@{knowledge.knowledgeVersion}</a> · {draft.draftId} · {draft.conflictRunId}</small></div>
        <StatusBadge status={draft.status} /></li>))}
      {(injections?.attempts ?? []).map((attempt) => <li key={attempt.attemptId}><div><strong>上下文注入：{attempt.turnId}</strong>
        <small title={attempt.reasonCode}>{new Date(attempt.createdAt).toLocaleString()} · {p2EnumLabel(attempt.reasonCode)}</small></div><StatusBadge status={attempt.status} /></li>)}
    </ol>
    {extraction === undefined ? <p className="muted">SESSION_EXTRACTION_API_NOT_EXPOSED</p> : null}
    {injections === undefined ? <p className="muted">SESSION_INJECTION_API_NOT_EXPOSED</p> : null}
  </section>;
}
