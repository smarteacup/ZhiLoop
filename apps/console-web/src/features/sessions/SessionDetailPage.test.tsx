// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { ConsoleApi } from "../../api/client.js";
import { SessionDetailPage } from "./SessionDetailPage.js";

const timestamp = "2026-08-04T00:00:00.000Z";

function api(): ConsoleApi {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    overview: unused,
    capabilities: async () => ({ items: [] }),
    sessions: async () => ({ items: [] }),
    session: async () => ({
      summary: {
        schemaVersion: 1,
        sessionId: "session-1",
        title: "Ledger 可见性设计",
        source: "CODEX_TRANSCRIPT",
        sourceStatus: "AVAILABLE",
        captureStatus: "CAPTURED_CURRENT",
        firstActivityAt: timestamp,
        lastActivityAt: timestamp,
        eventCount: 1,
        turnCount: 1,
        ignoredRecords: 0,
        redactionCount: 1,
      },
      stages: [],
      injections: [],
    }),
    events: async () => ({ items: [{
      schemaVersion: 1,
      sequence: 7,
      eventId: "event-7",
      eventType: "turn.stopped",
      source: "codex-transcript",
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: timestamp,
      correlationId: "correlation-7",
      contentHash: "a".repeat(64),
      redactionCount: 1,
      payloadPurged: false,
      contentPreview: "已完成 [REDACTED] Ledger 设计",
      contentTruncated: false,
    }] }),
    jobs: async () => ({ items: [] }),
    diagnostics: unused,
    previewCapture: unused,
    commitCapture: unused,
  };
}

afterEach(() => cleanup());

describe("SessionDetailPage", () => {
  it("shows localized capture status and exposes redacted Ledger content from a clear tab", async () => {
    const user = userEvent.setup();
    render(<SessionDetailPage api={api()} sessionId="session-1" />);

    const localized = await screen.findByText("已采集至最新");
    expect(localized.getAttribute("title")).toBe("CAPTURED_CURRENT");
    await user.click(screen.getByRole("tab", { name: "Ledger 内容" }));
    expect(await screen.findByRole("heading", { name: "Ledger 已沉淀内容" })).toBeTruthy();
    expect(screen.getByText("已完成 [REDACTED] Ledger 设计")).toBeTruthy();
    expect(screen.getByText("脱敏内容可查看")).toBeTruthy();
  });
});
