import { useRef, useState } from "react";

import type { ConsoleApi } from "../../api/client.js";
import type {
  KnowledgeAskView,
  KnowledgeSearchCommand,
  RetrievalSimulationView,
  RetrievalTraceView,
} from "../../api/p3.js";
import { StatusBadge } from "../../components/StatusBadge.js";

export interface RetrievalConsoleApi extends Pick<ConsoleApi, "capabilities"> {
  searchKnowledge?(command: KnowledgeSearchCommand, signal?: AbortSignal): Promise<RetrievalTraceView>;
  askZhiLoop?(command: KnowledgeSearchCommand, signal?: AbortSignal): Promise<KnowledgeAskView>;
  simulateRetrieval?(command: KnowledgeSearchCommand, signal?: AbortSignal): Promise<RetrievalSimulationView>;
}

function requestId(): string {
  return `query-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function RetrievalPage({ api }: { readonly api: RetrievalConsoleApi }): React.JSX.Element {
  const [mode, setMode] = useState<"SEARCH" | "ASK">("SEARCH");
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [trace, setTrace] = useState<RetrievalTraceView>();
  const [answer, setAnswer] = useState<KnowledgeAskView>();
  const [simulation, setSimulation] = useState<RetrievalSimulationView>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const run = async (): Promise<void> => {
    if (query.trim() === "" || pending) return;
    setPending(true); setError(undefined); setAnswer(undefined); setSimulation(undefined);
    const command: KnowledgeSearchCommand = {
      requestId: requestId(), query: query.trim(), ...(projectId.trim() === "" ? {} : { projectId: projectId.trim() }),
      maxResults: 20, maxContextTokens: 2_000,
    };
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const capabilities = await api.capabilities();
      const capability = capabilities.items.find((item) => item.capabilityId === "knowledge.retrieval");
      if (capability?.status !== "READY") throw new Error(capability?.reasonCode ?? "RETRIEVAL_CAPABILITY_NOT_REPORTED");
      if (mode === "SEARCH") {
        if (api.searchKnowledge === undefined) throw new Error("RETRIEVAL_QUERY_API_NOT_EXPOSED");
        setTrace(await api.searchKnowledge(command, controller.signal));
      } else {
        if (api.askZhiLoop === undefined) throw new Error("CODEX_QUERY_API_NOT_EXPOSED");
        const value = await api.askZhiLoop(command, controller.signal);
        setAnswer(value); setTrace(value.retrieval);
      }
    } catch (value) {
      setError(controller.signal.aborted ? "QUERY_CANCELLED" : value instanceof Error ? value.message : "QUERY_FAILED");
    } finally {
      if (activeRequest.current === controller) activeRequest.current = undefined;
      setPending(false);
    }
  };
  const compare = async (): Promise<void> => {
    if (api.simulateRetrieval === undefined || query.trim() === "") { setError("RETRIEVAL_SIMULATION_API_NOT_EXPOSED"); return; }
    setPending(true); setError(undefined);
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const capabilities = await api.capabilities();
      const capability = capabilities.items.find((item) => item.capabilityId === "knowledge.retrieval");
      if (capability?.status !== "READY") throw new Error(capability?.reasonCode ?? "RETRIEVAL_CAPABILITY_NOT_REPORTED");
      setSimulation(await api.simulateRetrieval({ requestId: requestId(), query: query.trim(), ...(projectId ? { projectId } : {}), maxResults: 20, maxContextTokens: 2_000 }, controller.signal));
    } catch (value) { setError(controller.signal.aborted ? "QUERY_CANCELLED" : value instanceof Error ? value.message : "SIMULATION_FAILED"); }
    finally {
      if (activeRequest.current === controller) activeRequest.current = undefined;
      setPending(false);
    }
  };
  return <div className="page-stack"><header className="page-header"><div><p className="eyebrow">RETRIEVAL</p><h1>召回知识</h1><p>确定性搜索与本地 Codex 只读综合；P3 结果始终是 SHADOW。</p></div>{trace === undefined ? undefined : <StatusBadge status={trace.injectionResult} />}</header>
    <section className="panel"><div className="tab-list" role="tablist" aria-label="知识查询模式"><button type="button" role="tab" aria-selected={mode === "SEARCH"} onClick={() => setMode("SEARCH")}>搜索知识</button><button type="button" role="tab" aria-selected={mode === "ASK"} onClick={() => setMode("ASK")}>问 ZhiLoop</button></div>
      <label>自然语言问题<textarea rows={4} value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></label><label>项目 ID（可选）<input value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)} /></label>
      <div className="button-row"><button type="button" className="primary-button" disabled={pending || query.trim() === ""} onClick={() => void run()}>{pending ? "处理中…" : mode === "SEARCH" ? "搜索知识" : "问 ZhiLoop"}</button><button type="button" className="secondary-button" disabled={pending || query.trim() === ""} onClick={() => void compare()}>比较当前/草稿策略</button>{pending ? <button type="button" className="danger-button" onClick={() => activeRequest.current?.abort()}>取消查询</button> : undefined}</div>
      {error === undefined ? undefined : <p className="inline-alert warning" role="alert">{error}</p>}</section>
    {answer === undefined ? undefined : <Answer value={answer} />}
    {trace === undefined ? undefined : <Trace value={trace} />}
    {simulation === undefined ? undefined : <PolicyComparison value={simulation} />}
  </div>;
}

function Answer({ value }: { readonly value: KnowledgeAskView }): React.JSX.Element {
  return <section className="panel"><div className="section-heading"><h2>回答</h2><StatusBadge status={value.outcome} /></div>{value.answer === "" ? <p className="muted">Codex 不可用，已降级为确定性搜索结果。</p> : <p>{value.answer}</p>}<h3>引用</h3><ul>{value.citations.map((item) => <li key={`${item.knowledgeId}:${item.version}`}><a href={`#/knowledge/${encodeURIComponent(item.knowledgeId)}`}>{item.knowledgeId}@{item.version}</a></li>)}</ul>{value.unknowns.length === 0 ? undefined : <div className="inline-alert warning"><strong>未知项</strong><p>{value.unknowns.join("；")}</p></div>}{value.conflicts.map((conflict) => <div className="inline-alert warning" key={conflict.summary}><strong>冲突</strong><p>{conflict.summary}</p></div>)}</section>;
}

