import { useCallback, useEffect, useState } from "react";

import type { ConsoleApi } from "../../../api/client.js";
import type { KnowledgeDetailView, KnowledgeEditDraft, KnowledgeEditImpact, KnowledgeFilter, KnowledgeListView } from "../../../api/p2.js";
import { useAsync } from "../../../app/useAsync.js";
import { EmptyState, ErrorState, LoadingState } from "../../../components/AsyncState.js";
import { StatusBadge } from "../../../components/StatusBadge.js";
import { capabilityDecision } from "../capability.js";
import { p2EnumLabel } from "../labels.js";
import { KnowledgeEvolutionPanel } from "../../evolution/KnowledgeEvolutionPanel.js";

export function KnowledgePage({ api, knowledgeId }: { readonly api: ConsoleApi; readonly knowledgeId?: string }): React.JSX.Element {
  return knowledgeId === undefined ? <KnowledgeListPage api={api} /> : <KnowledgeDetailPage api={api} knowledgeId={knowledgeId} />;
}

function KnowledgeListPage({ api }: { readonly api: ConsoleApi }): React.JSX.Element {
  const [draft, setDraft] = useState<KnowledgeFilter>({});
  const [filter, setFilter] = useState<KnowledgeFilter>({});
  const load = useCallback(async (signal: AbortSignal) => {
    const capabilities = await api.capabilities(signal);
    const capability = capabilityDecision(capabilities.items, ["knowledge.governance", "knowledge.compiler", "knowledge.worker"]);
    if (!capability.ready || api.knowledgeList === undefined) return { capability, list: undefined };
    return { capability, list: await api.knowledgeList(filter, signal) };
  }, [api, filter]);
  const [state, retry] = useAsync(load);
  if (state.status === "loading") return <LoadingState label="正在读取知识索引" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const { capability, list } = state.value;
  return <div className="page-stack"><header className="page-header"><div><p className="eyebrow">KNOWLEDGE</p><h1>知识库</h1><p>服务端索引、版本与召回资格的只读事实视图</p></div><StatusBadge status={capability.status} /></header>
    {!capability.ready || api.knowledgeList === undefined ? <section className="state-panel state-disabled" aria-labelledby="knowledge-disabled"><div><StatusBadge status={capability.status} /><h2 id="knowledge-disabled">知识查询不可用</h2><p>{capability.capabilityId} · {capability.reasonCode}{capability.ready ? " · KNOWLEDGE_QUERY_API_NOT_EXPOSED" : ""}</p></div></section> : <>
      <KnowledgeFilters draft={draft} onChange={setDraft} onApply={() => setFilter(draft)} />
      {list === undefined ? <EmptyState title="没有服务端结果" detail="知识 API 没有返回索引视图。" /> : <KnowledgeList value={list} />}
    </>}
  </div>;
}

function KnowledgeFilters({ draft, onChange, onApply }: { readonly draft: KnowledgeFilter; readonly onChange: (value: KnowledgeFilter) => void; readonly onApply: () => void }): React.JSX.Element {
  const text = (key: keyof KnowledgeFilter, value: string): void => onChange({ ...draft, [key]: value || undefined });
  return <form className="panel knowledge-filters" aria-label="知识筛选" onSubmit={(event) => { event.preventDefault(); onApply(); }}><div className="filter-grid">
    <label>Scope<select value={draft.scope ?? ""} onChange={(event) => text("scope", event.currentTarget.value)}><option value="">全部</option><option>TASK</option><option>SYMBOL</option><option>MODULE</option><option>PROJECT</option><option>GLOBAL</option></select></label>
    <label>项目<input value={draft.projectId ?? ""} onChange={(event) => text("projectId", event.currentTarget.value)} /></label>
    <label>类型<input value={draft.kind ?? ""} onChange={(event) => text("kind", event.currentTarget.value)} /></label>
    <label>状态<select value={draft.status ?? ""} onChange={(event) => text("status", event.currentTarget.value)}><option value="">全部</option><option>PROPOSED</option><option>ACCEPTED</option><option>IMPLEMENTED</option><option>VERIFIED</option><option>STALE</option><option>SUPERSEDED</option><option>REJECTED</option></select></label>
    <label>Subject<input value={draft.subject ?? ""} onChange={(event) => text("subject", event.currentTarget.value)} /></label>
    <label>Symbol<input value={draft.symbol ?? ""} onChange={(event) => text("symbol", event.currentTarget.value)} /></label>
    <label>关键词<input value={draft.keyword ?? ""} onChange={(event) => text("keyword", event.currentTarget.value)} /></label>
    <label>Evidence<select value={draft.evidenceVerdict ?? ""} onChange={(event) => text("evidenceVerdict", event.currentTarget.value)}><option value="">全部</option><option>SUPPORTS</option><option>CONTRADICTS</option><option>INCONCLUSIVE</option></select></label>
    <label>版本<input type="number" min="1" value={draft.version ?? ""} onChange={(event) => onChange({ ...draft, version: event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value) })} /></label>
    <label>召回资格<select value={draft.eligible === undefined ? "" : String(draft.eligible)} onChange={(event) => onChange({ ...draft, eligible: event.currentTarget.value === "" ? undefined : event.currentTarget.value === "true" })}><option value="">全部</option><option value="true">可召回</option><option value="false">不可召回</option></select></label>
  </div><button className="primary-button" type="submit">应用服务端筛选</button></form>;
}

