import { useCallback, useState } from "react";

import type { ConsoleApi } from "../../api/client.js";
import { useAsync } from "../../app/useAsync.js";
import { useInvalidationFeed } from "../p1/live/useInvalidationFeed.js";
import { ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { p2EnumLabel } from "../p2/labels.js";

function key(prefix: string): string {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

export function KnowledgeEvolutionPanel({ api, knowledgeId, title, summary, body }: {
  readonly api: ConsoleApi; readonly knowledgeId: string; readonly title: string; readonly summary: string; readonly body: string;
}): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => {
    if (api.knowledgeEvolution === undefined) return undefined;
    return await api.knowledgeEvolution(knowledgeId, signal);
  }, [api, knowledgeId]);
  const [state, refresh] = useAsync(load); const [pending, setPending] = useState<string>(); const [message, setMessage] = useState<string>();
  const invalidate = useCallback((resources: readonly string[]) => { if (resources.includes("KNOWLEDGE")) refresh(); }, [refresh]);
  useInvalidationFeed(api, invalidate);
  const run = async (name: string, operation: () => Promise<unknown>): Promise<void> => {
    if (pending !== undefined) return; setPending(name); setMessage(undefined);
    try { await operation(); setMessage("命令已受理，页面已刷新服务端状态。"); refresh(); }
    catch (error) { setMessage(error instanceof Error ? `操作失败：${error.message}` : "操作失败"); }
    finally { setPending(undefined); }
  };
  if (state.status === "loading") return <LoadingState label="正在读取知识演进证据" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={refresh} />;
  const value = state.value;
  if (value === undefined) return <section className="panel"><h2>知识演进</h2><p className="muted">KNOWLEDGE_EVOLUTION_API_NOT_EXPOSED</p></section>;
  const revalidate = (): void => {
    if (!value.revalidationAction.enabled || api.revalidateKnowledge === undefined) return;
    void run("revalidate", async () => await api.revalidateKnowledge!({ knowledgeId,
      expectedKnowledgeVersion: value.revalidationAction.expectedKnowledgeVersion,
      expectedFreshnessRevision: value.revalidationAction.expectedFreshnessRevision,
      idempotencyKey: key(`revalidate:${knowledgeId}:${value.revalidationAction.expectedFreshnessRevision}`) }));
  };
  return <section className="panel" aria-labelledby="knowledge-evolution-heading">
    <div className="section-heading"><div><h2 id="knowledge-evolution-heading">知识演进与修复</h2><span>revision {value.revision} · 可追溯验证与修复草稿</span></div>
      <button type="button" className="secondary-button" disabled={!value.revalidationAction.enabled || api.revalidateKnowledge === undefined || pending !== undefined}
        title={value.revalidationAction.reasonCode} onClick={revalidate}>{pending === "revalidate" ? "复验中…" : "手动复验当前知识"}</button></div>
    <dl className="detail-grid"><div><dt>验证 Recipe</dt><dd>{value.recipe === undefined ? "未建立" : `${value.recipe.recipeVersion} · ${value.recipe.assertionCount} 条断言`}</dd></div>
      <div><dt>保鲜 revision</dt><dd>{value.freshnessRevision}</dd></div><div><dt>项目</dt><dd>{value.projectId ?? "非项目维度"}</dd></div>
      <div><dt>复验门禁</dt><dd title={value.revalidationAction.reasonCode}>{value.revalidationAction.enabled ? "可执行" : p2EnumLabel(value.revalidationAction.reasonCode)}</dd></div></dl>
    <div className="p2-grid"><div><h3>验证运行（{value.verificationRuns.length}）</h3>{value.verificationRuns.length === 0 ? <p className="muted">尚无当前版本的验证记录。</p>
      : value.verificationRuns.map((runValue) => <article className="fact-row" key={runValue.runId}><div><strong>{p2EnumLabel(runValue.purpose)}</strong><StatusBadge status={runValue.qualifyingProof ? "SUPPORTED" : "INCONCLUSIVE"} /></div>
        <p>{runValue.results.map((result) => `${result.assertionId}：${p2EnumLabel(result.status)}`).join("；")}</p><small>{runValue.runId} · code {runValue.codeRevision} · {new Date(runValue.completedAt).toLocaleString()}</small></article>)}</div>
      <div><h3>关联后台任务（{value.jobs.length}）</h3>{value.jobs.length === 0 ? <p className="muted">暂无复验或修复任务。</p>
        : value.jobs.map((job) => <article className="fact-row" key={job.jobId}><div><strong>{p2EnumLabel(job.jobType)}</strong><StatusBadge status={job.status} /></div><small>{job.jobId} · {job.reasonCode}</small></article>)}</div></div>
    <div><h3>修复草稿（{value.repairDrafts.length}）</h3>{value.repairDrafts.length === 0 ? <p className="muted">只有复验确认冲突后才会生成修复草稿。</p>
      : value.repairDrafts.map((draft) => <article className="fact-row" key={draft.draftId}><div><strong>{draft.draftId}</strong><StatusBadge status={draft.status} /></div>
        <p>{draft.changedAssertions.map((item) => `${item.assertionId}：${item.reasonCodes.map(p2EnumLabel).join("、")}`).join("；")}</p>
        {draft.status !== "PENDING" || api.submitRepairCandidate === undefined ? null : <button type="button" className="primary-button" disabled={pending !== undefined}
          onClick={() => void run(`repair:${draft.draftId}`, async () => await api.submitRepairCandidate!({ draftId: draft.draftId,
            expectedRevision: draft.revision, idempotencyKey: key(`repair:${draft.draftId}:${draft.revision}`), title, summary, body }))}>
          {pending === `repair:${draft.draftId}` ? "提交中…" : "以当前知识内容生成修复候选"}</button>}
        {draft.proposedCandidate === undefined ? null : <details><summary>查看修复候选</summary><strong>{draft.proposedCandidate.title}</strong><p>{draft.proposedCandidate.summary}</p><pre>{draft.proposedCandidate.body}</pre></details>}
        <small>{draft.conflictRunId} · r{draft.revision} · {new Date(draft.updatedAt).toLocaleString()}</small></article>)}</div>
    {message === undefined ? null : <p className="inline-alert" role="status" aria-live="polite">{message}</p>}
  </section>;
}
