import { useCallback } from "react";

import type { ConsoleApi } from "../../api/client.js";
import { useAsync } from "../../app/useAsync.js";
import { ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";

export function DeploymentPage({ api }: { readonly api: ConsoleApi }): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => await api.capabilities(signal), [api]);
  const [state, retry] = useAsync(load);
  if (state.status === "loading") return <LoadingState label="正在读取部署能力" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  return <div className="page-stack"><header className="page-header"><div><p className="eyebrow">CAPABILITY MATRIX</p><h1>部署与能力</h1><p>源码存在、已组合、已配置和真实验证是不同状态。</p></div></header><section className="panel"><div className="capability-grid">{state.value.items.map((item) => <article className="capability-card" key={item.capabilityId}><div><strong>{item.capabilityId}</strong><StatusBadge status={item.status} /></div><p>{item.reasonCode}</p><small>{item.evidenceRefs.join(" · ") || "无证据"}</small></article>)}</div></section></div>;
}