function KnowledgeList({ value }: { readonly value: KnowledgeListView }): React.JSX.Element {
  return <section className="panel"><div className="section-heading"><div><h2>知识索引</h2><span>revision {value.revision} · {value.items.length} 条</span></div><div><StatusBadge status={value.indexStatus} /><small>{value.indexReasonCode}{value.retryable ? " · RETRYABLE" : ""}</small></div></div>
    {value.indexStatus === "DEGRADED" ? <div className="inline-alert warning"><strong>{value.indexReasonCode}</strong><p>索引可能落后；页面不会把缺失结果解释为无知识。</p></div> : undefined}
    {value.items.length === 0 ? <EmptyState title="没有匹配知识" detail="请调整筛选条件；空结果来自服务端。" /> : <div className="knowledge-list">{value.items.map((item) => <a key={`${item.knowledgeId}:${item.version}`} href={`#/knowledge/${encodeURIComponent(item.knowledgeId)}`}><div><strong>{item.title}</strong><StatusBadge status={item.status} /></div><p>{item.summary}</p><small>{item.subjectKey} · {item.kind} · {item.scope}{item.projectId === undefined ? "" : `/${item.projectId}`} · v{item.version}</small><div><StatusBadge status={item.evidenceVerdict} /><StatusBadge status={item.freshnessStatus} /><span title={item.freshnessReasonCode}>{item.eligible ? "可召回" : `不可召回：${item.eligibilityReasonCodes.map(p2EnumLabel).join("，")}`}</span></div></a>)}</div>}
  </section>;
}

