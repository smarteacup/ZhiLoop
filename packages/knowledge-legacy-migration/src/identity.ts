import { createHash } from "node:crypto";

export function migrationCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(migrationCanonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${migrationCanonical(child)}`).join(",")}}`;
}

export function migrationHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : migrationCanonical(value)).digest("hex");
}

export function legacyMigrationId(input: {
  readonly migrationVersion: string;
  readonly projectId: string;
  readonly sourceRegistryRevision: number;
  readonly summaryHash: string;
  readonly createdAt: string;
}): string {
  return `legacy-migration-${migrationHash(["legacy-code-migration-v1", input]).slice(0, 40)}`;
}
