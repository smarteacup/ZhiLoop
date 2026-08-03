const good = new Set(["READY", "SUCCEEDED", "CAPTURED_CURRENT", "INJECTED"]);
const warning = new Set(["DEGRADED", "NOT_VERIFIED", "CAPTURED_PARTIAL", "SHADOWED", "RETRY_WAIT"]);

export function StatusBadge({ status }: { readonly status: string }): React.JSX.Element {
  const tone = good.has(status) ? "good" : warning.has(status) ? "warning" : status === "FAILED" || status === "ERROR" ? "bad" : "neutral";
  return <span className={`status-tag ${tone}`}>{status}</span>;
}
