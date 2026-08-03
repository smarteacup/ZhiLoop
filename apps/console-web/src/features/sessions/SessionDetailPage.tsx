import { useCallback, useState } from "react";

import type { ConsoleApi } from "../../api/client.js";
import { useAsync } from "../../app/useAsync.js";
import { ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { SessionExtractionPanel } from "../p2/session/SessionExtractionPanel.js";
import { InjectionPanel } from "../p4/InjectionPanel.js";
import { CapturePanel } from "./CapturePanel.js";

export function SessionDetailPage({ api, sessionId }: { readonly api: ConsoleApi; readonly sessionId: string }): React.JSX.Element {
  const [tab, setTab] = useState<"chain" | "events" | "injections" | "extraction">("chain");
  const load = useCallback(async (signal: AbortSignal) => {
    const [detail, events] = await Promise.all([api.session(sessionId, signal), api.events(sessionId, undefined, signal)]);
    return { detail, events };
  }, [api, sessionId]);
  const [state, retry] = useAsync(load);
  if (state.status === "loading") return <LoadingState label="正在读取会话详情" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const { detail, events } = state.value;
  return <div className="page-stack"><a className="back-link" href="#/sessions">← 返回会话</a><header className="page-header"><div><p className="eyebrow">{detail.summary.sessionId}</p><h1>{detail.summary.title}</h1><p>{detail.summary.projectHint ?? "未识别项目"} · 只读</p></div><StatusBadge status={detail.summary.captureStatus} /></header>
    <CapturePanel api={api} sessionId={sessionId} sourceAvailable={detail.summary.sourceStatus === "AVAILABLE"} />
    <a className="secondary-button" href={`#/closure/${encodeURIComponent(sessionId)}`}>查看 P4 闭环与治理</a>
    <div className="tab-list" role="tablist" aria-label="会话详情"><button type="button" role="tab" aria-selected={tab === "chain"} onClick={() => setTab("chain")}>生产链</button><button type="button" role="tab" aria-selected={tab === "extraction"} onClick={() => setTab("extraction")}>知识提取</button><button type="button" role="tab" aria-selected={tab === "events"} onClick={() => setTab("events")}>事件元数据</button><button type="button" role="tab" aria-selected={tab === "injections"} onClick={() => setTab("injections")}>注入记录</button></div>
    {tab === "chain" ? <section className="panel" role="tabpanel"><div className="section-heading"><h2>知识生产链</h2><span>{detail.stages.length} 个阶段</span></div>{detail.stages.length === 0 ? <p className="muted">生产知识能力未接通，暂无阶段记录。</p> : <ol className="stage-list">{detail.stages.map((stage) => <li key={`${stage.stage}:${stage.lastTransitionAt}`}><div><strong>{stage.stage}</strong><small>{stage.reasonCode}</small></div><StatusBadge status={stage.status} /></li>)}</ol>}</section> : undefined}
    {tab === "events" ? <section className="panel" role="tabpanel"><div className="section-heading"><h2>事件元数据</h2><span>仅展示脱敏索引，不展示原始 Prompt</span></div>{events.items.length === 0 ? <p className="muted">当前会话没有已沉淀事件。</p> : <div className="event-list">{events.items.map((event) => <article key={event.eventId}><div><strong>#{event.sequence} · {event.eventType}</strong><time>{new Date(event.occurredAt).toLocaleString()}</time></div><dl className="detail-grid"><div><dt>事件 ID</dt><dd>{event.eventId}</dd></div><div><dt>关联 ID</dt><dd>{event.correlationId}</dd></div><div><dt>脱敏数量</dt><dd>{event.redactionCount}</dd></div><div><dt>内容状态</dt><dd>{event.payloadPurged ? "已清除" : "哈希已记录"}</dd></div></dl></article>)}</div>}<p className="muted">{events.nextCursor === undefined ? "已到末页" : "还有更多事件，可使用服务端游标继续读取"}</p></section> : undefined}
    {tab === "injections" ? api.sessionInjections === undefined
      ? <section className="panel" role="tabpanel"><div className="section-heading"><h2>注入记录</h2><span>SHADOW 与实际投递严格区分</span></div><p className="muted">P4_INJECTION_ADAPTER_NOT_COMPOSED</p></section>
      : <div role="tabpanel"><InjectionPanel api={{ sessionInjections: api.sessionInjections }} sessionId={sessionId} /></div> : undefined}
    {tab === "extraction" ? <SessionExtractionPanel api={api} sessionId={sessionId} /> : undefined}
    <section className="panel"><h2>覆盖与游标</h2><dl className="detail-grid"><div><dt>来源</dt><dd>{detail.summary.source}</dd></div><div><dt>事件</dt><dd>{detail.summary.eventCount}</dd></div><div><dt>Turn</dt><dd>{detail.summary.turnCount}</dd></div><div><dt>游标</dt><dd>{detail.latestCursor === undefined ? "未采集" : `${detail.latestCursor.lineNumber} 行 / ${detail.latestCursor.byteOffset} bytes`}</dd></div></dl></section>
  </div>;
}
