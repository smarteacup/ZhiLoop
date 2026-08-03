import { useEffect, useState } from "react";

import { StatusBadge } from "../../../components/StatusBadge.js";
import { decideRevisionAction, type RevisionActionGate } from "../actionGuard.js";

export type ConfigurationValue = string | number | boolean;

export interface ConfigurationFieldViewModel {
  readonly path: string;
  readonly label: string;
  readonly kind: "string" | "number" | "boolean";
  readonly effectiveValue: ConfigurationValue;
  readonly draftValue: ConfigurationValue;
  readonly source: "DEFAULT" | "FILE" | "ENV" | "GLOBAL" | "PROJECT_OVERRIDE" | "RUNTIME_OVERRIDE";
  readonly sourceDetail: string;
  readonly restartImpact: "NONE" | "RESTART_REQUIRED";
  readonly edit: RevisionActionGate;
}

export interface ConfigurationDiagnosticViewModel {
  readonly path?: string;
  readonly severity: "INFO" | "WARNING" | "ERROR";
  readonly code: string;
  readonly message: string;
}

export interface ConfigurationDiffViewModel {
  readonly path: string;
  readonly before: ConfigurationValue;
  readonly after: ConfigurationValue;
  readonly affectedComponents: readonly string[];
  readonly restartImpact: "NONE" | "RESTART_REQUIRED";
}

export interface ConfigurationHistoryViewModel {
  readonly revision: number;
  readonly hash: string;
  readonly activatedAt: string;
  readonly operator?: string;
  readonly result: "ACTIVE" | "ROLLED_BACK" | "FAILED";
  readonly changedPaths: readonly string[];
  readonly rollback: RevisionActionGate;
}

export interface ConfigurationWorkspaceViewModel {
  readonly effectiveRevision: number;
  readonly effectiveHash: string;
  readonly draftRevision: number;
  readonly basedOnRevision: number;
  readonly fields: readonly ConfigurationFieldViewModel[];
  readonly validationStatus: "READY" | "DEGRADED" | "FAILED" | "NOT_VERIFIED";
  readonly validationReasonCode: string;
  readonly diagnostics: readonly ConfigurationDiagnosticViewModel[];
  readonly diff: readonly ConfigurationDiffViewModel[];
  readonly affectedComponents: readonly string[];
  readonly activate: RevisionActionGate;
  readonly history: readonly ConfigurationHistoryViewModel[];
}

export interface ConfigurationCommandPort {
  changeDraft(request: { readonly path: string; readonly value: ConfigurationValue; readonly expectedDraftRevision: number; readonly idempotencyKey: string }): Promise<void>;
  activate(request: { readonly draftRevision: number; readonly expectedEffectiveRevision: number; readonly idempotencyKey: string }): Promise<void>;
  rollback(request: { readonly targetRevision: number; readonly expectedEffectiveRevision: number; readonly idempotencyKey: string }): Promise<void>;
}

