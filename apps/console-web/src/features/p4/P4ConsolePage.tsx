import { useState } from "react";

import type { P4ConsoleApi } from "../../api/p4.js";
import { ClosurePage } from "./ClosurePage.js";
import { FeedbackPanel } from "./FeedbackPanel.js";
import { HighRiskGovernancePanel } from "./HighRiskGovernancePanel.js";
import { InjectionPanel } from "./InjectionPanel.js";
import { RolloutPage } from "./RolloutPage.js";

type Tab = "INJECTION" | "CLOSURE" | "ROLLOUT" | "GOVERNANCE";

export function P4ConsolePage({ api, sessionId }: { readonly api: P4ConsoleApi; readonly sessionId: string }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("INJECTION");
  return <div className="page-stack"><nav className="tab-list" aria-label="P4 控制台" role="tablist">{(["INJECTION", "CLOSURE", "ROLLOUT", "GOVERNANCE"] as const).map((item) => <button type="button" role="tab" aria-selected={tab === item} key={item} onClick={() => setTab(item)}>{item}</button>)}</nav>
    {tab === "INJECTION" ? <><InjectionPanel api={api} sessionId={sessionId} /><FeedbackPanel api={api} sessionId={sessionId} /></> : undefined}
    {tab === "CLOSURE" ? <ClosurePage api={api} sessionId={sessionId} /> : undefined}
    {tab === "ROLLOUT" ? <RolloutPage api={api} /> : undefined}
    {tab === "GOVERNANCE" ? <HighRiskGovernancePanel api={api} /> : undefined}
  </div>;
}

export { ClosurePage } from "./ClosurePage.js";
export { FeedbackPanel } from "./FeedbackPanel.js";
export { HighRiskGovernancePanel } from "./HighRiskGovernancePanel.js";
export { InjectionPanel } from "./InjectionPanel.js";
export { RolloutPage } from "./RolloutPage.js";
