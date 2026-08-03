import type { ReactNode } from "react";

export function LoadingState({ label = "正在加载" }: { readonly label?: string }): ReactNode {
  return <div className="state-panel" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function EmptyState({ title, detail }: { readonly title: string; readonly detail: string }): ReactNode {
  return <section className="state-panel" aria-labelledby="empty-title"><div><h2 id="empty-title">{title}</h2><p>{detail}</p></div></section>;
}

export function DisabledState({ title, reason }: { readonly title: string; readonly reason: string }): ReactNode {
  return <section className="state-panel state-disabled" aria-labelledby="disabled-title"><div><span className="status-tag disabled">DISABLED</span><h2 id="disabled-title">{title}</h2><p>{reason}</p></div></section>;
}

export function ErrorState({ error, retry }: { readonly error: Error; readonly retry: () => void }): ReactNode {
  return <section className="state-panel state-error" role="alert"><div><h2>加载失败</h2><p>{error.message}</p><button type="button" onClick={retry}>重试</button></div></section>;
}
