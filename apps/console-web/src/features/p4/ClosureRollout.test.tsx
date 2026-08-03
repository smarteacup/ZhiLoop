// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClosurePage } from "./ClosurePage.js";
import { RolloutPage } from "./RolloutPage.js";
import { p4Api } from "./test-fixtures.js";

afterEach(cleanup);

describe("P4 evidence views", () => {
  it("shows Task Contract, gate evidence, decision and recursive state", async () => {
    const user = userEvent.setup(); render(<ClosurePage api={p4Api()} sessionId="session-1" />);
    await user.click(await screen.findByRole("button", { name: "closure-1" }));
    expect(await screen.findByRole("heading", { name: "Task Contract" })).toBeTruthy();
    expect(screen.getByText("TESTS_PASSED")).toBeTruthy();
    expect(screen.getByText("未发生")).toBeTruthy();
    expect(screen.getByText(/NOT_REQUIRED/u)).toBeTruthy();
  });

  it("renders scoped canary, eligibility fingerprints and last-known-good", async () => {
    render(<RolloutPage api={p4Api()} />);
    expect(await screen.findByRole("heading", { name: "Scoped canary" })).toBeTruthy();
    expect(screen.getByText("project-1")).toBeTruthy();
    expect(screen.getByText(`sha256:${"c".repeat(64)}`)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Last-known-good" })).toBeTruthy();
  });

  it("cancels an in-flight closure detail request", async () => {
    let observedSignal: AbortSignal | undefined;
    const detail = vi.fn((_id: string, signal?: AbortSignal) => {
      observedSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const user = userEvent.setup(); render(<ClosurePage api={p4Api({ closureRun: detail })} sessionId="session-1" />);
    await user.click(await screen.findByRole("button", { name: "closure-1" }));
    await user.click(await screen.findByRole("button", { name: "取消详情加载" }));
    expect(observedSignal?.aborted).toBe(true);
  });
});
