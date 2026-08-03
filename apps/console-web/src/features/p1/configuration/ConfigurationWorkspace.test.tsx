// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RevisionActionGate } from "../actionGuard.js";
import {
  ConfigurationWorkspace,
  type ConfigurationCommandPort,
  type ConfigurationWorkspaceViewModel,
} from "./ConfigurationWorkspace.js";

const timestamp = "2026-08-03T12:00:00.000Z";

function gate(currentRevision: number, overrides: Partial<RevisionActionGate> = {}): RevisionActionGate {
  return {
    capability: { status: "READY", reasonCode: "READY", observedAt: timestamp },
    allowed: true,
    expectedRevision: currentRevision,
    currentRevision,
    idempotencyKey: `config-action-${currentRevision}`,
    ...overrides,
  };
}

function model(overrides: Partial<ConfigurationWorkspaceViewModel> = {}): ConfigurationWorkspaceViewModel {
  return {
    effectiveRevision: 10,
    effectiveHash: "effective-safe-hash",
    draftRevision: 11,
    basedOnRevision: 10,
    fields: [{
      path: "ingestion.scanIntervalMs",
      label: "扫描间隔",
      kind: "number",
      effectiveValue: 5_000,
      draftValue: 10_000,
      source: "PROJECT_OVERRIDE",
      sourceDetail: "覆盖 GLOBAL=30000",
      restartImpact: "NONE",
      edit: gate(11),
    }],
    validationStatus: "READY",
    validationReasonCode: "VALIDATION_SUCCEEDED",
    diagnostics: [],
    diff: [{
      path: "ingestion.scanIntervalMs",
      before: 5_000,
      after: 10_000,
      affectedComponents: ["automatic-ingestion"],
      restartImpact: "NONE",
    }],
    affectedComponents: ["automatic-ingestion"],
    activate: gate(10),
    history: [{
      revision: 8,
      hash: "history-safe-hash",
      activatedAt: timestamp,
      operator: "local-user",
      result: "ACTIVE",
      changedPaths: ["ingestion.scanIntervalMs"],
      rollback: gate(10),
    }],
    ...overrides,
  };
}

function commands(): { readonly port: ConfigurationCommandPort; readonly changeDraft: ReturnType<typeof vi.fn>; readonly activate: ReturnType<typeof vi.fn>; readonly rollback: ReturnType<typeof vi.fn> } {
  const changeDraft = vi.fn(async () => undefined);
  const activate = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  return { port: { changeDraft, activate, rollback }, changeDraft, activate, rollback };
}

afterEach(() => cleanup());

