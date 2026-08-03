import { useCallback, useEffect, useState } from "react";

import type { HighRiskKind, HighRiskPreviewView, P4ConsoleApi } from "../../api/p4.js";
import { useAsync } from "../../app/useAsync.js";
import { ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";

const KINDS: readonly HighRiskKind[] = ["GLOBAL_PROMOTION", "RULE_CHANGE", "BINDING_CHANGE", "PRIVACY_PURGE"];

export function HighRiskGovernancePanel({ api }: { readonly api: Pick<P4ConsoleApi, "highRiskGovernance" | "previewHighRisk" | "commitHighRisk"> }): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => await api.highRiskGovernance(signal), [api]);
  const [state, retry] = useAsync(load);
  const [kind, setKind] = useState<HighRiskKind>("GLOBAL_PROMOTION");
  const [assets, setAssets] = useState("");
  const [projects, setProjects] = useState("");
  const [reason, setReason] = useState("");
  const [payloadFingerprint, setPayloadFingerprint] = useState("");
  const [preview, setPreview] = useState<HighRiskPreviewView>();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState<"preview" | "commit">();
  const [message, setMessage] = useState<string>();
  useEffect(() => { setPreview(undefined); setConfirmation(""); setMessage(undefined); }, [kind, assets, projects, reason, payloadFingerprint]);
  if (state.status === "loading") return <LoadingState label="正在读取高风险治理门禁" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const gate = state.value.actions[kind];
  const commandValid = splitIds(assets).length > 0 && reason.trim().length >= 4 && /^sha256:[a-f0-9]{64}$/u.test(payloadFingerprint.trim());
  const canPreview = gate.enabled && gate.capabilityStatus === "READY" && gate.expectedRevision === state.value.policyRevision && gate.idempotencyKey !== undefined && state.value.activeStageEnabled && commandValid && pending === undefined;
  const previewFresh = preview !== undefined && preview.kind === kind && preview.policyRevision === state.value.policyRevision && preview.actor === state.value.actor && Date.parse(preview.expiresAt) >= Date.now();
  const canCommit = canPreview && previewFresh && confirmation === preview?.confirmationPhrase;
  const createPreview = async (): Promise<void> => {
    if (!canPreview) return;
    setPending("preview"); setMessage(undefined);
    try { setPreview(await api.previewHighRisk({ kind, assetIds: splitIds(assets), projectIds: splitIds(projects), reason: reason.trim(), payloadFingerprint: payloadFingerprint.trim() })); }
    catch (error) { setMessage(error instanceof Error ? `预览失败：${error.message}` : "预览失败"); }
    finally { setPending(undefined); }
  };
  const commit = async (): Promise<void> => {
    if (!canCommit || preview === undefined) return;
    setPending("commit"); setMessage(undefined);
    try { const receipt = await api.commitHighRisk({ previewId: preview.previewId, expectedPolicyRevision: preview.policyRevision, confirmationPhrase: confirmation }); setMessage(`已提交 ${receipt.kind}：${receipt.operationId} · ${receipt.committedAt}`); setPreview(undefined); setConfirmation(""); }
    catch (error) { setMessage(error instanceof Error ? `提交失败：${error.message}` : "提交失败"); }
    finally { setPending(undefined); }
  };
  return <section className="panel" aria-labelledby="high-risk-heading"><div className="section-heading"><div><h2 id="high-risk-heading">高风险治理</h2><span>GLOBAL / RULE / Binding / privacy 必须预览 blast radius 并绑定操作者确认</span></div><StatusBadge status={gate.capabilityStatus} /></div>
    {!canPreview ? <div className="inline-alert warning"><strong>默认禁用：{gate.reasonCode}</strong><p>需要 ACTIVE stage、READY capability、匹配 policy revision、服务端幂等身份和完整命令。</p></div> : undefined}
    <div className="edit-grid"><label>操作<select value={kind} onChange={(event) => setKind(event.currentTarget.value as HighRiskKind)}>{KINDS.map((item) => <option key={item}>{item}</option>)}</select></label><label>Asset IDs（逗号分隔）<input value={assets} onChange={(event) => setAssets(event.currentTarget.value)} /></label><label>Project IDs（逗号分隔）<input value={projects} onChange={(event) => setProjects(event.currentTarget.value)} /></label><label>原因<input value={reason} onChange={(event) => setReason(event.currentTarget.value)} /></label><label>Payload fingerprint<input value={payloadFingerprint} onChange={(event) => setPayloadFingerprint(event.currentTarget.value)} /></label></div>
    <button type="button" className="secondary-button" disabled={!canPreview} onClick={() => void createPreview()}>{pending === "preview" ? "计算中…" : "服务端预览影响范围"}</button>
    {preview === undefined ? undefined : <div className={`impact-preview ${preview.blastRadius.irreversible ? "warning" : ""}`}><div className="section-heading"><h3>Blast radius</h3><StatusBadge status={preview.blastRadius.irreversible ? "IRREVERSIBLE" : "REVERSIBLE"} /></div><dl className="detail-grid"><div><dt>知识</dt><dd>{preview.blastRadius.affectedAssets}</dd></div><div><dt>项目</dt><dd>{preview.blastRadius.affectedProjects}</dd></div><div><dt>规则 / Binding</dt><dd>{preview.blastRadius.affectedRules} / {preview.blastRadius.affectedBindings}</dd></div><div><dt>Trace / Injection</dt><dd>{preview.blastRadius.affectedTraces} / {preview.blastRadius.affectedInjections}</dd></div></dl><p>{preview.blastRadius.reasonCodes.join(", ")}</p><p>操作者：<strong>{preview.actor}</strong> · 到期：{new Date(preview.expiresAt).toLocaleString()}</p><label>输入确认短语 <code>{preview.confirmationPhrase}</code><input aria-label="高风险确认短语" value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} autoComplete="off" /></label><button type="button" className="danger-button" disabled={!canCommit} onClick={() => void commit()}>{pending === "commit" ? "提交中…" : "确认执行高风险操作"}</button></div>}
    {message === undefined ? undefined : <p className="inline-alert" role="status" aria-live="polite">{message}</p>}
  </section>;
}

function splitIds(value: string): readonly string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 1_000);
}
