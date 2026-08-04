import { useCallback, useEffect, useState } from "react";

export type AsyncValue<T> =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly value: T }
  | { readonly status: "error"; readonly error: Error };

export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>): readonly [AsyncValue<T>, () => void] {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<AsyncValue<T>>({ status: "loading" });
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => current.status === "success" ? current : { status: "loading" });
    void load(controller.signal).then(
      (value) => { if (!controller.signal.aborted) setState({ status: "success", value }); },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", error: error instanceof Error ? error : new Error("unknown error") });
      },
    );
    return () => controller.abort();
  }, [load, revision]);
  return [state, retry] as const;
}