describe("ConfigurationWorkspace", () => {
  it("shows effective source, draft diff, component impact, diagnostics, and immutable history", () => {
    render(<ConfigurationWorkspace viewModel={model({ diagnostics: [{ severity: "WARNING", code: "RESTART_RECOMMENDED", message: "检查 worker", path: "ingestion.scanIntervalMs" }] })} />);
    expect(screen.getByText("PROJECT_OVERRIDE")).toBeTruthy();
    expect(screen.getByText(/覆盖 GLOBAL=30000/u)).toBeTruthy();
    expect(screen.getByRole("table", { name: "待激活字段影响" })).toBeTruthy();
    expect(screen.getByText(/RESTART_RECOMMENDED/u)).toBeTruthy();
    expect(screen.getByText("revision 8")).toBeTruthy();
    expect(screen.getByText("history-safe-hash")).toBeTruthy();
  });

  it("edits locally and sends one explicit draft command with capability, revision and idempotency guard", async () => {
    const user = userEvent.setup();
    const command = commands();
    render(<ConfigurationWorkspace viewModel={model()} commands={command.port} />);
    const input = screen.getByRole("spinbutton", { name: "扫描间隔 Draft" });
    await user.clear(input);
    await user.type(input, "15000");
    expect(command.changeDraft).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "保存 扫描间隔 草稿字段" }));
    expect(command.changeDraft).toHaveBeenCalledTimes(1);
    expect(command.changeDraft).toHaveBeenCalledWith({
      path: "ingestion.scanIntervalMs",
      value: 15_000,
      expectedDraftRevision: 11,
      idempotencyKey: "config-action-11",
    });
  });

  it("blocks activation for server ERROR diagnostics or a stale draft baseline", () => {
    const command = commands();
    const { rerender } = render(<ConfigurationWorkspace viewModel={model({ diagnostics: [{ severity: "ERROR", code: "ZERO_DELAY", message: "不能为零" }] })} commands={command.port} />);
    let button = screen.getByRole("button", { name: "校验并原子激活" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("ERROR");

    rerender(<ConfigurationWorkspace viewModel={model({ basedOnRevision: 9 })} commands={command.port} />);
    button = screen.getByRole("button", { name: "校验并原子激活" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("基线已过期");
  });

  it("does not synthesize validation success when the server reports NOT_VERIFIED", () => {
    render(<ConfigurationWorkspace viewModel={model({ validationStatus: "NOT_VERIFIED", validationReasonCode: "VALIDATION_EVIDENCE_MISSING" })} commands={commands().port} />);
    expect(screen.getByText("NOT_VERIFIED")).toBeTruthy();
    expect(screen.getAllByText("VALIDATION_EVIDENCE_MISSING").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "校验并原子激活" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("activates and rolls back with the exact expected effective revision", async () => {
    const user = userEvent.setup();
    const command = commands();
    render(<ConfigurationWorkspace viewModel={model()} commands={command.port} />);
    await user.click(screen.getByRole("button", { name: "校验并原子激活" }));
    expect(command.activate).toHaveBeenCalledWith({ draftRevision: 11, expectedEffectiveRevision: 10, idempotencyKey: "config-action-10" });
    await user.click(screen.getByRole("button", { name: "回滚到 revision 8" }));
    expect(command.rollback).toHaveBeenCalledWith({ targetRevision: 8, expectedEffectiveRevision: 10, idempotencyKey: "config-action-10" });
    expect(await screen.findByText(/创建新 revision/u)).toBeTruthy();
  });

  it("disables every write when capability is not READY or the command port is absent", () => {
    const disabled = gate(10, { capability: { status: "NOT_VERIFIED", reasonCode: "CONFIG_ACTIVATION_NOT_VERIFIED", observedAt: timestamp } });
    render(<ConfigurationWorkspace viewModel={model({ activate: disabled, history: [{ ...model().history[0]!, rollback: disabled }] })} />);
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/CONFIG_ACTIVATION_NOT_VERIFIED/u)).toHaveLength(2);
  });

  it("supports boolean and string drafts while keeping empty diff/history explicit", async () => {
    const user = userEvent.setup();
    const command = commands();
    const base = model();
    render(<ConfigurationWorkspace viewModel={model({
      fields: [
        { ...base.fields[0]!, path: "alerts.enabled", label: "启用告警", kind: "boolean", effectiveValue: false, draftValue: false },
        { ...base.fields[0]!, path: "alerts.severity", label: "告警级别", kind: "string", effectiveValue: "WARNING", draftValue: "WARNING" },
      ],
      diff: [],
      affectedComponents: [],
      history: [],
    })} commands={command.port} />);
    await user.click(screen.getByRole("checkbox", { name: "启用告警 Draft" }));
    await user.click(screen.getByRole("button", { name: "保存 启用告警 草稿字段" }));
    expect(command.changeDraft).toHaveBeenCalledWith({ path: "alerts.enabled", value: true, expectedDraftRevision: 11, idempotencyKey: "config-action-11" });
    expect(screen.getByText("草稿与 effective 配置一致。")).toBeTruthy();
    expect(screen.getByText("受影响组件：无")).toBeTruthy();
  });

  it("reports activation and rollback command failures while retaining effective history", async () => {
    const user = userEvent.setup();
    const port: ConfigurationCommandPort = {
      changeDraft: async () => undefined,
      activate: async () => { throw new Error("component prepare failed"); },
      rollback: async () => { throw new Error("rollback compatibility failed"); },
    };
    render(<ConfigurationWorkspace viewModel={model()} commands={port} />);
    await user.click(screen.getByRole("button", { name: "校验并原子激活" }));
    expect(await screen.findByText("component prepare failed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "回滚到 revision 8" }));
    expect(await screen.findByText("rollback compatibility failed")).toBeTruthy();
    expect(screen.getByText("effective-safe-hash")).toBeTruthy();
  });

  it("reports a failed field save and preserves the server-provided draft value", async () => {
    const user = userEvent.setup();
    const port: ConfigurationCommandPort = {
      changeDraft: async () => { throw new Error("draft revision conflict"); },
      activate: async () => undefined,
      rollback: async () => undefined,
    };
    render(<ConfigurationWorkspace viewModel={model()} commands={port} />);
    const input = screen.getByRole("spinbutton", { name: "扫描间隔 Draft" });
    await user.clear(input);
    await user.type(input, "12000");
    await user.click(screen.getByRole("button", { name: "保存 扫描间隔 草稿字段" }));
    expect(await screen.findByText("draft revision conflict")).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("12000");
  });
});
