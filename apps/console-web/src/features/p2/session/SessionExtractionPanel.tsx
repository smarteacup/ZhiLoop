import { useCallback, useEffect, useState } from "react";

import { ConsoleApiError, type ConsoleApi } from "../../../api/client.js";
import type { ExtractionCandidateView, SessionExtractionView } from "../../../api/p2.js";
import { useAsync } from "../../../app/useAsync.js";
import { ErrorState, LoadingState } from "../../../components/AsyncState.js";
import { StatusBadge } from "../../../components/StatusBadge.js";
import { capabilityDecision } from "../capability.js";
import { p2EnumLabel, p2ReasonDetail } from "../labels.js";

const LIVE_STAGE_STATUSES = new Set(["QUEUED", "RUNNING", "RETRY_WAIT", "CANCEL_REQUESTED"]);

export function SessionExtractionPanel({ api, sessionId, captureCurrent }: { readonly api: ConsoleApi; readonly sessionId: string; readonly captureCurrent: boolean }): React.JSX.Element {
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
  const loadedExtraction = state.status === "success" ? state.value.extraction : undefined;
  const liveView = result ?? loadedExtraction;
  const shouldPoll = liveView?.stages.some(({ status }) => LIVE_STAGE_STATUSES.has(status)) ?? false;
  useEffect(() => {
    if (!shouldPoll || api.sessionExtraction === undefined) return;
    const controller = new AbortController();
    let inFlight = false;
    const refresh = (): void => {
      if (inFlight) return;
      inFlight = true;
      void api.sessionExtraction!(sessionId, controller.signal)
        .then((updated) => setResult(updated))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setMessage(error instanceof Error ? `进度刷新失败：${error.message}` : "进度刷新失败");
        })
        .finally(() => { inFlight = false; });
    };
    const timer = window.setInterval(refresh, 1_000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [api, sessionId, shouldPoll]);
  if (state.status === "loading") return <LoadingState label="正在读取提取快照" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const { capability, extraction } = state.value;
  const view = result ?? extraction;
  if (!capability.ready || api.sessionExtraction === undefined) {
    return <section className="panel" role="tabpanel" aria-labelledby="extraction-heading"><div className="section-heading"><h2 id="extraction-heading">会话知识提取</h2><StatusBadge status={capability.status} /></div><div className="inline-alert warning"><strong title={capability.reasonCode}>{p2EnumLabel(capability.reasonCode)}</strong><p>{capability.capabilityId} 未就绪；页面不推测后台已执行，也不会构造候选知识。</p></div></section>;
  }
  if (view === undefined) return <section className="panel"><p className="muted">服务端未返回提取视图。</p></section>;
  const gate = view.extractAction;
  const queryExtraction = api.sessionExtraction;
  const startExtraction = api.startSessionExtraction;
  const canExtract = captureCurrent && gate.enabled && startExtraction !== undefined && !pending;
  const canCommit = view.commitAction.enabled && view.previewId !== undefined && api.commitSessionExtraction !== undefined && !pending;
  const stageFailures = view.stages.filter(({ failure, status }) => status === "FAILED" || status === "RETRY_WAIT" || status === "CANCELLED" || (failure !== undefined && status !== "SUCCEEDED"));
  const start = async (): Promise<void> => {
    if (!canExtract || startExtraction === undefined) return;
    setPending(true);
    setMessage(undefined);
    try {
      const updated = await startExtraction({ sessionId, expectedRevision: gate.expectedRevision, idempotencyKey: gate.idempotencyKey });
      setResult(updated);
      setMessage("提取请求已确认；下方状态来自服务端最新 revision。");
    } catch (error) {
      let failure = error;
      if (error instanceof ConsoleApiError && error.code === "STALE_REVISION" && queryExtraction !== undefined) {
        try {
          const refreshed = await queryExtraction(sessionId);
          setResult(refreshed);
          if (!refreshed.extractAction.enabled) throw error;
          const updated = await startExtraction({
            sessionId,
            expectedRevision: refreshed.extractAction.expectedRevision,
            idempotencyKey: refreshed.extractAction.idempotencyKey,
          });
          setResult(updated);
          setMessage("检测到 revision 变化，已自动刷新并使用当前会话最新状态完成提取。");
          return;
        } catch (retryError) {
          failure = retryError;
        }
      }
      if (failure instanceof ConsoleApiError && failure.code === "CONFLICT") {
        setMessage("提取失败：当前会话尚未采集到最新状态。请先在“主动采集”中确认写入 Ledger，再重新提取。");
      } else if (failure instanceof ConsoleApiError && failure.code === "STALE_REVISION") {
        setMessage("提取失败：会话 revision 持续变化，自动刷新后仍发生冲突，请稍后重试。");
      } else {
        setMessage(failure instanceof Error ? `提取失败：${failure.message}` : "提取失败");
      }
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
    <div className="section-heading"><div><h2 id="extraction-heading">会话知识提取</h2><span>revision {view.revision} · 快照重试使用服务端幂等键</span></div><div className="capture-actions"><button type="button" className="primary-button" disabled={!canExtract} title={captureCurrent ? gate.reasonCode : "CAPTURE_NOT_CURRENT"} onClick={() => void start()}>{pending ? "正在提取…" : "提取当前会话快照"}</button><button type="button" className="secondary-button" disabled={!canCommit} title={view.commitAction.reasonCode} onClick={() => void commit()}>明确提交策略并发布</button></div></div>
    {!captureCurrent ? <div className="inline-alert warning"><strong>会话尚未采集至最新</strong><p>请先在上方“主动采集”中生成预览并确认写入 Ledger，然后再提取知识。</p></div> : undefined}
    {!gate.enabled ? <div className="inline-alert warning"><strong title={gate.reasonCode}>{p2EnumLabel(gate.reasonCode)}</strong><p>当前 revision 不允许创建新快照。</p></div> : undefined}
    {gate.enabled && api.startSessionExtraction === undefined ? <div className="inline-alert warning"><strong title="EXTRACTION_COMMAND_API_NOT_EXPOSED">提取命令接口未开放</strong><p>提取视图可读，但当前 Console API 没有暴露写命令。</p></div> : undefined}
    {message === undefined ? undefined : <p role="status" aria-live="polite" className="inline-alert">{message}</p>}
    {view.snapshot === undefined ? <p className="muted">尚无不可变提取快照。</p> : <article className="snapshot-card"><div className="section-heading"><h3>快照 {view.snapshot.snapshotId}</h3><StatusBadge status={view.snapshot.completeness} /></div><dl className="detail-grid"><div><dt>来源序列</dt><dd>{view.snapshot.sourceSequenceFrom}–{view.snapshot.sourceSequenceThrough}</dd></div><div><dt>编译器</dt><dd>{view.snapshot.compilerVersion}</dd></div><div><dt>策略哈希</dt><dd>{view.snapshot.policyHash}</dd></div><div><dt>创建时间</dt><dd>{new Date(view.snapshot.createdAt).toLocaleString()}</dd></div></dl>{view.snapshot.completeness === "PARTIAL_SNAPSHOT" ? <div className="inline-alert warning"><strong title="PARTIAL_SNAPSHOT">部分快照</strong><p>活跃会话只覆盖到固定序列；不支持事件类型：{view.snapshot.unsupportedEventTypes.map(p2EnumLabel).join("、") || "无"}</p></div> : undefined}</article>}
    <div className="p2-grid"><section aria-labelledby="extraction-progress"><h3 id="extraction-progress">提取进度</h3><ol className="stage-list">{view.stages.map((stage) => <li key={stage.stage}><div><strong title={stage.stage}>{p2EnumLabel(stage.stage)}</strong><small title={stage.reasonCode}>{p2EnumLabel(stage.reasonCode)}{stage.totalUnits === undefined ? "" : ` · ${stage.completedUnits ?? 0}/${stage.totalUnits}`}{stage.retryable ? " · 可自动重试" : ""}</small></div><StatusBadge status={stage.status} /></li>)}</ol>{stageFailures.map((stage) => { const code = stage.failure?.code ?? stage.reasonCode; return <div className="inline-alert warning" role="alert" key={`failure:${stage.stage}`}><strong>{p2EnumLabel(stage.stage)}：{p2EnumLabel(code)}</strong><p>{p2ReasonDetail(code) ?? "后台任务返回了失败诊断，请结合诊断码和尝试次数处理。"}</p><small>诊断码 <code>{code}</code>{stage.attempt === undefined ? "" : ` · 已尝试 ${stage.attempt}/${stage.maxAttempts ?? "?"} 次`}{stage.nextAttemptAt === undefined ? "" : ` · 下次重试 ${new Date(stage.nextAttemptAt).toLocaleString()}`}{stage.jobId === undefined ? undefined : <> · <a href="#/jobs">查看后台任务尝试记录</a></>}</small></div>; })}</section><section aria-labelledby="candidate-preview"><h3 id="candidate-preview">候选预览与策略</h3>{view.candidates.length === 0 ? <p className="muted">当前快照没有候选知识。</p> : <div className="candidate-list">{view.candidates.map((candidate) => <article key={candidate.candidateId}><div><strong>{candidate.title}</strong><StatusBadge status={candidate.status} /></div><p>{candidate.summary}</p><small><span title={candidate.kind}>{p2EnumLabel(candidate.kind)}</span> · <span title={candidate.scope}>{p2EnumLabel(candidate.scope)}</span> · 置信度 {candidate.confidence.toFixed(2)}</small><CandidateLocalization candidate={candidate} /><div className="policy-result"><strong><span title={candidate.policy.action}>{p2EnumLabel(candidate.policy.action)}</span> → <span title={candidate.policy.targetStatus}>{p2EnumLabel(candidate.policy.targetStatus)}</span></strong><span>{candidate.policy.shouldPublish ? "允许发布" : "不进入召回"}</span><small>{candidate.policy.reasonCodes.map(p2EnumLabel).join("、")}</small></div><details><summary>候选正文、断言与用户承诺</summary><pre className="markdown-preview">{candidate.body || "后台检查点未保留候选正文"}</pre><h4>可执行断言</h4>{candidate.assertions.length === 0 ? <p className="muted">没有可执行断言。</p> : <ul>{candidate.assertions.map((assertion) => <li key={assertion.assertionId}><strong title={assertion.kind}>{p2EnumLabel(assertion.kind)}</strong> · <code>{assertion.target}</code></li>)}</ul>}<h4>证据门禁结果</h4>{candidate.evidenceChecks.length === 0 ? <p className="muted">没有证据检查结果。</p> : <ul>{candidate.evidenceChecks.map((check) => <li key={check.assertionId}><StatusBadge status={check.status} /> <strong title={check.kind}>{p2EnumLabel(check.kind)}</strong> · {check.reasonCodes.map(p2EnumLabel).join("、")}{check.codeGraphArtifact === undefined ? undefined : <small> · CodeGraph {check.codeGraphArtifact.operation} · {check.codeGraphArtifact.factCount} 条事实 · revision {check.codeGraphArtifact.graphRevision ?? "未提供"}</small>}</li>)}</ul>}<h4>用户承诺</h4>{candidate.commitments.length === 0 ? <p className="muted">没有命中该候选的明确接受、拒绝或纠正。</p> : candidate.commitments.map((commitment) => <blockquote key={commitment.signalId}><strong title={commitment.kind}>{p2EnumLabel(commitment.kind)}</strong>：{commitment.statement}<footer>{commitment.turnId} · {commitment.reasonCodes.map(p2EnumLabel).join("、")}</footer></blockquote>)}</details>{candidate.evolution === undefined ? undefined : <details><summary>演进决策</summary><p><StatusBadge status={candidate.evolution.status} /> {candidate.evolution.action === undefined ? "等待裁决" : p2EnumLabel(candidate.evolution.action)} · 置信度 {candidate.evolution.confidence.toFixed(2)}{candidate.evolution.requiresConfirmation ? " · 需要确认" : ""}</p><p>{candidate.evolution.reasonCodes.map(p2EnumLabel).join("、")}</p><ul>{candidate.evolution.targetKnowledgeVersions.map((target) => <li key={`${target.knowledgeId}:${target.version}`}><a href={`#/knowledge/${encodeURIComponent(target.knowledgeId)}`}>{target.knowledgeId}@{target.version}</a></li>)}</ul></details>}<details><summary>双向追溯</summary><Provenance value={candidate.provenance} /></details></article>)}</div>}</section></div>
    {view.commitmentAmbiguities.length === 0 ? undefined : <section aria-labelledby="commitment-ambiguities"><h3 id="commitment-ambiguities">待处理的用户承诺歧义</h3>{view.commitmentAmbiguities.map((item) => <article className="inline-alert warning" key={`${item.turnId}:${item.statementRef}`}><strong title={item.kind}>{p2EnumLabel(item.kind)} · {p2EnumLabel(item.reasonCode)}</strong><p>{item.statement}</p><small>{item.turnId} · 候选 {item.candidateIds.join("、")}</small></article>)}</section>}
    {view.reverseProvenance.length === 0 ? undefined : <section aria-labelledby="reverse-provenance"><h3 id="reverse-provenance">知识版本反向追溯</h3>{view.reverseProvenance.map((item, index) => <Provenance key={index} value={item} />)}</section>}
  </section>;
}

function CandidateLocalization({ candidate }: { readonly candidate: ExtractionCandidateView }): React.JSX.Element {
  const value = candidate.localization;
  if (value === undefined) return <div className="inline-alert warning"><strong>旧版候选缺少定位</strong><p>该候选不会被当作已定位的当前代码事实。</p></div>;
  return <details><summary>项目、分支与使用场景</summary><dl className="detail-grid"><div><dt>结论语义</dt><dd>{p2EnumLabel(value.claimMode)}</dd></div><div><dt>项目</dt><dd><code>{value.projectId}</code></dd></div><div><dt>观测分支</dt><dd>{value.observedBranch ?? "未解析"}</dd></div><div><dt>观测提交</dt><dd><code>{value.observedCommit ?? "未解析"}</code>{value.dirty ? " · 工作区有改动" : ""}</dd></div><div><dt>分支适用</dt><dd>{p2EnumLabel(value.branchMode)} · <code>{value.branchValue}</code></dd></div><div><dt>场景</dt><dd>{value.scenarioTitle}<br /><code>{value.scenarioKey}</code></dd></div></dl><p>{value.scenarioSummary}</p><p><strong>适用：</strong>{value.applicability.join("；") || "未声明"}</p><p><strong>不适用：</strong>{value.nonApplicability.join("；") || "未声明"}</p><p><strong>任务意图：</strong>{value.taskIntents.join("；") || "未声明"}</p><p><strong>入口：</strong>{value.entryPoints.join("；") || "未声明"}</p></details>;
}

function Provenance({ value }: { readonly value: SessionExtractionView["reverseProvenance"][number] }): React.JSX.Element {
  return <dl className="provenance-grid"><div><dt>会话 / 轮次</dt><dd>{value.sessionIds.join(", ")} / {value.turnIds.join(", ")}</dd></div><div><dt>事件 / 快照</dt><dd>{value.eventIds.join(", ")} / {value.snapshotIds.join(", ")}</dd></div><div><dt>对话片段</dt><dd>{value.episodeIds.join(", ")}</dd></div><div><dt>知识版本</dt><dd>{value.knowledgeVersions.map((item) => <a key={`${item.knowledgeId}:${item.version}`} href={`#/knowledge/${encodeURIComponent(item.knowledgeId)}`}>{item.knowledgeId}@{item.version}</a>)}</dd></div></dl>;
}
