export function takeBootstrapToken(hash: string): string | undefined {
  const parameters = new URLSearchParams(hash.replace(/^#/u, ""));
  const token = parameters.get("bootstrap");
  return token === null || token.length < 32 || token.length > 256 ? undefined : token;
}

export async function exchangeBootstrapToken(
  token: string,
  request: typeof fetch = fetch,
): Promise<string> {
  const response = await request("/api/v1/auth/exchange", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const value = await response.json() as { csrfToken?: unknown };
  if (!response.ok || typeof value.csrfToken !== "string") throw new Error("ZhiLoop Console authentication failed");
  return value.csrfToken;
}
