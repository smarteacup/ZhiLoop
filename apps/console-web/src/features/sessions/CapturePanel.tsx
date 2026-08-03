import { useState } from "react";

import {
  ConsoleApiError,
  type CaptureCommitResult,
  type CapturePreview,
  type ConsoleApi,
} from "../../api/client.js";
import { StatusBadge } from "../../components/StatusBadge.js";

type CaptureState =
  | { readonly status: "idle" }
  | { readonly status: "previewing" }
  | { readonly status: "preview"; readonly preview: CapturePreview }
  | { readonly status: "committing"; readonly preview: CapturePreview }
  | { readonly status: "committed"; readonly preview: CapturePreview; readonly result: CaptureCommitResult }
  | { readonly status: "stale"; readonly message: string }
  | { readonly status: "unavailable"; readonly phase: "preview" | "commit"; readonly title: string; readonly message: string; readonly preview?: CapturePreview }
  | { readonly status: "error"; readonly phase: "preview" | "commit"; readonly message: string; readonly preview?: CapturePreview };

function commitKey(preview: CapturePreview): string {
  return `capture:${preview.previewRevision}:${preview.transcriptIdentityHash.slice(0, 32)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function isStale(error: unknown): boolean {
  return error instanceof ConsoleApiError && (error.code === "STALE_REVISION" || error.code === "CONFLICT");
}

function isUnavailable(error: unknown): boolean {
  return error instanceof ConsoleApiError && (error.code === "SIDECAR_UNAVAILABLE" || error.code === "CAPABILITY_UNAVAILABLE");
}

function unavailableTitle(error: unknown): string {
  return error instanceof ConsoleApiError && error.code === "CAPABILITY_UNAVAILABLE"
    ? "采集能力暂不可用"
    : "Sidecar 暂时不可用";
}

function CommitResult({ result }: { readonly result: CaptureCommitResult }): React.JSX.Element {
  const ledgerMessage = result.appendedEvents > 0
    ? `已向 Ledger 写入 ${result.appendedEvents} 条事件，跳过 ${result.duplicateEvents} 条重复事件。`
    : result.duplicateEvents > 0
      ? `该预览已提交过，${result.duplicateEvents} 条事件均已存在，未重复写入。`
      : "预览中没有需要写入 Ledger 的新事件。";
  return <div className="capture-result" role="status" aria-live="polite">
    <strong>采集提交完成</strong>
    <p>{ledgerMessage}</p>
    <div className="capture-stage">
      <div>
        <span>后续知识编译阶段</span>
        <small>{result.knowledgeCompileStage.reasonCode}</small>
      </div>
      <StatusBadge status={result.knowledgeCompileStage.status} />
    </div>
    {result.knowledgeCompileStage.status === "DISABLED"
      ? <p className="muted">本次仅完成对话事件沉淀到 Ledger；生产知识提炼尚未执行。</p>
      : <p className="muted">知识阶段状态来自 Sidecar 的实际 StageSnapshot，不代表额外的隐式发布。</p>}
  </div>;
}

function PreviewDetails({ preview }: { readonly preview: CapturePreview }): React.JSX.Element {
  const eventTypes = Object.entries(preview.eventTypes).sort(([left], [right]) => left.localeCompare(right));
  return <div className="capture-preview" role="status" aria-live="polite">
    <div className="section-heading"><h3>采集影响预览</h3><span>预览版本 #{preview.previewRevision}</span></div>
    <dl className="detail-grid">
      <div><dt>预计新增</dt><dd>{preview.projectedEvents}</dd></div>
      <div><dt>忽略记录</dt><dd>{preview.ignoredRecords}</dd></div>
      <div><dt>目标游标</dt><dd>{preview.cursor.lineNumber} 行 / {preview.cursor.byteOffset} bytes</dd></div>
      <div><dt>是否还有更多</dt><dd>{preview.hasMore ? "是，提交后需继续补采" : "否"}</dd></div>
    </dl>
    {eventTypes.length === 0 ? <p className="muted">没有识别到可采集事件类型。</p> : <ul className="capture-event-types" aria-label="预览事件类型">
      {eventTypes.map(([eventType, count]) => <li key={eventType}><span>{eventType}</span><strong>{count}</strong></li>)}
    </ul>}
    <p className="muted">预览有效期至 {new Date(preview.expiresAt).toLocaleString()}。正式提交前不会修改 Ledger 或 Codex 会话。</p>
  </div>;
}

export function CapturePanel({
  api,
  sessionId,
  sourceAvailable,
}: {
  readonly api: ConsoleApi;
  readonly sessionId: string;
  readonly sourceAvailable: boolean;
}): React.JSX.Element {
  const [state, setState] = useState<CaptureState>({ status: "idle" });

  const preview = async (): Promise<void> => {
    setState({ status: "previewing" });
    try {
      setState({ status: "preview", preview: await api.previewCapture(sessionId) });
    } catch (error) {
      if (isStale(error)) {
        setState({ status: "stale", message: "会话来源正在变化，未生成可提交预览。请重新预览。" });
      } else {
        setState(isUnavailable(error)
          ? { status: "unavailable", phase: "preview", title: unavailableTitle(error), message: message(error) }
          : { status: "error", phase: "preview", message: message(error) });
      }
    }
  };

  const commit = async (capturePreview: CapturePreview): Promise<void> => {
    if (Date.parse(capturePreview.expiresAt) <= Date.now()) {
      setState({ status: "stale", message: "采集预览已经过期，请重新生成预览。" });
      return;
    }
    setState({ status: "committing", preview: capturePreview });
    try {
      const result = await api.commitCapture({
        sessionId,
        previewRevision: capturePreview.previewRevision,
        transcriptIdentityHash: capturePreview.transcriptIdentityHash,
        idempotencyKey: commitKey(capturePreview),
      });
      setState({ status: "committed", preview: capturePreview, result });
    } catch (error) {
      if (isStale(error)) {
        setState({ status: "stale", message: "预览后会话来源发生变化，旧预览未提交。请重新预览。" });
      } else if (isUnavailable(error)) {
        setState({ status: "unavailable", phase: "commit", title: unavailableTitle(error), message: message(error), preview: capturePreview });
      } else {
        setState({ status: "error", phase: "commit", message: message(error), preview: capturePreview });
      }
    }
  };

  if (!sourceAvailable) {
    return <section className="panel" aria-labelledby="capture-heading">
      <h2 id="capture-heading">主动采集</h2>
      <div className="inline-alert" role="status"><strong>会话来源不可用</strong><p>当前只能查看已投影信息，恢复 Codex 会话来源后才能生成采集预览。</p></div>
      <button type="button" className="primary-button" disabled>生成采集预览</button>
    </section>;
  }

  const activePreview = "preview" in state ? state.preview : undefined;
  const busy = state.status === "previewing" || state.status === "committing";
  return <section className="panel capture-panel" aria-labelledby="capture-heading" aria-busy={busy}>
    <div className="section-heading"><div><h2 id="capture-heading">主动采集</h2><p className="muted">Codex 会话保持只读；只有确认提交后才写入 ZhiLoop Ledger。</p></div><span>preview → commit</span></div>
    {state.status === "idle" ? <p className="muted">先生成无副作用预览，核对新增、忽略和目标游标。</p> : undefined}
    {state.status === "previewing" ? <p role="status" aria-live="polite">正在生成采集预览…</p> : undefined}
    {activePreview !== undefined ? <PreviewDetails preview={activePreview} /> : undefined}
    {state.status === "committed" ? <CommitResult result={state.result} /> : undefined}
    {state.status === "stale" ? <div className="inline-alert warning" role="alert"><strong>预览已失效</strong><p>{state.message}</p></div> : undefined}
    {state.status === "unavailable" ? <div className="inline-alert warning" role="alert"><strong>{state.title}</strong><p>{state.message}。没有写入任何未确认内容。</p></div> : undefined}
    {state.status === "error" ? <div className="inline-alert error" role="alert"><strong>采集操作失败</strong><p>{state.message}</p></div> : undefined}
    <div className="capture-actions">
      {state.status === "idle" || state.status === "stale" || (state.status === "error" && state.phase === "preview") || (state.status === "unavailable" && state.phase === "preview")
        ? <button type="button" className="primary-button" onClick={() => void preview()} disabled={busy}>{state.status === "idle" ? "生成采集预览" : "重新生成预览"}</button>
        : undefined}
      {state.status === "preview"
        ? <><button type="button" className="primary-button" onClick={() => void commit(state.preview)}>确认写入 Ledger</button><button type="button" className="secondary-button" onClick={() => setState({ status: "idle" })}>放弃预览</button></>
        : undefined}
      {state.status === "committing" ? <button type="button" className="primary-button" disabled>正在写入 Ledger…</button> : undefined}
      {(state.status === "error" || state.status === "unavailable") && state.phase === "commit" && activePreview !== undefined
        ? <><button type="button" className="primary-button" onClick={() => void commit(activePreview)}>使用同一幂等键重试</button><button type="button" className="secondary-button" onClick={() => void preview()}>重新生成预览</button></>
        : undefined}
      {state.status === "committed" ? <button type="button" className="secondary-button" onClick={() => void preview()}>再次检查增量</button> : undefined}
    </div>
  </section>;
}
