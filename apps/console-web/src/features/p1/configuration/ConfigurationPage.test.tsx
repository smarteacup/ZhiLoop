// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ConfigurationState, ConsoleConfiguration } from "@zhiloop/control-api";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApi } from "../../../api/client.js";
import { ConfigurationPage, configurationViewModel } from "./ConfigurationPage.js";

const timestamp = "2026-08-03T12:00:00.000Z";

function configuration(): ConsoleConfiguration {
  return {
    schemaVersion: 1,
    runtime: {
      sessionScanIntervalMs: 60_000,
      followDebounceMs: 1_000,
      workerPollIntervalMs: 1_000,
      extractionDelayMs: 300_000,
      workerConcurrency: 2,
      scanBatchSize: 100,
      captureBatchSize: 100,
      captureRetry: { maxAttempts: 5, baseDelayMs: 1_000, maximumDelayMs: 60_000, jitterRatio: 0.2 },
      alerts: {
        enabled: true,
        notify: false,
        minimumSeverity: "WARNING",
        spoolDepth: { warning: 100, error: 1_000 },
        spoolOldestAgeMs: { warning: 60_000, error: 600_000 },
        cursorLagEvents: { warning: 1_000, error: 10_000 },
        failedJobs: { warning: 1, error: 10 },
        hookSilenceMs: { warning: 3_600_000, error: 21_600_000 },
        quietHours: { enabled: false, startMinute: 1_320, endMinute: 480, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], utcOffsetMinutes: 480 },
      },
    },
    future: { injectionMaxTokens: 800, compilerBatchSize: 50, codexQueryTimeoutMs: 30_000, codexQueryConcurrency: 2 },
  };
}

function state(overrides: Partial<ConfigurationState> = {}): ConfigurationState {
  const effective = configuration();
  const draftConfiguration = structuredClone(effective);
  draftConfiguration.runtime.sessionScanIntervalMs = 70_000;
  return {
    view: {
      schemaVersion: 1,
      revision: 2,
      hash: "a".repeat(64),
      projectId: "project-1",
      effective,
      sources: { "runtime.sessionScanIntervalMs": "PROJECT_OVERRIDE" },
    },
    drafts: [{
      draftRevision: 3,
      baseRevision: 2,
      scope: "PROJECT",
      projectId: "project-1",
      configuration: draftConfiguration,
      changedPaths: ["runtime.sessionScanIntervalMs"],
      requiresRestart: false,
      activatable: true,
      diagnostics: [],
    }],
    history: [
      { revision: 2, baseRevision: 1, status: "EFFECTIVE", hash: "a".repeat(64), scope: "PROJECT", projectId: "project-1", changedPaths: ["runtime.sessionScanIntervalMs"], requiresRestart: false, createdAt: timestamp, reasonCode: "COMPONENT_READY" },
      { revision: 1, baseRevision: 0, status: "ROLLED_BACK", hash: "b".repeat(64), scope: "GLOBAL", changedPaths: [], requiresRestart: false, createdAt: timestamp, reasonCode: "COMPONENT_READY" },
    ],
    ...overrides,
  };
}

