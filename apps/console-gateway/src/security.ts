import net from "node:net";

import type { IncomingMessage, ServerResponse } from "node:http";

export const SAFE_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

function normalizedIp(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = normalizedIp(address);
  if (normalized === "::1") return true;
  if (net.isIPv4(normalized)) return normalized.startsWith("127.");
  return false;
}

export function assertLoopbackBind(host: string): void {
  if (!isLoopbackAddress(host)) throw new Error("Console Gateway must bind to an explicit loopback IP address");
}

export function applySafeHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SAFE_RESPONSE_HEADERS)) response.setHeader(name, value);
}

export function expectedAuthority(request: IncomingMessage): string | undefined {
  const address = normalizedIp(request.socket.localAddress);
  const port = request.socket.localPort;
  if (!address || !port) return undefined;
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

export function hasTrustedRequestBoundary(request: IncomingMessage, requireOrigin: boolean): "OK" | "REMOTE" | "HOST" | "ORIGIN" {
  if (!isLoopbackAddress(request.socket.remoteAddress ?? "")) return "REMOTE";
  const authority = expectedAuthority(request);
  const host = request.headers.host;
  if (!authority || !host || host.toLowerCase() !== authority.toLowerCase()) return "HOST";
  const expectedOrigin = `http://${authority}`;
  const origin = request.headers.origin;
  if ((requireOrigin && origin !== expectedOrigin) || (origin !== undefined && origin !== expectedOrigin)) return "ORIGIN";
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") return "ORIGIN";
  return "OK";
}

interface RateRecord {
  count: number;
  startedAt: number;
}

export class FixedWindowRateLimiter {
  private readonly records = new Map<string, RateRecord>();

  public constructor(private readonly maximum: number, private readonly windowMs: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000) throw new Error("maximum rate is invalid");
    if (!Number.isSafeInteger(windowMs) || windowMs < 100 || windowMs > 60 * 60_000) throw new Error("rate window is invalid");
  }

  public allow(key: string, now = Date.now()): boolean {
    const current = this.records.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.records.set(key, { count: 1, startedAt: now });
      return true;
    }
    current.count += 1;
    return current.count <= this.maximum;
  }
}