function KnowledgeDetailPage({ api, knowledgeId }: { readonly api: ConsoleApi; readonly knowledgeId: string }): React.JSX.Element {
  const [serverValue, setServerValue] = useState<KnowledgeDetailView>();
  const load = useCallback(async (signal: AbortSignal) => {
    const capabilities = await api.capabilities(signal);
    const capability = capabilityDecision(capabilities.items, ["knowledge.governance", "knowledge.compiler", "knowledge.worker"]);
    if (!capability.ready || api.knowledgeDetail === undefined) return { capability, detail: undefined };
    return { capability, detail: await api.knowledgeDetail(knowledgeId, signal) };
  }, [api, knowledgeId]);
  const [state, retry] = useAsync(load);
  useEffect(() => setServerValue(undefined), [knowledgeId]);
  if (state.status === "loading") return <LoadingState label="正在读取知识详情" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const { capability, detail } = state.value;
  const value = serverValue ?? detail;
  if (!capability.ready || api.knowledgeDetail === undefined || value === undefined) return <div className="page-stack"><a className="back-link" href="#/knowledge">← 返回知识库</a><section className="state-panel"><div><StatusBadge status={capability.status} /><h2>知识详情不可用</h2><p>{capability.reasonCode}{capability.ready ? " · KNOWLEDGE_DETAIL_API_NOT_EXPOSED" : ""}</p></div></section></div>;
  return <div className="page-stack"><a className="back-link" href="#/knowledge">← 返回知识库</a><header className="page-header"><div><p className="eyebrow">{value.knowledgeId}@{value.version}</p><h1>{value.title}</h1><p>{value.subjectKey} · revision {value.revision}</p></div><div><StatusBadge status={value.status} /><StatusBadge status={value.eligible ? "ELIGIBLE" : "INELIGIBLE"} /></div></header>
    {!value.eligible ? <div className="inline-alert warning"><strong>当前版本不进入默认召回</strong><p>{value.eligibilityReasonCodes.join(", ")}</p></div> : undefined}
    <section className="panel detail-split"><div><h2>Markdown</h2><pre className="markdown-preview">{value.markdown}</pre></div><div><h2>Scope 与断言</h2><dl className="detail-grid"><div><dt>Scope</dt><dd>{value.scope}{value.projectId === undefined ? "" : ` / ${value.projectId}`}</dd></div><div><dt>类型</dt><dd>{value.kind}</dd></div><div><dt>置信度</dt><dd>{value.confidence.toFixed(2)}</dd></div><div><dt>Scope 决策</dt><dd>{value.scopeReasonCodes.join(", ")}</dd></div></dl><ul>{value.assertions.map((item) => <li key={item.assertionId}><StatusBadge status={item.status} /> {item.text}</li>)}</ul></div></section>
    <KnowledgeLocalization value={value} />
    <FreshnessPanel value={value.freshness} />
    <KnowledgeEvolutionPanel api={api} knowledgeId={value.knowledgeId} title={value.title} summary={value.summary} body={value.markdown} />
    <VersionHistory versions={value.versions} currentVersion={value.version} />
    <section className="panel p2-grid"><div><h2>Evidence</h2>{value.evidence.map((item) => <article className="fact-row" key={item.evidenceId}><div><strong>{item.source}</strong><StatusBadge status={item.verdict} /></div><small>{item.evidenceId} · {item.reasonCode}</small></article>)}</div><div><h2>关系</h2>{value.relations.map((item) => <a className="fact-row" key={`${item.relation}:${item.knowledgeId}`} href={`#/knowledge/${encodeURIComponent(item.knowledgeId)}`}><strong>{item.relation} → {item.title}</strong><small>{item.knowledgeId}@{item.version}</small></a>)}</div></section>
    <section className="panel p2-grid"><div><h2>来源链</h2><Provenance value={value.provenance} /></div><div><h2>Lifecycle</h2>{value.lifecycle.map((item) => <article className="fact-row" key={`${item.status}:${item.occurredAt}`}><div><strong>{item.reasonCode}</strong><StatusBadge status={item.status} /></div><small>{new Date(item.occurredAt).toLocaleString()}</small></article>)}</div><div><h2>使用记录</h2>{value.usage.map((item) => <a className="fact-row" key={`${item.sessionId}:${item.turnId}`} href={`#/sessions/${encodeURIComponent(item.sessionId)}`}><strong>{item.mode} · {item.turnId}</strong><small>{new Date(item.occurredAt).toLocaleString()}</small></a>)}</div></section>
    <KnowledgeGovernance api={api} value={value} onServerValue={setServerValue} onRefresh={retry} />
  </div>;
}

