import { createHmac, timingSafeEqual } from "node:crypto";

import { GovernanceError } from "./errors.js";

interface CursorPayload {
  readonly offset: number;
  readonly filterHash: string;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export class GovernanceCursorCodec {
  readonly #secret: Buffer;

  constructor(secret: Uint8Array) {
    if (secret.byteLength < 32) throw new Error("cursor secret must contain at least 32 bytes");
    this.#secret = Buffer.from(secret);
  }

  encode(payload: CursorPayload): string {
    const body = encode(JSON.stringify(payload));
    const signature = createHmac("sha256", this.#secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  decode(cursor: string, expectedFilterHash: string): number {
    const [body, signature, extra] = cursor.split(".");
    if (body === undefined || signature === undefined || extra !== undefined) {
      throw new GovernanceError("INVALID_REQUEST", "knowledge cursor is invalid");
    }
    const expected = createHmac("sha256", this.#secret).update(body).digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, "base64url");
    } catch {
      throw new GovernanceError("INVALID_REQUEST", "knowledge cursor is invalid");
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new GovernanceError("INVALID_REQUEST", "knowledge cursor signature is invalid");
    }
    let payload: CursorPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
    } catch {
      throw new GovernanceError("INVALID_REQUEST", "knowledge cursor payload is invalid");
    }
    if (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.filterHash !== expectedFilterHash) {
      throw new GovernanceError("INVALID_REQUEST", "knowledge cursor does not match this query");
    }
    return payload.offset;
  }
}
