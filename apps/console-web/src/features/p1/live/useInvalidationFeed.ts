import { useCallback, useEffect, useRef, useState } from "react";

import type { ConsoleApi, InvalidationHandlers, InvalidationSubscription } from "../../../api/client.js";
import type { SseInvalidationEvent } from "@zhiloop/control-api";

export type InvalidatedResource = "JOBS" | "SESSIONS" | "CONFIGURATION" | "ALERTS";

export interface InvalidationFeedState {
  readonly connection: "LIVE" | "RECONNECTING" | "POLLING" | "RESYNC_REQUIRED" | "OFFLINE";
  readonly revision: number;
  readonly lastEventId?: string | undefined;
  readonly lastEventAt?: string | undefined;
  readonly pollingIntervalMs?: number | undefined;
  readonly invalidatedResources: readonly InvalidatedResource[];
}

export interface InvalidationFeed extends InvalidationFeedState {
  acknowledge(): void;
}

const ALL_RESOURCES: readonly InvalidatedResource[] = Object.freeze(["JOBS", "SESSIONS", "CONFIGURATION", "ALERTS"]);
const MIN_POLL_DELAY_MS = 250;
const MAX_POLL_DELAY_MS = 60_000;
const OFFLINE_RETRY_MS = 5_000;
const INVALIDATION_DEBOUNCE_MS = 100;

function resourcesFor(event: SseInvalidationEvent): readonly InvalidatedResource[] {
  if (event.type === "job.updated") return ["JOBS"];
  if (event.type === "session.updated" || event.type === "stage.updated") return ["SESSIONS"];
  if (event.type === "configuration.updated") return ["CONFIGURATION"];
  if (event.type === "alert.updated" || event.type === "capability.updated") return ["ALERTS"];
  return ALL_RESOURCES;
}

function boundedPollDelay(value: number): number {
  if (!Number.isFinite(value)) return OFFLINE_RETRY_MS;
  return Math.max(MIN_POLL_DELAY_MS, Math.min(MAX_POLL_DELAY_MS, Math.round(value)));
}

export function useInvalidationFeed(api: ConsoleApi, onInvalidate: (resources: readonly InvalidatedResource[]) => void): InvalidationFeed {
  const [state, setState] = useState<InvalidationFeedState>({ connection: "RECONNECTING", revision: 0, invalidatedResources: [] });
  const revision = useRef(0);
  const resources = useRef(new Set<InvalidatedResource>());

  useEffect(() => {
    const controller = new AbortController();
    let subscription: InvalidationSubscription | undefined;
    let pollingTimer: ReturnType<typeof setTimeout> | undefined;
    let invalidateTimer: ReturnType<typeof setTimeout> | undefined;

    const publishResources = (next: readonly InvalidatedResource[]): void => {
      for (const resource of next) resources.current.add(resource);
      const invalidatedResources = ALL_RESOURCES.filter((resource) => resources.current.has(resource));
      setState((current) => ({ ...current, invalidatedResources }));
      if (invalidateTimer !== undefined) clearTimeout(invalidateTimer);
      invalidateTimer = setTimeout(() => {
        if (!controller.signal.aborted) onInvalidate(invalidatedResources);
      }, INVALIDATION_DEBOUNCE_MS);
    };

    const accept = (event: SseInvalidationEvent): void => {
      if (event.revision <= revision.current || controller.signal.aborted) return;
      revision.current = event.revision;
      const resync = event.type === "resync.required";
      setState((current) => ({
        ...current,
        connection: resync ? "RESYNC_REQUIRED" : "LIVE",
        revision: event.revision,
        lastEventId: event.eventId,
        lastEventAt: event.occurredAt,
      }));
      publishResources(resourcesFor(event));
    };

    const schedulePoll = (delayMs: number, poll: () => Promise<void>): void => {
      if (controller.signal.aborted) return;
      if (pollingTimer !== undefined) clearTimeout(pollingTimer);
      pollingTimer = setTimeout(() => { void poll(); }, boundedPollDelay(delayMs));
    };

    const poll = async (): Promise<void> => {
      if (controller.signal.aborted) return;
      const pollInvalidations = api.pollInvalidations;
      if (pollInvalidations === undefined) {
        setState((current) => ({ ...current, connection: "OFFLINE", pollingIntervalMs: OFFLINE_RETRY_MS }));
        schedulePoll(OFFLINE_RETRY_MS, poll);
        return;
      }
      try {
        const result = await pollInvalidations(revision.current, controller.signal);
        if (controller.signal.aborted) return;
        if (result.resyncRequired) {
          revision.current = result.nextRevision;
          setState((current) => ({ ...current, connection: "RESYNC_REQUIRED", revision: result.nextRevision, pollingIntervalMs: result.retryAfterMs }));
          publishResources(ALL_RESOURCES);
        } else {
          for (const event of result.events) accept(event);
          revision.current = Math.max(revision.current, result.nextRevision);
          setState((current) => ({ ...current, connection: "POLLING", revision: revision.current, pollingIntervalMs: result.retryAfterMs }));
        }
        schedulePoll(result.hasMore ? MIN_POLL_DELAY_MS : result.retryAfterMs, poll);
      } catch {
        if (controller.signal.aborted) return;
        setState((current) => ({ ...current, connection: "OFFLINE", pollingIntervalMs: OFFLINE_RETRY_MS }));
        schedulePoll(OFFLINE_RETRY_MS, poll);
      }
    };

    const handlers: InvalidationHandlers = {
      onOpen: () => {
        if (!controller.signal.aborted) setState((current) => ({ ...current, connection: "LIVE", pollingIntervalMs: undefined }));
      },
      onEvent: accept,
      onError: () => {
        if (controller.signal.aborted) return;
        subscription?.close();
        setState((current) => ({ ...current, connection: "POLLING", pollingIntervalMs: MIN_POLL_DELAY_MS }));
        schedulePoll(MIN_POLL_DELAY_MS, poll);
      },
    };

    if (api.openInvalidations === undefined) {
      setState((current) => ({ ...current, connection: "POLLING", pollingIntervalMs: MIN_POLL_DELAY_MS }));
      schedulePoll(MIN_POLL_DELAY_MS, poll);
    } else {
      subscription = api.openInvalidations(handlers, controller.signal);
    }

    return () => {
      controller.abort();
      subscription?.close();
      if (pollingTimer !== undefined) clearTimeout(pollingTimer);
      if (invalidateTimer !== undefined) clearTimeout(invalidateTimer);
    };
  }, [api, onInvalidate]);

  const acknowledge = useCallback(() => {
    resources.current.clear();
    setState((current) => ({ ...current, invalidatedResources: [] }));
  }, []);
  return { ...state, acknowledge };
}
