import { describe, expect, it, vi } from "vitest";

import { CONTROL_API_SCHEMA_VERSION, sseInvalidationEventSchema } from "@zhiloop/control-api";

import {
  BoundedInvalidationLog,
  createResyncInvalidation,
  encodeInvalidationFrame,
  parseRevision,
} from "./invalidation.js";

const NOW = "2026-08-03T12:00:00.000Z";

function invalidation(revision: number, entityId = `session-${revision}`): unknown {
  return {
    schemaVersion: CONTROL_API_SCHEMA_VERSION,
    eventId: `event-${revision}`,
    type: "session.updated",
    entityId,
    revision,
    occurredAt: NOW,
    reasonCode: "CAPTURED_CURRENT",
  };
}

describe("BoundedInvalidationLog", () => {
  it("validates events and requires globally increasing revisions", () => {
    const log = new BoundedInvalidationLog({ maximumEvents: 3, maximumBytes: 4_096 });
    expect(log.publish(invalidation(2))).toMatchObject({ revision: 2, entityId: "session-2" });
    expect(() => log.publish(invalidation(2))).toThrow(/greater than 2/u);
    expect(() => log.publish(invalidation(1))).toThrow(/greater than 2/u);
    expect(() => log.publish({ ...invalidation(3) as object, rawPrompt: "forbidden" })).toThrow(/schema/u);
    expect(log.currentRevision).toBe(2);
  });

  it("retains bounded replay state and marks expired or future cursors for resync", () => {
    const log = new BoundedInvalidationLog({ maximumEvents: 2, maximumBytes: 4_096 });
    log.publish(invalidation(1));
    log.publish(invalidation(2));
    log.publish(invalidation(3));
    expect(log.oldestRetainedRevision).toBe(2);
    expect(log.snapshot(1).events.map(({ revision }) => revision)).toEqual([2, 3]);
    expect(log.snapshot(0)).toMatchObject({ currentRevision: 3, oldestRetainedRevision: 2, resyncRequired: true, events: [] });
    expect(log.snapshot(4)).toMatchObject({ currentRevision: 3, resyncRequired: true, events: [] });
  });

  it("evicts by encoded byte size even when the event-count limit has room", () => {
    const log = new BoundedInvalidationLog({ maximumEvents: 10, maximumBytes: 1_024 });
    log.publish(invalidation(1, `session-${"a".repeat(180)}`));
    log.publish(invalidation(2, `session-${"b".repeat(180)}`));
    log.publish(invalidation(3, `session-${"c".repeat(180)}`));
    expect(log.oldestRetainedRevision).toBeGreaterThan(1);
    expect(log.snapshot(0).resyncRequired).toBe(true);
  });

  it("supports bounded polling pages without duplicate transitions", () => {
    const log = new BoundedInvalidationLog({ maximumEvents: 4, maximumBytes: 8_192 });
    for (let revision = 1; revision <= 4; revision += 1) log.publish(invalidation(revision));
    const first = log.snapshot(0, 2);
    expect(first).toMatchObject({ nextRevision: 2, hasMore: true, resyncRequired: false });
    expect(first.events.map(({ revision }) => revision)).toEqual([1, 2]);
    const second = log.snapshot(first.nextRevision, 2);
    expect(second).toMatchObject({ nextRevision: 4, hasMore: false, resyncRequired: false });
    expect(second.events.map(({ revision }) => revision)).toEqual([3, 4]);
  });

  it("fans out live events and releases subscribers deterministically", () => {
    const log = new BoundedInvalidationLog({ maximumEvents: 2, maximumBytes: 4_096 });
    const listener = vi.fn();
    const broken = vi.fn(() => { throw new Error("disconnected subscriber"); });
    log.subscribe(broken);
    const unsubscribe = log.subscribe(listener);
    const published = log.publish(invalidation(1));
    expect(listener).toHaveBeenCalledWith(published, encodeInvalidationFrame(published));
    expect(broken).toHaveBeenCalledTimes(1);
    unsubscribe();
    log.publish(invalidation(2));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it("emits schema-valid resync events and strictly parses numeric revisions", () => {
    const resync = createResyncInvalidation(7, "STALE_REVISION", NOW);
    expect(sseInvalidationEventSchema.parse(resync)).toMatchObject({
      eventId: "resync-stale-revision-7",
      type: "resync.required",
      revision: 7,
      reasonCode: "SOURCE_UNAVAILABLE",
    });
    expect(parseRevision("0")).toBe(0);
    expect(parseRevision("123")).toBe(123);
    expect(parseRevision("01")).toBeUndefined();
    expect(parseRevision("1\n")).toBeUndefined();
    expect(parseRevision("9999999999999999")).toBeUndefined();
    expect(parseRevision(null)).toBeUndefined();
  });

  it("rejects unsafe construction, snapshot and event bounds", () => {
    expect(() => new BoundedInvalidationLog({ maximumEvents: 0 })).toThrow(/maximumEvents/u);
    expect(() => new BoundedInvalidationLog({ maximumBytes: 1_023 })).toThrow(/maximumBytes/u);
    const log = new BoundedInvalidationLog({ maximumEvents: 2, maximumBytes: 1_024 });
    expect(() => log.snapshot(-1)).toThrow(/afterRevision/u);
    expect(() => log.snapshot(0, 3)).toThrow(/limit/u);
    expect(() => log.publish(invalidation(1, "x".repeat(10_000)))).toThrow(/schema/u);
  });
});
