// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAsync } from "./useAsync.js";

function Harness({ load }: { readonly load: (signal: AbortSignal) => Promise<string> }): React.JSX.Element {
  const [state, retry] = useAsync(load);
  return <div>
    <output aria-label="state">{state.status === "success" ? state.value : state.status}</output>
    <button type="button" onClick={retry}>retry</button>
  </div>;
}

afterEach(() => cleanup());

describe("useAsync", () => {
  it("retains the last successful value while a background refresh is pending", async () => {
    let resolveRefresh: ((value: string) => void) | undefined;
    const load = vi.fn()
      .mockResolvedValueOnce("current")
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveRefresh = resolve; }));
    render(<Harness load={load} />);

    expect(await screen.findByText("current")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(screen.getByLabelText("state").textContent).toBe("current");

    await act(async () => { resolveRefresh?.("refreshed"); });
    expect(await screen.findByText("refreshed")).toBeTruthy();
  });
});