export function ConfigurationWorkspace({ viewModel, commands }: { readonly viewModel: ConfigurationWorkspaceViewModel; readonly commands?: ConfigurationCommandPort }): React.JSX.Element {
  const [pending, setPending] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [draftValues, setDraftValues] = useState<Readonly<Record<string, ConfigurationValue>>>(() => Object.fromEntries(viewModel.fields.map((field) => [field.path, field.draftValue])));
  useEffect(() => {
    setDraftValues(Object.fromEntries(viewModel.fields.map((field) => [field.path, field.draftValue])));
  }, [viewModel.draftRevision, viewModel.fields]);
  const guardedActivate = decideRevisionAction(viewModel.activate, commands !== undefined);
  const hasValidationError = viewModel.diagnostics.some((item) => item.severity === "ERROR");
  const staleDraftBase = viewModel.basedOnRevision !== viewModel.effectiveRevision;
  const activate = viewModel.validationStatus !== "READY"
    ? { enabled: false, reason: viewModel.validationReasonCode }
    : hasValidationError
    ? { enabled: false, reason: "草稿包含 ERROR 诊断" }
    : staleDraftBase
      ? { enabled: false, reason: "草稿基线已过期，请刷新 diff" }
      : guardedActivate;

  const changeDraft = async (field: ConfigurationFieldViewModel, value: ConfigurationValue): Promise<void> => {
    const gate = decideRevisionAction(field.edit, commands !== undefined);
    if (!gate.enabled || commands === undefined || pending !== undefined) return;
    setPending(`field:${field.path}`);
    setMessage(undefined);
    try {
      await commands.changeDraft({ path: field.path, value, expectedDraftRevision: field.edit.expectedRevision, idempotencyKey: field.edit.idempotencyKey });
      setMessage(`草稿字段 ${field.label} 已提交，等待 revision 刷新。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "草稿更新失败");
    } finally {
      setPending(undefined);
    }
  };

  const activateDraft = async (): Promise<void> => {
    if (!activate.enabled || commands === undefined || pending !== undefined) return;
    setPending("activate");
    setMessage(undefined);
    try {
      await commands.activate({ draftRevision: viewModel.draftRevision, expectedEffectiveRevision: viewModel.activate.expectedRevision, idempotencyKey: viewModel.activate.idempotencyKey });
      setMessage("激活请求已提交；最终状态以新的 effective revision 为准。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "激活失败，继续使用 last-known-good 配置");
    } finally {
      setPending(undefined);
    }
  };

  const rollback = async (history: ConfigurationHistoryViewModel): Promise<void> => {
    const decision = decideRevisionAction(history.rollback, commands !== undefined);
    if (!decision.enabled || commands === undefined || pending !== undefined) return;
    setPending(`rollback:${history.revision}`);
    setMessage(undefined);
    try {
      await commands.rollback({ targetRevision: history.revision, expectedEffectiveRevision: history.rollback.expectedRevision, idempotencyKey: history.rollback.idempotencyKey });
      setMessage(`已提交回滚到 revision ${history.revision} 的请求；系统将创建新 revision。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "回滚失败，当前 effective revision 未改变");
    } finally {
      setPending(undefined);
    }
  };

  return <div className="page-stack">
    <header className="page-header"><div><p className="eyebrow">CONFIGURATION</p><h1>有效配置与草稿</h1><p>effective #{viewModel.effectiveRevision} · draft #{viewModel.draftRevision} 基于 #{viewModel.basedOnRevision}</p></div><code>{viewModel.effectiveHash}</code></header>
    <section className="panel" aria-labelledby="configuration-fields-heading"><h2 id="configuration-fields-heading">字段来源与草稿</h2>
      <div className="detail-grid">{viewModel.fields.map((field) => {
        const edit = decideRevisionAction(field.edit, commands !== undefined);
        const busy = pending === `field:${field.path}`;
        const draftValue = draftValues[field.path] ?? field.draftValue;
        return <div key={field.path}><dt>{field.label}</dt><dd>
          <p>Effective: <strong>{String(field.effectiveValue)}</strong> <span className="status-tag neutral">{field.source}</span></p>
          <small>{field.path} · {field.sourceDetail} · {field.restartImpact}</small>
          {field.kind === "boolean"
            ? <label><input type="checkbox" aria-label={`${field.label} Draft`} checked={Boolean(draftValue)} disabled={!edit.enabled || pending !== undefined} onChange={(event) => {
              const value = event.currentTarget.checked;
              setDraftValues((current) => ({ ...current, [field.path]: value }));
            }} /> Draft</label>
            : <label>Draft <input type={field.kind === "number" ? "number" : "text"} aria-label={`${field.label} Draft`} value={field.kind === "number" ? Number(draftValue) : String(draftValue)} disabled={!edit.enabled || pending !== undefined} onChange={(event) => {
              const raw = event.currentTarget.value;
              const value = field.kind === "number" ? Number(raw) : raw;
              setDraftValues((current) => ({ ...current, [field.path]: value }));
            }} /></label>}
          <button type="button" className="secondary-button" aria-label={`保存 ${field.label} 草稿字段`} disabled={!edit.enabled || pending !== undefined || Object.is(draftValue, field.draftValue)} title={edit.reason} onClick={() => void changeDraft(field, draftValue)}>{busy ? "正在保存…" : "保存草稿字段"}</button>
          {!edit.enabled ? <span className="muted">不可编辑：{edit.reason}</span> : busy ? <span role="status">正在保存…</span> : undefined}
        </dd></div>;
      })}</div>
    </section>
    <section className="panel" aria-labelledby="validation-heading"><div className="section-heading"><h2 id="validation-heading">校验与影响 Diff</h2><div><StatusBadge status={viewModel.validationStatus} /><small>{viewModel.validationReasonCode}</small></div></div>
      {viewModel.diagnostics.length === 0 ? <p className="muted">服务端校验未返回诊断。</p> : <ul aria-label="配置校验诊断">{viewModel.diagnostics.map((item, index) => <li key={`${item.code}-${index}`}><strong>{item.severity}</strong> {item.path ?? "全局"}: {item.code} — {item.message}</li>)}</ul>}
      {viewModel.diff.length === 0 ? <p className="muted">草稿与 effective 配置一致。</p> : <table><caption>待激活字段影响</caption><thead><tr><th>字段</th><th>原值</th><th>新值</th><th>影响组件</th><th>重启</th></tr></thead><tbody>{viewModel.diff.map((item) => <tr key={item.path}><td>{item.path}</td><td>{String(item.before)}</td><td>{String(item.after)}</td><td>{item.affectedComponents.join(", ")}</td><td>{item.restartImpact}</td></tr>)}</tbody></table>}
      <p>受影响组件：{viewModel.affectedComponents.length === 0 ? "无" : viewModel.affectedComponents.join(", ")}</p>
      <button type="button" className="primary-button" disabled={!activate.enabled || pending !== undefined} title={activate.reason} onClick={() => void activateDraft()}>{pending === "activate" ? "正在激活…" : "校验并原子激活"}</button>
      {!activate.enabled ? <p className="muted">激活不可用：{activate.reason}</p> : undefined}
    </section>
    <section className="panel" aria-labelledby="configuration-history-heading"><h2 id="configuration-history-heading">不可变历史</h2>
      <ol>{viewModel.history.map((item) => {
        const decision = decideRevisionAction(item.rollback, commands !== undefined);
        return <li key={item.revision}><div><strong>revision {item.revision}</strong> <StatusBadge status={item.result} /> <code>{item.hash}</code></div><p>{new Date(item.activatedAt).toLocaleString()} · {item.operator ?? "operator 未由 API 提供"} · {item.changedPaths.join(", ") || "无字段"}</p><button type="button" className="secondary-button" aria-label={`回滚到 revision ${item.revision}`} disabled={!decision.enabled || pending !== undefined} title={decision.reason} onClick={() => void rollback(item)}>{pending === `rollback:${item.revision}` ? "正在回滚…" : "以此版本创建回滚 revision"}</button>{!decision.enabled ? <small>回滚不可用：{decision.reason}</small> : undefined}</li>;
      })}</ol>
    </section>
    {message === undefined ? undefined : <p role="status" aria-live="polite">{message}</p>}
  </div>;
}
