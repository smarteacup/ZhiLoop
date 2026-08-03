import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function sources(directory: string): Promise<string[]> {
  const values: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) values.push(...await sources(absolute));
    else if (/\.(?:ts|tsx)$/u.test(entry.name) && !entry.name.includes(".test.")) values.push(await readFile(absolute, "utf8"));
  }
  return values;
}

describe("browser privacy boundary", () => {
  it("does not persist knowledge or session content in browser storage", async () => {
    const serialized = (await sources(path.resolve("apps/console-web/src"))).join("\n");
    expect(serialized).not.toMatch(/localStorage|indexedDB|sessionStorage/u);
    expect(serialized).not.toMatch(/https?:\/\//u);
  });
});
