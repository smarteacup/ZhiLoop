// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConsoleApi,
  InvalidationHandlers,
  InvalidationPollResult,
} from "../../../api/client.js";
import { useInvalidationFeed } from "./useInvalidationFeed.js";

const timestamp = "2026-08-03T12:00:00.000Z";

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
    ...overrides,
  };
}

function Harness({ api, onInvalidate }: {
  readonly api: ConsoleApi;
  readonly onInvalidate: (resources: readonly string[]) => void;
}): React.JSX.Element {
  const feed = useInvalidationFeed(api, onInvalidate);
  return <div>
    <output aria-label="connection">{feed.connection}</output>
    <output aria-label="revision">{feed.revision}</output>
    <output aria-label="resources">{feed.invalidatedResources.join(",")}</output>
  </div>;
}

function pollResult(overrides: Partial<InvalidationPollResult> = {}): InvalidationPollResult {
  return {
    currentRevision: 1,
    oldestRetainedRevision: 1,
    requestedAfterRevision: 0,
    nextRevision: 1,
    resyncRequired: false,
    hasMore: false,
    retryAfterMs: 1_000,
    events: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useInvalidationFeed", () => {
  it("accepts monotonic named SSE events, debounces invalidation and closes on cleanup", async () => {
    vi.useFakeTimers();
    let handlers: InvalidationHandlers | undefined;
    const close = vi.fn();
    const onInvalidate = vi.fn();
    const api = unusedApi({
      openInvalidations: (next) => {
        handlers = next;
        return { close };
      },
    });

    const view = render(<Harness api={api} onInvalidate={onInvalidate} />);
    act(() => handlers?.onOpen());
    expect(screen.getByLabelText("connection").textContent).toBe("LIVE");

    act(() => {
      handlers?.onEvent({ schemaVersion: 1, eventId: "event-2", type: "job.updated", entityId: "job-1", revision: 2, occurredAt: timestamp });
      handlers?.onEvent({ schemaVersion: 1, eventId: "event-1", type: "configuration.updated", revision: 1, occurredAt: timestamp });
    });
    expect(screen.getByLabelText("revision").textContent).toBe("2");
    expect(screen.getByLabelText("resources").textContent).toBe("JOBS,OPERATIONS,CODEGRAPH,MIGRATIONS,KNOWLEDGE");
    expect(onInvalidate).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(onInvalidate).toHaveBeenCalledOnce();
    expect(onInvalidate).toHaveBeenCalledWith(["JOBS", "OPERATIONS", "CODEGRAPH", "MIGRATIONS", "KNOWLEDGE"]);

    view.unmount();
    expect(close).toHaveBeenCalledOnce();
  });

  it("coalesces a sustained invalidation stream into bounded background refreshes", async () => {
    vi.useFakeTimers();
    let handlers: InvalidationHandlers | undefined;
    const onInvalidate = vi.fn();
    render(<Harness api={unusedApi({
      openInvalidations: (next) => { handlers = next; return { close: () => undefined }; },
    })} onInvalidate={onInvalidate} />);

    act(() => handlers?.onEvent({ schemaVersion: 1, eventId: "event-1", type: "job.updated", entityId: "job-1", revision: 1, occurredAt: timestamp }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(onInvalidate).toHaveBeenCalledOnce();
    act(() => handlers?.onEvent({ schemaVersion: 1, eventId: "event-2", type: "job.updated", entityId: "job-1", revision: 2, occurredAt: timestamp }));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(onInvalidate).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(onInvalidate).toHaveBeenCalledTimes(2);
  });

  it("falls back to bounded polling and requests a full refresh for resync", async () => {
    vi.useFakeTimers();
    const onInvalidate = vi.fn();
    const pollInvalidations = vi.fn(async () => pollResult({
      currentRevision: 9,
      oldestRetainedRevision: 8,
      nextRevision: 9,
      resyncRequired: true,
      retryAfterMs: 70_000,
    }));
    render(<Harness api={unusedApi({ pollInvalidations })} onInvalidate={onInvalidate} />);
    expect(screen.getByLabelText("connection").textContent).toBe("POLLING");

    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(pollInvalidations).toHaveBeenCalledWith(0, expect.any(AbortSignal));
    expect(screen.getByLabelText("connection").textContent).toBe("RESYNC_REQUIRED");
    expect(screen.getByLabelText("revision").textContent).toBe("9");
    expect(screen.getByLabelText("resources").textContent).toBe("JOBS,SESSIONS,CONFIGURATION,ALERTS,OPERATIONS,CODEGRAPH,MIGRATIONS,KNOWLEDGE");
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(onInvalidate).toHaveBeenCalledWith(["JOBS", "SESSIONS", "CONFIGURATION", "ALERTS", "OPERATIONS", "CODEGRAPH", "MIGRATIONS", "KNOWLEDGE"]);

    await act(async () => { await vi.advanceTimersByTimeAsync(59_899); });
    expect(pollInvalidations).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(pollInvalidations).toHaveBeenCalledTimes(2);
  });

  it("never overlaps polling and aborts the pending request on cleanup", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((value: InvalidationPollResult) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    const pollInvalidations = vi.fn((_afterRevision: number, signal?: AbortSignal) => {
      requestSignal = signal;
      return new Promise<InvalidationPollResult>((resolve) => { resolvePoll = resolve; });
    });
    const view = render(<Harness api={unusedApi({ pollInvalidations })} onInvalidate={() => undefined} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(pollInvalidations).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(pollInvalidations).toHaveBeenCalledOnce();

    await act(async () => { resolvePoll?.(pollResult()); });
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(pollInvalidations).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(pollInvalidations).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("surfaces an offline state and retries on a bounded delay after polling errors", async () => {
    vi.useFakeTimers();
    const pollInvalidations = vi.fn(async () => { throw new Error("gateway unavailable"); });
    render(<Harness api={unusedApi({ pollInvalidations })} onInvalidate={() => undefined} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(screen.getByLabelText("connection").textContent).toBe("OFFLINE");
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(pollInvalidations).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(pollInvalidations).toHaveBeenCalledTimes(2);
  });

  it("stops fallback polling after the bounded failure budget", async () => {
    vi.useFakeTimers();
    const pollInvalidations = vi.fn(async () => { throw new Error("gateway unavailable"); });
    render(<Harness api={unusedApi({ pollInvalidations })} onInvalidate={() => undefined} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100_000); });
    expect(pollInvalidations).toHaveBeenCalledTimes(5);
    expect(screen.getByLabelText("connection").textContent).toBe("OFFLINE");
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(pollInvalidations).toHaveBeenCalledTimes(5);
  });
});