function KnowledgeLocalization({ value }: { readonly value: KnowledgeDetailView }): React.JSX.Element {
  const location = value.localization;
  if (location === undefined) return <section className="panel"><h2>定位与场景</h2><p className="muted">旧版接口未返回定位投影；该知识不会被当作已定位的当前代码事实。</p></section>;
  return <section className="panel" aria-labelledby="knowledge-localization-heading">
    <div className="section-heading"><div><h2 id="knowledge-localization-heading">定位、场景与 CodeGraph 证据</h2><span>先按项目/分支/提交过滤，再进行场景召回</span></div><StatusBadge status={location.state} /></div>
    <dl className="detail-grid">
      <div><dt>结论语义</dt><dd>{location.claimMode === undefined ? "旧版未声明" : p2EnumLabel(location.claimMode)}</dd></div>
      <div><dt>项目</dt><dd>{location.projectId ?? "未定位"}</dd></div>
      <div><dt>观察分支</dt><dd>{location.observedBranch ?? "未记录"}</dd></div>
      <div><dt>观察提交</dt><dd>{location.observedCommit ?? "未记录"}{location.dirty === true ? "（工作区有未提交变更）" : ""}</dd></div>
      <div><dt>分支适用策略</dt><dd>{location.branchMode === undefined ? "未声明" : `${p2EnumLabel(location.branchMode)} · ${location.branchValue ?? ""}`}</dd></div>
      <div><dt>场景</dt><dd>{location.scenarioTitle ?? "未定位"}{location.scenarioKey === undefined ? "" : ` · ${location.scenarioKey}`}</dd></div>
    </dl>
    <div className="p2-grid"><div><h3>场景边界</h3><p>{location.scenarioSummary ?? "未记录场景摘要"}</p><p><strong>任务意图：</strong>{location.taskIntents.join("、") || "未声明"}</p><p><strong>入口：</strong>{location.entryPoints.join("、") || "未声明"}</p><p><strong>适用：</strong>{location.applicability.join("；") || "未声明"}</p><p><strong>不适用：</strong>{location.nonApplicability.join("；") || "未声明"}</p><small>{location.reasonCodes.map(p2EnumLabel).join("；")}</small></div>
      <div><h3>场景投影</h3>{value.scenario === undefined ? <p className="muted">没有场景投影。</p> : <><p><StatusBadge status={value.scenario.projected ? "PROJECTED" : "NOT_PROJECTED"} /> {value.scenario.title}</p><p>{value.scenario.summary}</p><small>{value.scenario.scenarioId}{value.scenario.version === undefined ? "" : ` · v${value.scenario.version}`} · {value.scenario.knowledgeVersions.length} 条知识 · {value.scenario.relationCount} 条关系</small>{value.scenario.markdown === undefined ? undefined : <details><summary>查看场景 Markdown</summary><pre className="markdown-preview">{value.scenario.markdown}</pre></details>}</>}</div></div>
    <h3>CodeGraph 可复用产物（{value.codeGraphArtifacts?.length ?? 0}）</h3>
    {(value.codeGraphArtifacts?.length ?? 0) === 0 ? <p className="muted">当前知识版本没有绑定 CodeGraph 产物；实时查询仍可执行，但无法复用历史链路。</p> : <div>{value.codeGraphArtifacts?.map((artifact) => <article className="fact-row" key={artifact.artifactId}><div><strong>{p2EnumLabel(artifact.operation)} · {artifact.query}</strong><StatusBadge status={artifact.status} /></div><p>代码 {artifact.codeRevision}{artifact.graphRevision === undefined ? "" : ` · 图 ${artifact.graphRevision}`} · {artifact.factCount} 条事实{artifact.bounded ? "（结果已截断）" : ""}</p><small>{artifact.artifactId} · {artifact.sourceRef} · {new Date(artifact.observedAt).toLocaleString()}</small></article>)}</div>}
  </section>;
}

function FreshnessPanel({ value }: { readonly value: KnowledgeDetailView["freshness"] }): React.JSX.Element {
  return <section className="panel" aria-labelledby="freshness-heading">
    <div className="section-heading"><div><h2 id="freshness-heading">代码知识保鲜</h2><span>状态 revision {value.revision} · {value.projected ? "已建立版本投影" : "没有版本投影"}</span></div><StatusBadge status={value.status} /></div>
    <dl className="detail-grid"><div><dt>代码 revision</dt><dd>{value.codeRevision ?? "未记录"}</dd></div><div><dt>CodeGraph revision</dt><dd>{value.graphRevision ?? "未记录"}</dd></div><div><dt>最近更新</dt><dd>{value.updatedAt === undefined ? "未记录" : new Date(value.updatedAt).toLocaleString()}</dd></div><div><dt>受影响断言</dt><dd>{value.affectedAssertionIds.join("、") || "无"}</dd></div></dl>
    <div className="inline-alert"><strong>当前判断依据</strong><p>{value.reasonCodes.map(p2EnumLabel).join("；") || "当前版本尚无额外诊断"}</p><small>{value.reasonCodes.join(", ") || "NO_REASON_CODE"}</small></div>
    <div className="p2-grid"><div><h3>代码锚点（{value.anchors.length}）</h3>{value.anchors.length === 0 ? <p className="muted">没有代码、配置或依赖锚点。</p> : <div>{value.anchors.map((anchor) => <article className="fact-row" key={`${anchor.kind}:${anchor.assertionId}`}><div><strong>{p2EnumLabel(anchor.kind)} · {anchor.key}</strong><StatusBadge status={anchor.kind} /></div><small>{anchor.assertionId}{anchor.path === undefined ? "" : ` · ${anchor.path}`}</small></article>)}</div>}</div>
      <div><h3>不可变状态事件（{value.events.length}）</h3>{value.events.length === 0 ? <p className="muted">当前版本没有状态迁移事件。</p> : <div>{value.events.map((event) => <article className="fact-row" key={event.eventId}><div><strong>{p2EnumLabel(event.previousStatus)} → {p2EnumLabel(event.status)}</strong><StatusBadge status={event.status} /></div><p>{event.reasonCodes.map(p2EnumLabel).join("；")}</p><small>r{event.revision} · {new Date(event.occurredAt).toLocaleString()} · code {event.codeRevision}{event.graphRevision === undefined ? "" : ` · graph ${event.graphRevision}`}</small></article>)}</div>}</div></div>
  </section>;
}