function Trace({ value }: { readonly value: RetrievalTraceView }): React.JSX.Element {
  return <section className="panel"><div className="section-heading"><div><h2>Retrieval Trace</h2><span>{value.traceId}</span></div><StatusBadge status={value.outcome} /></div><p>{value.envelope.detailLevel} · {value.envelope.estimatedTokens}/{value.envelope.maxTokens} tokens · {value.injectionResult}</p><div className="table-scroll"><table><thead><tr><th>知识</th><th>召回/最终</th><th>通道贡献</th><th>Evidence</th><th>投递</th></tr></thead><tbody>{value.results.map((item) => <tr key={`${item.knowledgeId}:${item.version}`}><td><a href={`#/knowledge/${encodeURIComponent(item.knowledgeId)}`}>{item.title}</a><small>{item.knowledgeId}@{item.version}</small></td><td>{item.retrievalRank} / {item.finalRank}</td><td>{item.contributions.map((entry) => `${entry.channel}#${entry.rank}: ${entry.reason}`).join("；")}</td><td>{item.evidenceIds.join(", ") || "无"}</td><td>SHADOWED</td></tr>)}</tbody></table></div>{value.envelope.omitted.length === 0 ? undefined : <details><summary>未注入项与原因</summary><ul>{value.envelope.omitted.map((item) => <li key={`${item.knowledgeId}:${item.version}`}>{item.knowledgeId}@{item.version} · {item.reason}</li>)}</ul></details>}<details><summary>过滤与降级</summary><ul>{value.filters.map((item, index) => <li key={index}>{item.decision} · {item.reasonCode} · {item.safeMessage}</li>)}</ul></details></section>;
}

function PolicyComparison({ value }: { readonly value: RetrievalSimulationView }): React.JSX.Element {
  return <section className="panel"><h2>策略比较实验室</h2>{value.draft === undefined ? <p className="muted">当前没有草稿策略，simulation 只执行当前策略。</p> : <dl className="detail-grid"><div><dt>当前 tokens</dt><dd>{value.current.envelope.estimatedTokens}</dd></div><div><dt>草稿 tokens</dt><dd>{value.draft.envelope.estimatedTokens}</dd></div><div><dt>差值</dt><dd>{value.comparison?.tokenDelta ?? 0}</dd></div><div><dt>草稿独有</dt><dd>{value.comparison?.selectedOnlyByDraft.join(", ") || "无"}</dd></div></dl>}<p className="muted">实验结果不会写入真实反馈。</p></section>;
}
