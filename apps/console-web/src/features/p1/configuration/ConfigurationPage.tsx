import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ConfigurationDraft, ConfigurationState, ConsoleConfiguration } from "@zhiloop/control-api";

import { ConsoleApiError, type ConsoleApi } from "../../../api/client.js";
import { useAsync } from "../../../app/useAsync.js";
import { ErrorState, LoadingState } from "../../../components/AsyncState.js";
import { StatusBadge } from "../../../components/StatusBadge.js";
import type { CapabilityGate, RevisionActionGate } from "../actionGuard.js";
import { useInvalidationFeed } from "../live/useInvalidationFeed.js";
import {
  ConfigurationWorkspace,
  type ConfigurationCommandPort,
  type ConfigurationDiagnosticViewModel,
  type ConfigurationDiffViewModel,
  type ConfigurationFieldViewModel,
  type ConfigurationHistoryViewModel,
  type ConfigurationValue,
  type ConfigurationWorkspaceViewModel,
} from "./ConfigurationWorkspace.js";

const CONFIGURATION_SERVICE_READY: CapabilityGate = Object.freeze({
  status: "READY",
  reasonCode: "CONFIGURATION_SERVICE_RESPONDED",
  observedAt: "1970-01-01T00:00:00.000Z",
});
const CONFIGURATION_NOT_CONFIGURED: CapabilityGate = Object.freeze({
  status: "NOT_CONFIGURED",
  reasonCode: "CONFIGURATION_COMMAND_NOT_CONFIGURED",
  observedAt: "1970-01-01T00:00:00.000Z",
});

function latestDraft(state: ConfigurationState): ConfigurationDraft | undefined {
  return [...state.drafts].sort((left, right) => right.draftRevision - left.draftRevision)[0];
}

function primitiveFields(value: unknown, prefix = ""): Array<{ readonly path: string; readonly value: ConfigurationValue }> {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return prefix.endsWith("schemaVersion") ? [] : [{ path: prefix, value }];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([key, child]) => primitiveFields(child, prefix.length === 0 ? key : `${prefix}.${key}`));
}

function valueAt(value: unknown, path: string): ConfigurationValue | undefined {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return typeof current === "string" || typeof current === "number" || typeof current === "boolean" ? current : undefined;
}

function replaceAt(configuration: ConsoleConfiguration, path: string, replacement: ConfigurationValue): ConsoleConfiguration {
  const root = structuredClone(configuration) as unknown as Record<string, unknown>;
  const segments = path.split(".");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      current[segment] = replacement;
      break;
    }
    const child = current[segment];
    if (child === null || typeof child !== "object" || Array.isArray(child)) throw new Error("configuration field path is invalid");
    current = child as Record<string, unknown>;
  }
  return root as unknown as ConsoleConfiguration;
}

function componentFor(path: string): string {
  if (path.startsWith("runtime.alerts.")) return "observability";
  if (path.startsWith("runtime.")) return "p1-runtime";
  return "future-consumer";
}

function actionGate(capability: CapabilityGate, expectedRevision: number, allowed: boolean, key: string, blockedReason?: string): RevisionActionGate {
  return {
    capability,
    allowed,
    expectedRevision,
    currentRevision: expectedRevision,
    idempotencyKey: key,
    ...(blockedReason === undefined ? {} : { blockedReason }),
  };
}

export function configurationViewModel(state: ConfigurationState, api: ConsoleApi): ConfigurationWorkspaceViewModel {
  const draft = latestDraft(state);
  const draftConfiguration = draft?.configuration ?? state.view.effective;
  const draftRevision = draft?.draftRevision ?? state.view.revision;
  const validationCapability = api.validateConfiguration === undefined ? CONFIGURATION_NOT_CONFIGURED : CONFIGURATION_SERVICE_READY;
  const activationCapability = api.activateConfiguration === undefined ? CONFIGURATION_NOT_CONFIGURED : CONFIGURATION_SERVICE_READY;
  const rollbackCapability = api.rollbackConfiguration === undefined ? CONFIGURATION_NOT_CONFIGURED : CONFIGURATION_SERVICE_READY;
  const fields: ConfigurationFieldViewModel[] = primitiveFields(state.view.effective).map(({ path, value }) => ({
    path,
    label: path,
    kind: typeof value as "string" | "number" | "boolean",
    effectiveValue: value,
    draftValue: valueAt(draftConfiguration, path) ?? value,
    source: state.view.sources[path] ?? "DEFAULT",
    sourceDetail: state.view.sources[path] === undefined ? "来源未单独上报，使用 DEFAULT" : `来源 ${state.view.sources[path]}`,
    restartImpact: draft?.requiresRestart === true && draft.changedPaths.includes(path) ? "RESTART_REQUIRED" : "NONE",
    edit: actionGate(validationCapability, draftRevision, true, `config-draft-${draftRevision}-${path.replaceAll(".", "-")}`),
  }));
  const diagnostics: ConfigurationDiagnosticViewModel[] = (draft?.diagnostics ?? []).map((item) => ({
    ...(item.path === undefined ? {} : { path: item.path }),
    severity: "ERROR",
    code: item.code,
    message: item.retryable ? "服务端诊断，可修正后重试" : "服务端诊断，需先解决后才能激活",
  }));
  const diff: ConfigurationDiffViewModel[] = (draft?.changedPaths ?? []).flatMap((path) => {
    const before = valueAt(state.view.effective, path);
    const after = valueAt(draftConfiguration, path);
    if (before === undefined || after === undefined) return [];
    return [{ path, before, after, affectedComponents: [componentFor(path)], restartImpact: draft?.requiresRestart === true ? "RESTART_REQUIRED" : "NONE" }];
  });
  const validationStatus: ConfigurationWorkspaceViewModel["validationStatus"] = draft === undefined
    ? "NOT_VERIFIED"
    : draft.activatable
      ? "READY"
      : draft.diagnostics.length > 0 ? "FAILED" : "NOT_VERIFIED";
  const validationReasonCode = draft === undefined
    ? "VALIDATED_DRAFT_NOT_AVAILABLE"
    : draft.activatable ? "CONFIGURATION_DRAFT_VALIDATED" : draft.diagnostics[0]?.code ?? "CONFIGURATION_DRAFT_NOT_ACTIVATABLE";
  const history: ConfigurationHistoryViewModel[] = state.history.map((item) => ({
    revision: item.revision,
    hash: item.hash,
    activatedAt: item.createdAt,
    result: item.status === "REJECTED" ? "FAILED" : item.status === "ROLLED_BACK" ? "ROLLED_BACK" : "ACTIVE",
    changedPaths: item.changedPaths,
    rollback: actionGate(
      rollbackCapability,
      state.view.revision,
      item.status !== "REJECTED" && item.revision !== state.view.revision,
      `config-rollback-${state.view.revision}-${item.revision}`,
      item.status === "REJECTED" ? "REJECTED revision 不能作为回滚目标" : "该 revision 已是当前 effective",
    ),
  }));
  return {
    effectiveRevision: state.view.revision,
    effectiveHash: state.view.hash,
    draftRevision,
    basedOnRevision: draft?.baseRevision ?? state.view.revision,
    fields,
    validationStatus,
    validationReasonCode,
    diagnostics,
    diff,
    affectedComponents: [...new Set(diff.flatMap((item) => item.affectedComponents))],
    activate: actionGate(
      activationCapability,
      state.view.revision,
      draft?.activatable === true,
      `config-activate-${state.view.revision}-${draftRevision}`,
      draft === undefined ? "没有已验证草稿" : "草稿未通过 capability-aware 校验",
    ),
    history,
  };
}

