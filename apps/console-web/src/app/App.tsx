import type { ConsoleApi } from "../api/client.js";
import { browserConsoleApi } from "../api/client.js";
import { DisabledState } from "../components/AsyncState.js";
import { DeploymentPage } from "../features/deployment/DeploymentPage.js";
import { OperationsPage } from "../features/operations/OperationsPage.js";
import { OverviewPage } from "../features/overview/OverviewPage.js";
import { SessionDetailPage } from "../features/sessions/SessionDetailPage.js";
import { SessionsPage } from "../features/sessions/SessionsPage.js";
import { useRoute, type RouteName } from "./routes.js";

const navigation: readonly { readonly name: RouteName; readonly label: string }[] = [
  { name: "overview", label: "总览" },
  { name: "sessions", label: "会话与采集" },
  { name: "knowledge", label: "知识库" },
  { name: "retrieval", label: "召回与注入" },
  { name: "closure", label: "闭环验证" },
  { name: "operations", label: "任务与诊断" },
  { name: "configuration", label: "配置中心" },
  { name: "deployment", label: "部署与能力" },
];

function CurrentPage({ api }: { readonly api: ConsoleApi }): React.JSX.Element {
  const route = useRoute();
  if (route.name === "overview") return <OverviewPage api={api} />;
  if (route.name === "sessions") return route.sessionId === undefined ? <SessionsPage api={api} /> : <SessionDetailPage api={api} sessionId={route.sessionId} />;
  if (route.name === "operations") return <OperationsPage api={api} />;
  if (route.name === "deployment") return <DeploymentPage api={api} />;
  if (route.name === "knowledge") return <DisabledState title="知识库尚未接通" reason="KNOWLEDGE_WORKER_NOT_COMPOSED · P2 实现后启用" />;
  if (route.name === "retrieval") return <DisabledState title="召回与注入尚未接通" reason="CAPABILITY_DISABLED · P3 实现后启用" />;
  if (route.name === "closure") return <DisabledState title="闭环验证尚未接通" reason="STOP_VERIFIER_NOT_COMPOSED · P4 实现后启用" />;
  return <DisabledState title="配置写入尚未接通" reason="CAPABILITY_DISABLED · P1 实现后启用" />;
}

export function App({ api = browserConsoleApi }: { readonly api?: ConsoleApi }): React.JSX.Element {
  const route = useRoute();
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">知</span><div><strong>ZhiLoop</strong><small>LOCAL CONSOLE</small></div></div><nav aria-label="主导航">{navigation.map((item) => <a key={item.name} href={`#/${item.name}`} aria-current={route.name === item.name ? "page" : undefined}>{item.label}</a>)}</nav><div className="sidebar-footer"><span className="status-dot" aria-hidden="true" /><div><strong>LOCAL</strong><small>当前用户 · SHADOW</small></div></div></aside><main id="main-content" tabIndex={-1}><CurrentPage api={api} /></main></div>;
}
