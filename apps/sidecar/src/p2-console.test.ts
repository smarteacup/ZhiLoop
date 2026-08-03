import { describe, expect, it } from "vitest";

import { ordinaryP2Scope } from "./p2-console.js";

describe("ordinary P2 Console scope boundary", () => {
  it("preserves supported scope levels and never relabels USER or TEAM as GLOBAL", () => {
    expect(ordinaryP2Scope("PROJECT")).toBe("PROJECT");
    expect(ordinaryP2Scope("GLOBAL")).toBe("GLOBAL");
    expect(() => ordinaryP2Scope("USER")).toThrow("unsupported ordinary governance scope");
    expect(() => ordinaryP2Scope("TEAM")).toThrow("unsupported ordinary governance scope");
  });
});