function mutationError(code: string, retryable: boolean): ConsoleApiError {
  return new ConsoleApiError(code === "STALE_REVISION" ? "STALE_REVISION" : code === "CONFLICT" ? "CONFLICT" : "INVALID_REQUEST", code, retryable);
}

export function ConfigurationPage({ api }: { readonly api: ConsoleApi }): React.JSX.Element {
  const load = useCallback(async (signal: AbortSignal) => {
    if (api.configuration === undefined) throw new ConsoleApiError("CAPABILITY_UNAVAILABLE", "配置查询能力未接通", false);
    return await api.configuration(undefined, signal);
  }, [api]);
  const [state, retry] = useAsync(load);
  const commandAbort = useRef(new AbortController());
  useEffect(() => () => commandAbort.current.abort(), []);
  const invalidate = useCallback((resources: readonly string[]) => {
    if (resources.includes("CONFIGURATION")) retry();
  }, [retry]);
  const feed = useInvalidationFeed(api, invalidate);
  const viewModel = useMemo(() => state.status === "success" ? configurationViewModel(state.value, api) : undefined, [api, state]);

  if (state.status === "loading") return <LoadingState label="正在读取有效配置、草稿与历史" />;
  if (state.status === "error") return <ErrorState error={state.error} retry={retry} />;
  const latest = latestDraft(state.value);
  const commands: ConfigurationCommandPort = {
    changeDraft: async (request) => {
      if (api.validateConfiguration === undefined) throw new ConsoleApiError("CAPABILITY_UNAVAILABLE", "配置草稿能力未接通", false);
      const expected = latest?.draftRevision ?? state.value.view.revision;
      if (request.expectedDraftRevision !== expected) throw new ConsoleApiError("STALE_REVISION", "草稿 revision 已变化", false);
      const configuration = replaceAt(latest?.configuration ?? state.value.view.effective, request.path, request.value);
      const projectId = latest?.projectId ?? state.value.view.projectId;
      const result = await api.validateConfiguration({
        baseRevision: latest?.baseRevision ?? state.value.view.revision,
        scope: latest?.scope ?? (state.value.view.projectId === undefined ? "GLOBAL" : "PROJECT"),
        ...(projectId === undefined ? {} : { projectId }),
        draft: configuration as unknown as Readonly<Record<string, unknown>>,
      }, commandAbort.current.signal);
      if (!result.ok) throw mutationError(result.diagnostics[0]?.code ?? "INVALID_CONFIGURATION", result.diagnostics.some((item) => item.retryable));
      retry();
    },
    activate: async (request) => {
      if (api.activateConfiguration === undefined) throw new ConsoleApiError("CAPABILITY_UNAVAILABLE", "配置激活能力未接通", false);
      const result = await api.activateConfiguration({ expectedRevision: request.expectedEffectiveRevision, draftRevision: request.draftRevision, idempotencyKey: request.idempotencyKey }, commandAbort.current.signal);
      if (!result.ok) throw mutationError(result.diagnostic.code, result.diagnostic.retryable);
      retry();
    },
    rollback: async (request) => {
      if (api.rollbackConfiguration === undefined) throw new ConsoleApiError("CAPABILITY_UNAVAILABLE", "配置回滚能力未接通", false);
      const result = await api.rollbackConfiguration({ expectedRevision: request.expectedEffectiveRevision, targetRevision: request.targetRevision, idempotencyKey: request.idempotencyKey }, commandAbort.current.signal);
      if (!result.ok) throw mutationError(result.diagnostic.code, result.diagnostic.retryable);
      retry();
    },
  };
  return <div className="page-stack">
    <div className="section-heading"><p>实时配置失效 revision {feed.revision}</p><StatusBadge status={feed.connection} /></div>
    <ConfigurationWorkspace viewModel={viewModel as ConfigurationWorkspaceViewModel} commands={commands} />
  </div>;
}
