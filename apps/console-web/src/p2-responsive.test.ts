import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("P2 responsive layout contract", () => {
  it("keeps the 1024px console usable with a bounded responsive breakpoint", async () => {
    const css = await readFile(path.resolve("apps/console-web/src/styles.css"), "utf8");
    expect(css).toContain("@media (max-width: 1180px)");
    expect(css).toMatch(/\.filter-grid\s*\{\s*grid-template-columns:\s*repeat\(3/u);
    expect(css).toMatch(/main\s*\{\s*padding-inline:\s*28px/u);
  });
});
