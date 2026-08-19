import { useCallback, useState } from "react";

import type { ConsoleApi } from "../../api/client.js";
import { useBoundedOperation } from "../../app/useBoundedOperation.js";
import { useInvalidationFeed } from "../p1/live/useInvalidationFeed.js";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState.js";
import { OperationDiagnostic } from "../../components/OperationDiagnostic.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { operationLabel } from "../p2/labels.js";

export function CodeGraphPage({ api }: { readonly api: ConsoleApi }): React.JSX.Element {
  const [preview, setPreview] = useState<Awaited<ReturnType<NonNullable<ConsoleApi["previewCodeGraphInitialization"]>>> | undefined>();
  const [failure, setFailure] = useState<Error | undefined>(); const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal: AbortSignal) => {
    if (api.codeGraphProjects === undefined) throw new Error("CodeGraph 控制能力尚未接通");
    return await api.codeGraphProjects(signal);
  }, [api]);
  const [state, retry] = useBoundedOperation(load, (value) => value.items.some((item) =>
    item.latestJob !== undefined && ["QUEUED", "RUNNING", "RETRY_WAIT"].includes(item.latestJob.status)), { intervalMs: 2_000 });
  const invalidate = useCallback((resources: readonly string[]) => { if (resources.includes("CODEGRAPH")) retry(); }, [retry]);
  useInvalidationFeed(api, invalidate);
  const generate = async (projectId: string): Promise<void> => {
    if (api.previewCodeGraphInitialization === undefined) return; setBusy(true); setFailure(undefined);
    try { setPreview(await api.previewCodeGraphInitialization(projectId)); } catch (error) { setFailure(error instanceof Error ? error : new Error("预览失败")); }
    finally { setBusy(false); }
  };
  const commit = async (): Promise<void> => {
    if (preview === undefined || api.commitCodeGraphInitialization === undefined) return; setBusy(true); setFailure(undefined);
    try {
      await api.commitCodeGraphInitialization({ projectId: preview.projectId, previewId: preview.previewId,
        repositoryIdentity: preview.repositoryIdentity, expectedRevision: preview.expectedRevision,
        idempotencyKey: `codegraph-init:${preview.previewId}` }); setPreview(undefined); retry();
    } catch (error) { setFailure(error instanceof Error ? error : new Error("提交失败")); }
    finally { setBusy(false); }
  };
  const retryJob = async (jobId: string, revision: number): Promise<void> => {
    if (api.retryJob === undefined) return; setBusy(true); setFailure(undefined);
    try { await api.retryJob({ jobId, expectedRevision: revision, idempotencyKey: `codegraph-retry:${jobId}:${revision}` }); retry(); }
    catch (error) { setFailure(error instanceof Error ? error : new Error("重试失败")); } finally { setBusy(false); }
  };
  if (state.status === "loading") return <LoadingState label="正在读取 CodeGraph 能力" /> as React.JSX.Element;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} /> as React.JSX.Element;
  return <div className="page-stack"><header className="page-header"><span className="eyebrow">CODE INTELLIGENCE</span><h1>CodeGraph</h1>
    <p>只查看已观察项目；初始化始终需要预览和明确确认。</p></header>
    {failure === undefined ? null : <OperationDiagnostic value={{ reasonCode: "CODEGRAPH_OPERATION_FAILED", message: failure.message,
      retryable: true, suggestedAction: "刷新项目 revision 后重新生成预览" }} />}
    {state.value.items.length === 0 ? <EmptyState title="尚无已观察项目" detail="ZhiLoop 观察到项目上下文后才允许初始化，不能输入任意路径。" />
      : state.value.items.map((item) => <section className="panel" key={item.projectId}>
        <div className="section-heading"><div><h2>{item.projectId}</h2><p>{item.repositoryRootLabel}</p></div><StatusBadge status={item.status} /></div>
        <dl className="detail-grid"><div><dt>原因</dt><dd title={item.reasonCode}>{operationLabel(item.reasonCode)}</dd></div>
          <div><dt>版本</dt><dd>{item.providerVersion ?? "未检测"}</dd></div><div><dt>索引文件</dt><dd>{item.indexedFiles ?? "—"}</dd></div>
          <div><dt>能力 revision</dt><dd>{item.revision}</dd></div></dl>
        {item.latestJob === undefined ? null : <><p title={item.latestJob.reasonCode}>最近任务：<StatusBadge status={item.latestJob.status} /> · 尝试 {item.latestJob.attempt}/{item.latestJob.maxAttempts}</p>
          {item.latestJob.lastFailure === undefined ? null : <OperationDiagnostic value={{ reasonCode: item.latestJob.lastFailure.code,
            message: "CodeGraph 初始化任务未完成。", retryable: item.latestJob.lastFailure.retryable,
            attempt: item.latestJob.attempt, maxAttempts: item.latestJob.maxAttempts,
            suggestedAction: item.latestJob.lastFailure.retryable ? "检查工具和仓库状态后重试" : "修正输入或环境后重新生成预览" }} />}
          {item.latestJob.status === "FAILED" && item.latestJob.retryable && item.latestJob.revision !== undefined && api.retryJob !== undefined
            ? <button type="button" disabled={busy} onClick={() => void retryJob(item.latestJob!.jobId, item.latestJob!.revision!)}>重试失败任务</button> : null}</>}
        <button type="button" disabled={busy} onClick={() => { void generate(item.projectId); }}>生成初始化预览</button>
      </section>)}
    {preview === undefined ? null : <section className="panel"><h2>初始化影响预览</h2><p>目标：{preview.targetDirectoryLabel}</p>
      <p>有效期至 {new Date(preview.expiresAt).toLocaleString()}</p><ul>{preview.riskCodes.map((code) => <li key={code} title={code}>{operationLabel(code)}</li>)}</ul>
      <button type="button" className="primary" disabled={busy} onClick={() => { void commit(); }}>确认创建 CodeGraph 初始化任务</button></section>}
  </div>;
}
