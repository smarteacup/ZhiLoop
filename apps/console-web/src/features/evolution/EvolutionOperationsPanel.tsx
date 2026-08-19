import { useCallback } from "react";

import type { ConsoleApi } from "../../api/client.js";
import { useBoundedOperation } from "../../app/useBoundedOperation.js";
import { useInvalidationFeed } from "../p1/live/useInvalidationFeed.js";
import { ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { operationLabel } from "../p2/labels.js";

export function EvolutionOperationsPanel({ api }: { readonly api: ConsoleApi }): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => {
    if (api.evolutionOperations === undefined) throw new Error("演进操作 Read Model 尚未接通");
    return await api.evolutionOperations(signal);
  }, [api]);
  const [state, retry] = useBoundedOperation(load, (value) => value.sections.some((item) => item.status === "RUNNING"), { intervalMs: 2_000 });
  const invalidate = useCallback((resources: readonly string[]) => { if (resources.includes("OPERATIONS")) retry(); }, [retry]);
  useInvalidationFeed(api, invalidate);
  if (state.status === "loading") return <LoadingState label="正在加载知识演进状态" /> as React.JSX.Element;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} /> as React.JSX.Element;
  return <section className="panel" aria-labelledby="evolution-operations-heading">
    <div className="section-heading"><div><span className="eyebrow">EVOLUTION</span><h2 id="evolution-operations-heading">知识演进闭环</h2></div>
      <span title={state.value.consistency}>{state.value.consistency === "CONSISTENT" ? "快照一致" : "分区版本快照"}</span></div>
    <div className="metric-grid">{state.value.sections.map((item) => <article className="metric-card" key={item.area} title={item.reasonCode}>
      <span>{operationLabel(item.area)}</span><strong><StatusBadge status={item.status} /></strong>
      <small>排队 {item.queued} · 运行 {item.running} · 失败 {item.failed}</small>
      <small>{operationLabel(item.reasonCode)}</small>
    </article>)}</div>
  </section>;
}
