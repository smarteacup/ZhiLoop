import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { MAX_CURSOR_BYTES } from "./constants.js";

export const cursorPayloadSchema = z.strictObject({
  version: z.literal(1),
  sortKey: z.string().min(1).max(512),
  tieBreaker: z.string().min(1).max(500),
  filterHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

export interface CursorCodec {
  encode(payload: CursorPayload): string;
  decode(cursor: string): CursorPayload;
}

function secretBytes(secret: string | Uint8Array): Uint8Array {
  const value = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  if (value.byteLength < 32) throw new Error("cursor signing secret must contain at least 32 bytes");
  return Uint8Array.from(value);
}

function sign(payload: string, secret: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

export function createCursorCodec(secretInput: string | Uint8Array): CursorCodec {
  const secret = secretBytes(secretInput);
  return Object.freeze({
    encode(input: CursorPayload): string {
      const payload = cursorPayloadSchema.parse(input);
      const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const encodedSignature = sign(encodedPayload, secret).toString("base64url");
      const cursor = `${encodedPayload}.${encodedSignature}`;
      if (Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) throw new Error("encoded cursor exceeds byte limit");
      return cursor;
    },
    decode(cursor: string): CursorPayload {
      if (typeof cursor !== "string" || cursor.length === 0 || Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) {
        throw new Error("invalid cursor");
      }
      const parts = cursor.split(".");
      if (parts.length !== 2) throw new Error("invalid cursor");
      const encodedPayload = parts[0];
      const encodedSignature = parts[1];
      if (encodedPayload === undefined || encodedSignature === undefined) throw new Error("invalid cursor");
      let supplied: Buffer;
      try {
        supplied = Buffer.from(encodedSignature, "base64url");
      } catch {
        throw new Error("invalid cursor");
      }
      const expected = sign(encodedPayload, secret);
      if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) throw new Error("invalid cursor");
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown;
      } catch {
        throw new Error("invalid cursor");
      }
      const parsed = cursorPayloadSchema.safeParse(value);
      if (!parsed.success) throw new Error("invalid cursor");
      return parsed.data;
    },
  });
}
