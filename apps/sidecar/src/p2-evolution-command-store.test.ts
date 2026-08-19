import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EvolutionCommandReceiptStore } from "./p2-evolution-command-store.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("EvolutionCommandReceiptStore", () => {
  it("persists exact command results and rejects idempotency-key reuse", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhiloop-evolution-command-")); roots.push(root);
    const filename = path.join(root, "receipts.sqlite"); let store = new EvolutionCommandReceiptStore(filename);
    const result = store.save("command-key-0001", "a".repeat(64), { disposition: "NO_CHANGES" }, "2026-08-19T01:00:00.000Z");
    expect(result).toEqual({ disposition: "NO_CHANGES" }); store.close();
    store = new EvolutionCommandReceiptStore(filename);
    expect(store.get("command-key-0001", "a".repeat(64))).toEqual(result);
    expect(() => store.get("command-key-0001", "b".repeat(64))).toThrow("IDEMPOTENCY_CONFLICT");
    store.close();
  });
});
