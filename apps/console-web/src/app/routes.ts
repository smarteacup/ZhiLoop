import { useSyncExternalStore } from "react";

export type RouteName = "overview" | "sessions" | "knowledge" | "retrieval" | "closure" | "operations" | "jobs" | "diagnostics" | "configuration" | "deployment";
export interface ConsoleRoute { readonly name: RouteName; readonly sessionId?: string; readonly knowledgeId?: string }

const routeNames = new Set<RouteName>([
  "overview", "sessions", "knowledge", "retrieval", "closure", "operations", "jobs", "diagnostics", "configuration", "deployment",
]);

export function parseRoute(hash: string): ConsoleRoute {
  const value = hash.replace(/^#\/?/u, "");
  const [name, id] = value.split("/");
  if (name === "sessions" && id !== undefined && id.length > 0) {
    try {
      return { name, sessionId: decodeURIComponent(id) };
    } catch {
      return { name: "overview" };
    }
  }
  if (name === "knowledge" && id !== undefined && id.length > 0) {
    try {
      return { name, knowledgeId: decodeURIComponent(id) };
    } catch {
      return { name: "overview" };
    }
  }
  return routeNames.has(name as RouteName) ? { name: name as RouteName } : { name: "overview" };
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function useRoute(): ConsoleRoute {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "#/overview");
  return parseRoute(hash);
}
