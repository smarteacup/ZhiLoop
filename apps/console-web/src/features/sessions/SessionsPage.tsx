import { useCallback, useMemo, useState } from "react";

import type { ConsoleApi, SessionSummary } from "../../api/client.js";
import { useAsync } from "../../app/useAsync.js";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";

function groupLabel(value: string, now = new Date()): string {
  const date = new Date(value);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const difference = Math.floor((start - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  return difference <= 0 ? "今天" : difference === 1 ? "昨天" : difference <= 7 ? "最近 7 天" : "更早";
}

export function groupSessions(items: readonly SessionSummary[]): readonly { readonly label: string; readonly items: readonly SessionSummary[] }[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const item of items) {
    const label = groupLabel(item.lastActivityAt);
    const values = groups.get(label) ?? [];
    values.push(item);
    groups.set(label, values);
  }
  return ["今天", "昨天", "最近 7 天", "更早"].flatMap((label) => {
    const values = groups.get(label);
    return values === undefined ? [] : [{ label, items: values }];
  });
}

export function SessionsPage({ api }: { readonly api: ConsoleApi }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("ALL");
  const load = useCallback(async (signal: AbortSignal) => await api.sessions(signal), [api]);
  const [state, retry] = useAsync(load);
  const projects = useMemo(() => state.status !== "success" ? [] : [...new Set(state.value.items.map((item) => item.projectHint ?? item.cwdAlias).filter((value): value is string => value !== undefined))].sort(), [state]);
  const groups = useMemo(() => state.status !== "success" ? [] : groupSessions(state.value.items.filter((item) => {
    const itemProject = item.projectHint ?? item.cwdAlias;
    return (project === "ALL" || itemProject === project) && `${item.title} ${itemProject ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
  })), [project, query, state]);
  if (state.status === "loading") return <LoadingState label="正在发现本地 Codex 会话" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  return <div className="page-stack"><header className="page-header"><div><p className="eyebrow">READ ONLY</p><h1>会话与采集</h1><p>会话来源与 Ledger 分离；本页面不会修改 Codex 会话。</p></div></header>
    <div className="toolbar"><label htmlFor="project-filter">项目</label><select id="project-filter" value={project} onChange={(event) => setProject(event.target.value)}><option value="ALL">全部项目</option>{projects.map((value) => <option key={value} value={value}>{value}</option>)}</select><label htmlFor="session-search">筛选会话</label><input id="session-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标题或项目" /></div>
    {groups.length === 0 ? <EmptyState title="没有匹配会话" detail="调整筛选条件，或检查 Session Catalog 能力状态。" /> : groups.map((group) => <section className="panel" key={group.label}><h2>{group.label}</h2><div className="session-list">{group.items.map((session) => <a className="session-row" key={session.sessionId} href={`#/sessions/${encodeURIComponent(session.sessionId)}`}><div><strong>{session.title}</strong><span>{session.projectHint ?? session.cwdAlias ?? "未识别项目"}</span></div><StatusBadge status={session.captureStatus} /><time>{new Date(session.lastActivityAt).toLocaleString()}</time></a>)}</div></section>)}
  </div>;
}
