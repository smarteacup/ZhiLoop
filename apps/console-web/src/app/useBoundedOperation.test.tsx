// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useBoundedOperation } from "./useBoundedOperation.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function Harness({ load }: { readonly load: (signal: AbortSignal) => Promise<{ running: boolean }> }): React.JSX.Element {
  useBoundedOperation(load, (value) => value.running, { intervalMs: 1_000 }); return <div />;
}

describe("useBoundedOperation", () => {
  it("keeps one timer, stops on terminal state, and aborts on unmount", async () => {
    vi.useFakeTimers(); const signals: AbortSignal[] = []; let call = 0;
    const load = vi.fn(async (signal: AbortSignal) => { signals.push(signal); call += 1; return { running: call === 1 }; });
    const view = render(<Harness load={load} />); await vi.runOnlyPendingTimersAsync();
    expect(load).toHaveBeenCalledTimes(2); await vi.runOnlyPendingTimersAsync(); expect(load).toHaveBeenCalledTimes(2);
    view.unmount(); expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
