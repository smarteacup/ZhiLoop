import { randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "zhiloop_session";

interface SessionRecord {
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export interface BootstrapExchange {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface SessionAuthentication {
  readonly authenticated: boolean;
  readonly csrfValid: boolean;
}

export interface SessionResume {
  readonly csrfToken: string;
  readonly expiresAt: string;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function parseCookies(header: string | undefined): Map<string, string> | undefined {
  const result = new Map<string, string>();
  if (!header) return result;
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) return undefined;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (!name || !value || result.has(name)) return undefined;
    result.set(name, value);
  }
  return result;
}

export class BrowserSessionManager {
  private bootstrapConsumed = false;
  private readonly sessions = new Map<string, SessionRecord>();

  public constructor(
    private readonly bootstrapToken: string,
    private readonly sessionTtlMs = 15 * 60_000,
    private readonly bootstrapExpiresAt = Date.now() + 2 * 60_000,
  ) {
    if (bootstrapToken.length < 32 || bootstrapToken.length > 256) throw new Error("bootstrapToken length is invalid");
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 10_000 || sessionTtlMs > 24 * 60 * 60_000) {
      throw new Error("sessionTtlMs is outside the safe range");
    }
  }

  public exchange(token: string, now = Date.now()): BootstrapExchange | undefined {
    this.prune(now);
    if (this.bootstrapConsumed || now >= this.bootstrapExpiresAt || !constantTimeEqual(token, this.bootstrapToken)) return undefined;
    this.bootstrapConsumed = true;
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const expiresAt = now + this.sessionTtlMs;
    this.sessions.set(sessionToken, { csrfToken, expiresAt });
    return {
      cookie: `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.sessionTtlMs / 1_000)}`,
      csrfToken,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  public authenticate(cookieHeader: string | undefined, csrfHeader: string | undefined, now = Date.now()): SessionAuthentication {
    this.prune(now);
    const cookies = parseCookies(cookieHeader);
    if (!cookies) return { authenticated: false, csrfValid: false };
    const sessionToken = cookies.get(SESSION_COOKIE);
    if (!sessionToken) return { authenticated: false, csrfValid: false };
    const session = this.sessions.get(sessionToken);
    if (!session || session.expiresAt <= now) return { authenticated: false, csrfValid: false };
    return {
      authenticated: true,
      csrfValid: typeof csrfHeader === "string" && constantTimeEqual(csrfHeader, session.csrfToken),
    };
  }

  public resume(cookieHeader: string | undefined, now = Date.now()): SessionResume | undefined {
    this.prune(now);
    const cookies = parseCookies(cookieHeader);
    if (!cookies) return undefined;
    const sessionToken = cookies.get(SESSION_COOKIE);
    if (!sessionToken) return undefined;
    const session = this.sessions.get(sessionToken);
    if (!session || session.expiresAt <= now) return undefined;
    return Object.freeze({ csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
  }

  private prune(now: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export function createBootstrapToken(): string {
  return randomToken();
}