function unusedApi(overrides: Partial<ConsoleApi> = {}): ConsoleApi {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    overview: unused,
    capabilities: unused,
    sessions: unused,
    session: unused,
    events: unused,
    jobs: unused,
    diagnostics: unused,
    previewCapture: unused,
    commitCapture: unused,
    openInvalidations: () => ({ close: () => undefined }),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("ConfigurationPage", () => {
  it("maps effective values, source, server draft diff and immutable history", async () => {
    const current = state();
    const api = unusedApi({ configuration: async () => current });
    const model = configurationViewModel(current, api);
    expect(model.validationStatus).toBe("READY");
    expect(model.fields.find((field) => field.path === "runtime.sessionScanIntervalMs")).toMatchObject({
      effectiveValue: 60_000,
      draftValue: 70_000,
      source: "PROJECT_OVERRIDE",
    });
    render(<ConfigurationPage api={api} />);
    expect(await screen.findByRole("heading", { name: "有效配置与草稿" })).toBeTruthy();
    expect(screen.getByText("PROJECT_OVERRIDE")).toBeTruthy();
    expect(screen.getByRole("table", { name: "待激活字段影响" })).toBeTruthy();
    expect(screen.getAllByText(/operator 未由 API 提供/u)).toHaveLength(2);
  });

  it("validates a complete typed draft and then refetches server state", async () => {
    const user = userEvent.setup();
    const current = state();
    const getConfiguration = vi.fn(async () => current);
    const validateConfiguration = vi.fn(async () => ({ ok: true as const, draft: current.drafts[0]! }));
    render(<ConfigurationPage api={unusedApi({ configuration: getConfiguration, validateConfiguration })} />);
    const input = await screen.findByRole("spinbutton", { name: "runtime.sessionScanIntervalMs Draft" });
    await user.clear(input);
    await user.type(input, "80000");
    await user.click(screen.getByRole("button", { name: "保存 runtime.sessionScanIntervalMs 草稿字段" }));
    await waitFor(() => expect(validateConfiguration).toHaveBeenCalledOnce());
    expect(validateConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      baseRevision: 2,
      scope: "PROJECT",
      projectId: "project-1",
      draft: expect.objectContaining({ runtime: expect.objectContaining({ sessionScanIntervalMs: 80_000 }) }),
    }), expect.any(AbortSignal));
    await waitFor(() => expect(getConfiguration).toHaveBeenCalledTimes(2));
  });

  it("sends revision-bound activate and rollback commands", async () => {
    const user = userEvent.setup();
    const current = state();
    const activateConfiguration = vi.fn(async () => ({ ok: true as const, revision: 3, hash: "c".repeat(64), status: "EFFECTIVE" as const }));
    const rollbackConfiguration = vi.fn(async () => ({ ok: true as const, revision: 3, hash: "d".repeat(64), status: "ROLLED_BACK" as const }));
    const api = unusedApi({ configuration: async () => current, validateConfiguration: async () => ({ ok: true, draft: current.drafts[0]! }), activateConfiguration, rollbackConfiguration });
    render(<ConfigurationPage api={api} />);
    await user.click(await screen.findByRole("button", { name: "校验并原子激活" }));
    await waitFor(() => expect(activateConfiguration).toHaveBeenCalledWith({ expectedRevision: 2, draftRevision: 3, idempotencyKey: "config-activate-2-3" }, expect.any(AbortSignal)));
    await user.click(screen.getByRole("button", { name: "回滚到 revision 1" }));
    await waitFor(() => expect(rollbackConfiguration).toHaveBeenCalledWith({ expectedRevision: 2, targetRevision: 1, idempotencyKey: "config-rollback-2-1" }, expect.any(AbortSignal)));
  });

  it("fails closed when query or activation capability is unavailable", async () => {
    const unavailable = unusedApi();
    const first = render(<ConfigurationPage api={unavailable} />);
    expect((await screen.findByRole("alert")).textContent).toContain("配置查询能力未接通");
    first.unmount();

    render(<ConfigurationPage api={unusedApi({ configuration: async () => state() })} />);
    const activate = await screen.findByRole("button", { name: "校验并原子激活" });
    expect((activate as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/CONFIGURATION_COMMAND_NOT_CONFIGURED/u).length).toBeGreaterThan(0);
  });

  it("aborts a pending configuration query when the page unmounts", () => {
    let signal: AbortSignal | undefined;
    const getConfiguration = vi.fn((_projectId?: string, nextSignal?: AbortSignal) => {
      signal = nextSignal;
      return new Promise<ConfigurationState>(() => undefined);
    });
    const view = render(<ConfigurationPage api={unusedApi({ configuration: getConfiguration })} />);
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
