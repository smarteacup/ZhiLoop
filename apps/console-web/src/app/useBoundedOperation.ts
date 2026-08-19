import { useCallback, useEffect, useRef, useState } from "react";

import type { AsyncValue } from "./useAsync.js";

export function useBoundedOperation<T>(
  load: (signal: AbortSignal) => Promise<T>,
  shouldPoll: (value: T) => boolean,
  options: { readonly intervalMs?: number; readonly maxFailures?: number } = {},
): readonly [AsyncValue<T>, () => void] {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<AsyncValue<T>>({ status: "loading" });
  const loadRef = useRef(load); const pollRef = useRef(shouldPoll);
  loadRef.current = load; pollRef.current = shouldPoll;
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let failures = 0;
    const interval = options.intervalMs ?? 2_000; const maximumFailures = options.maxFailures ?? 5;
    const run = async (): Promise<void> => {
      try {
        const value = await loadRef.current(controller.signal); if (controller.signal.aborted) return;
        failures = 0; setState({ status: "success", value });
        if (pollRef.current(value)) timer = setTimeout(() => { void run(); }, interval);
      } catch (error) {
        if (controller.signal.aborted) return;
        failures += 1; setState({ status: "error", error: error instanceof Error ? error : new Error("unknown error") });
        if (failures < maximumFailures) timer = setTimeout(() => { void run(); }, Math.min(30_000, interval * (2 ** (failures - 1))));
      }
    };
    void run();
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [load, options.intervalMs, options.maxFailures, revision]);
  return [state, retry] as const;
}
