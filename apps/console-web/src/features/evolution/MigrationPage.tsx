import { useCallback, useEffect, useState } from "react";

import type { LegacyMigrationPreviewView } from "@zhiloop/control-api";
import type { ConsoleApi } from "../../api/client.js";
import { useAsync } from "../../app/useAsync.js";
import { useBoundedOperation } from "../../app/useBoundedOperation.js";
import { useInvalidationFeed } from "../p1/live/useInvalidationFeed.js";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { operationLabel } from "../p2/labels.js";

export function MigrationPage({ api }: { readonly api: ConsoleApi }): React.JSX.Element {
  const [projectId, setProjectId] = useState(""); const [selected, setSelected] = useState<LegacyMigrationPreviewView | undefined>();
  const [items, setItems] = useState<Awaited<ReturnType<NonNullable<ConsoleApi["legacyMigrationItems"]>>> | undefined>();
  const [failure, setFailure] = useState<Error | undefined>(); const [busy, setBusy] = useState(false);
  const [rollbackPreview, setRollbackPreview] = useState(false);
  const loadProjects = useCallback(async (signal: AbortSignal) => api.codeGraphProjects?.(signal) ?? { revision: 0, items: [], bounded: false, observedAt: new Date().toISOString() }, [api]);
  const [projects, retryProjects] = useAsync(loadProjects);
  const loadProgress = useCallback(async (signal: AbortSignal) => selected === undefined || api.legacyMigration === undefined
    ? selected : await api.legacyMigration(selected.migrationId, signal), [api, selected]);
  const [progress, refreshProgress] = useBoundedOperation(loadProgress,
    (value) => value !== undefined && ["COMMITTING", "ROLLING_BACK"].includes(value.status), { intervalMs: 2_000 });
  const invalidate = useCallback((resources: readonly string[]) => {
    if (resources.includes("MIGRATIONS")) { retryProjects(); refreshProgress(); }
  }, [refreshProgress, retryProjects]);
  useInvalidationFeed(api, invalidate);
  useEffect(() => { if (progress.status === "success" && progress.value !== undefined
    && (selected === undefined || progress.value.revision !== selected.revision || progress.value.status !== selected.status)) setSelected(progress.value); }, [progress, selected]);
  const preview = async (): Promise<void> => {
    if (api.previewLegacyMigration === undefined || projectId.trim().length === 0) return; setBusy(true); setFailure(undefined);
    try { const value = await api.previewLegacyMigration(projectId.trim()); setSelected(value); setItems(await api.legacyMigrationItems?.(value.migrationId)); }
    catch (error) { setFailure(error instanceof Error ? error : new Error("迁移预览失败")); } finally { setBusy(false); }
  };
  const command = async (kind: "commit" | "rollback"): Promise<void> => {
    if (selected === undefined) return; setBusy(true); setFailure(undefined);
    try {
      const key = `${kind}:${selected.migrationId}:${selected.revision}`;
      const value = kind === "commit" ? (await api.commitLegacyMigration?.({ migrationId: selected.migrationId,
        expectedRevision: selected.revision, idempotencyKey: key }))?.preview
        : await api.rollbackLegacyMigration?.({ migrationId: selected.migrationId, expectedRevision: selected.revision, idempotencyKey: key });
      if (value !== undefined) { setSelected(value); setRollbackPreview(false); setItems(await api.legacyMigrationItems?.(value.migrationId)); refreshProgress(); }
    } catch (error) { setFailure(error instanceof Error ? error : new Error("迁移操作失败")); } finally { setBusy(false); }
  };
  const nextItems = async (): Promise<void> => {
    if (selected === undefined || items?.nextOrdinal === undefined || api.legacyMigrationItems === undefined) return;
    setBusy(true); setFailure(undefined);
    try { setItems(await api.legacyMigrationItems(selected.migrationId, items.nextOrdinal)); }
    catch (error) { setFailure(error instanceof Error ? error : new Error("迁移明细加载失败")); }
    finally { setBusy(false); }
  };
  if (projects.status === "loading") return <LoadingState label="正在加载已观察项目" /> as React.JSX.Element;
  if (projects.status === "error") return <ErrorState error={projects.error} retry={retryProjects} /> as React.JSX.Element;
  return <div className="page-stack"><header className="page-header"><span className="eyebrow">MIGRATION</span><h1>历史知识迁移</h1>
    <p>dry-run 不写入任何 Recipe 或 Freshness；只有确认提交后才启动持久化迁移任务。</p></header>
    <section className="panel"><label>项目<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
      <option value="">请选择已观察项目</option>{projects.value.items.map((item) => <option key={item.projectId} value={item.projectId}>{item.projectId}</option>)}</select></label>
      <button type="button" disabled={busy || projectId.length === 0} onClick={() => { void preview(); }}>生成迁移预览</button></section>
    {failure === undefined ? null : <section className="state-panel state-error" role="alert"><h2>迁移操作失败</h2><p>{failure.message}</p></section>}
    {selected === undefined ? <EmptyState title="尚未生成迁移预览" detail="选择项目后可查看可迁移、已是当前结构和跳过项。" /> : <section className="panel">
      <div className="section-heading"><h2>{selected.migrationId}</h2><StatusBadge status={selected.status} /></div>
      <div className="metric-grid"><article className="metric-card"><span>扫描</span><strong>{selected.scannedCount}</strong></article>
        <article className="metric-card"><span>可迁移</span><strong>{selected.migratableCount}</strong></article>
        <article className="metric-card"><span>跳过</span><strong>{selected.skippedCount}</strong></article>
        <article className="metric-card"><span>失败</span><strong>{selected.failedCount}</strong></article></div>
      <p>Registry revision {selected.sourceRegistryRevision} · 预览 revision {selected.revision}</p>
      {selected.failureCode === undefined ? null : <p title={selected.failureCode}>失败原因：{operationLabel(selected.failureCode)}</p>}
      {selected.status === "READY" ? <button type="button" className="primary" disabled={busy} onClick={() => { void command("commit"); }}>确认迁移</button> : null}
      {["COMPLETED", "ROLLBACK_CONFLICT"].includes(selected.status) && !rollbackPreview ? <button type="button" disabled={busy} onClick={() => setRollbackPreview(true)}>生成回滚预览</button> : null}
      {!rollbackPreview ? null : <div className="inline-alert warning"><strong>回滚影响预览</strong><p>将仅回滚迁移 {selected.migrationId} 拥有且未被后续修改的 Recipe/Freshness 投影；冲突项保持不变并显式记录。</p>
        <button type="button" disabled={busy} onClick={() => { void command("rollback"); }}>确认安全回滚</button></div>}
    </section>}
    {items === undefined || items.items.length === 0 ? null : <section className="panel"><h2>迁移项目明细</h2><div className="table-wrap"><table><thead><tr><th>知识</th><th>分类</th><th>状态</th><th>原因</th></tr></thead>
      <tbody>{items.items.map((item) => <tr key={`${item.migrationId}:${item.ordinal}`}><td>{item.assetId}@{item.assetVersion}</td>
        <td title={item.classification}>{operationLabel(item.classification)}</td><td><StatusBadge status={item.status} /></td>
        <td>{item.reasonCodes.map((code) => <span key={code} title={code}>{operationLabel(code)} </span>)}</td></tr>)}</tbody></table></div>
      {items.nextOrdinal === undefined ? null : <><p>结果已按安全上限分页，下一游标：{items.nextOrdinal}</p>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { void nextItems(); }}>查看下一页明细</button></>}</section>}
  </div>;
}
