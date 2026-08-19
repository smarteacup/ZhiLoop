import { operationLabel } from "../features/p2/labels.js";

export interface OperationDiagnosticValue {
  readonly reasonCode: string;
  readonly message?: string | undefined;
  readonly retryable?: boolean | undefined;
  readonly attempt?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly nextAttemptAt?: string | undefined;
  readonly suggestedAction?: string | undefined;
}

export function OperationDiagnostic({ value }: { readonly value: OperationDiagnosticValue }): React.JSX.Element {
  return <div className="diagnostic-card" title={value.reasonCode}>
    <strong>{operationLabel(value.reasonCode)}</strong>
    {value.message === undefined ? null : <p>{value.message}</p>}
    <dl className="detail-grid">
      <div><dt>诊断代码</dt><dd><code>{value.reasonCode}</code></dd></div>
      <div><dt>是否可重试</dt><dd>{value.retryable === true ? "是" : "否"}</dd></div>
      {value.attempt === undefined ? null : <div><dt>执行次数</dt><dd>{value.attempt} / {value.maxAttempts ?? "—"}</dd></div>}
      {value.nextAttemptAt === undefined ? null : <div><dt>下次重试</dt><dd>{new Date(value.nextAttemptAt).toLocaleString()}</dd></div>}
    </dl>
    {value.suggestedAction === undefined ? null : <p><strong>建议：</strong>{value.suggestedAction}</p>}
  </div>;
}
