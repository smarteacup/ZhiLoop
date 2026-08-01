import { describe, expect, it } from "vitest";

import { ConfigurationStore } from "./store.js";

describe("ConfigurationStore", () => {
  it("atomically activates a valid configuration", () => {
    const store = new ConfigurationStore();
    const previous = store.active;
    const result = store.activate({ injection: { defaultMaxTokens: 512 } });

    expect(result.activated).toBe(true);
    expect(store.active).not.toBe(previous);
    expect(store.active.injection.defaultMaxTokens).toBe(512);
    expect(Object.isFrozen(store.active.injection)).toBe(true);
  });

  it("retains the previous object when activation fails", () => {
    const store = new ConfigurationStore({ injection: { defaultMaxTokens: 512 } });
    const previous = store.active;
    const result = store.activate({ injection: { failOpenOnTimeout: false } });

    expect(result.activated).toBe(false);
    expect(result.configuration).toBe(previous);
    expect(store.active).toBe(previous);
  });

  it("refuses to start from an invalid initial configuration", () => {
    expect(() => new ConfigurationStore({ retention: { rawEventDays: 31 } })).toThrow(
      "configuration violates its schema or safety invariants",
    );
  });
});