function VersionHistory({ versions, currentVersion }: { readonly versions: KnowledgeDetailView["versions"]; readonly currentVersion: number }): React.JSX.Element {
  const [selected, setSelected] = useState(currentVersion);
  const version = versions.find((item) => item.version === selected) ?? versions[0];
  return <section className="panel"><div className="section-heading"><h2>版本与 Diff</h2><label>选择版本 <select aria-label="知识版本" value={selected} onChange={(event) => setSelected(Number(event.currentTarget.value))}>{versions.map((item) => <option key={item.version} value={item.version}>v{item.version} · {item.status}</option>)}</select></label></div>{version === undefined ? <p className="muted">没有版本历史。</p> : <><p><StatusBadge status={version.status} /> {version.reasonCode} · {new Date(version.createdAt).toLocaleString()}</p><pre className="diff-preview">{version.diffFromPrevious ?? "初始版本，无前序 diff"}</pre></>}</section>;
}

function KnowledgeGovernance({ api, value, onServerValue, onRefresh }: { readonly api: ConsoleApi; readonly value: KnowledgeDetailView; readonly onServerValue: (value: KnowledgeDetailView) => void; readonly onRefresh: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState<KnowledgeEditDraft>({ title: value.title, summary: value.summary, markdown: value.markdown });
  const [impact, setImpact] = useState<KnowledgeEditImpact>();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<string>();
  const [message, setMessage] = useState<string>();
  useEffect(() => { setDraft({ title: value.title, summary: value.summary, markdown: value.markdown }); setImpact(undefined); }, [value.knowledgeId, value.version, value.markdown, value.summary, value.title]);
  const staleEditGate = value.editAction.expectedRevision !== value.version;
  const editApiMissing = api.previewKnowledgeEdit === undefined || api.commitKnowledgeEdit === undefined;
  const lifecycleApiMissing = api.suppressKnowledge === undefined || api.restoreKnowledge === undefined;
  const editEnabled = value.editAction.enabled && !staleEditGate && api.previewKnowledgeEdit !== undefined && pending === undefined;
  const command = { knowledgeId: value.knowledgeId, expectedVersion: value.editAction.expectedRevision, idempotencyKey: value.editAction.idempotencyKey, draft } as const;
  const run = async (name: string, operation: () => Promise<KnowledgeDetailView | KnowledgeEditImpact>): Promise<void> => {
    setPending(name); setMessage(undefined);
    try {
      const result = await operation();
      if ("proposedVersion" in result) { setImpact(result); setMessage("影响预览来自服务端；提交前仍会校验 expected version。"); }
      else { onServerValue(result); setMessage("操作已创建新版本；页面已切换到服务端返回的 revision。"); }
    } catch (error) {
      setMessage(error instanceof Error ? `CONFLICT_OR_COMMAND_ERROR：${error.message}。请刷新后重试，旧版本未被覆盖。` : "命令失败；旧版本未被覆盖。");
    } finally { setPending(undefined); }
  };
  const preview = (): void => { if (editEnabled && api.previewKnowledgeEdit !== undefined) void run("preview", async () => await api.previewKnowledgeEdit!(command)); };
  const commitEnabled = impact !== undefined && impact.basedOnVersion === value.version && api.commitKnowledgeEdit !== undefined && pending === undefined;
  const lifecycle = (kind: "suppress" | "restore"): void => {
    const gate = kind === "suppress" ? value.suppressAction : value.restoreAction;
    const method = kind === "suppress" ? api.suppressKnowledge : api.restoreKnowledge;
    if (!gate.enabled || gate.expectedRevision !== value.version || method === undefined || reason.trim() === "" || pending !== undefined) return;
    void run(kind, async () => await method({ knowledgeId: value.knowledgeId, expectedVersion: gate.expectedRevision, idempotencyKey: gate.idempotencyKey, reason: reason.trim() }));
  };
  return <section className="panel governance-panel" aria-labelledby="governance-heading"><div className="section-heading"><h2 id="governance-heading">知识治理</h2><span>仅开放低风险、可逆且带 expected-version 的操作</span></div>
    {staleEditGate ? <div className="inline-alert error" role="alert"><strong>STALE_REVISION</strong><p>编辑门禁基于 v{value.editAction.expectedRevision}，当前为 v{value.version}。刷新后再操作。</p><button type="button" className="secondary-button" onClick={onRefresh}>刷新</button></div> : undefined}
    {editApiMissing ? <div className="inline-alert warning"><strong>KNOWLEDGE_EDIT_API_NOT_EXPOSED</strong><p>详情仍可查看；编辑预览或提交端口不完整，因此不允许写入。</p></div> : undefined}
    <div className="edit-grid"><label>标题<input value={draft.title} onChange={(event) => { setDraft({ ...draft, title: event.currentTarget.value }); setImpact(undefined); }} /></label><label>摘要<textarea value={draft.summary} onChange={(event) => { setDraft({ ...draft, summary: event.currentTarget.value }); setImpact(undefined); }} /></label><label>Markdown<textarea rows={10} value={draft.markdown} onChange={(event) => { setDraft({ ...draft, markdown: event.currentTarget.value }); setImpact(undefined); }} /></label></div>
    <div className="capture-actions"><button type="button" className="secondary-button" disabled={!editEnabled} title={value.editAction.reasonCode} onClick={preview}>{pending === "preview" ? "分析中…" : "预览编辑影响"}</button><button type="button" className="primary-button" disabled={!commitEnabled} onClick={() => { if (api.commitKnowledgeEdit !== undefined) void run("commit", async () => await api.commitKnowledgeEdit!(command)); }}>{pending === "commit" ? "提交中…" : "创建新知识版本"}</button></div>
    {impact === undefined ? undefined : <div className="impact-preview"><h3>v{impact.basedOnVersion} → v{impact.proposedVersion}</h3><p>字段：{impact.changedFields.join(", ") || "无"}</p><p>Scope 变化：{String(impact.scopeChanged)} · Evidence 降级：{String(impact.evidenceDowngraded)} · 召回资格：{String(impact.eligibleBefore)} → {String(impact.eligibleAfter)}</p><small>{impact.reasonCodes.join(", ")}</small></div>}
    <hr /><label>移除/恢复原因<input value={reason} onChange={(event) => setReason(event.currentTarget.value)} /></label><div className="capture-actions"><button type="button" className="secondary-button" disabled={!value.suppressAction.enabled || value.suppressAction.expectedRevision !== value.version || api.suppressKnowledge === undefined || reason.trim() === "" || pending !== undefined} onClick={() => lifecycle("suppress")}>创建可恢复的 suppress 版本</button><button type="button" className="secondary-button" disabled={!value.restoreAction.enabled || value.restoreAction.expectedRevision !== value.version || api.restoreKnowledge === undefined || reason.trim() === "" || pending !== undefined} onClick={() => lifecycle("restore")}>重新校验并恢复</button></div>
    {lifecycleApiMissing ? <p className="muted">KNOWLEDGE_LIFECYCLE_API_NOT_EXPOSED · suppress/restore 保持禁用</p> : undefined}
    <div className="inline-alert warning"><strong>高风险操作保持禁用</strong><p>GLOBAL/RULE 修改、绑定重写和物理清除必须由后续专用审批链处理。</p></div>
    {message === undefined ? undefined : <p className="inline-alert" role="status" aria-live="polite">{message}</p>}
  </section>;
}

function Provenance({ value }: { readonly value: KnowledgeDetailView["provenance"] }): React.JSX.Element {
  return <dl className="provenance-grid"><div><dt>Session / Turn</dt><dd>{value.sessionIds.map((id) => <a key={id} href={`#/sessions/${encodeURIComponent(id)}`}>{id}</a>)} / {value.turnIds.join(", ")}</dd></div><div><dt>Event / Snapshot</dt><dd>{value.eventIds.join(", ")} / {value.snapshotIds.join(", ")}</dd></div><div><dt>Episode</dt><dd>{value.episodeIds.join(", ")}</dd></div><div><dt>Knowledge</dt><dd>{value.knowledgeVersions.map((item) => `${item.knowledgeId}@${item.version}`).join(", ")}</dd></div></dl>;
}
