import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ProjectContext } from "@zhiloop/domain";
import type { ConfigAssertion, DependencyAssertion, FileAssertion } from "@zhiloop/evidence-engine";

import {
  createRepositoryConfigurationProbe,
  createRepositoryDependencyProbe,
  createRepositoryFileProbe,
} from "./local-probes.js";
import type { RepositoryFile, RepositoryReadPort } from "./types.js";
import { RepositoryReadError } from "./types.js";

const project: ProjectContext = { projectId: "project-1", repositoryRoot: "/repo", portable: false };
const context = { project, correlationId: "correlation-1", requestedAt: "2026-08-19T00:00:00.000Z" };

function repository(files: Readonly<Record<string, string>>): RepositoryReadPort {
  return { read: async (filePath): Promise<RepositoryFile> => {
    const content = files[filePath];
    if (content === undefined) throw new RepositoryReadError("REPOSITORY_FILE_NOT_FOUND");
    return { path: filePath, content, byteLength: Buffer.byteLength(content),
      contentHash: createHash("sha256").update(content).digest("hex") };
  } };
}

function dependency(name: string, manifestPath: string, versionConstraint?: string): DependencyAssertion {
  return { assertionId: "dependency", candidateId: "candidate", kind: "DEPENDENCY_PRESENT", createdAt: context.requestedAt,
    parameters: { name, manifestPath, ...(versionConstraint === undefined ? {} : { versionConstraint }) } };
}

function config(key: string, expected: string, filePath: string): ConfigAssertion {
  return { assertionId: "config", candidateId: "candidate", kind: "CONFIG_EQUALS", createdAt: context.requestedAt,
    parameters: { key, expected, path: filePath } };
}

function file(matchMode: FileAssertion["parameters"]["matchMode"], expected: string, filePath = "src/a.ts"): FileAssertion {
  return { assertionId: "file", candidateId: "candidate", kind: "FILE_CONTAINS", createdAt: context.requestedAt,
    parameters: { path: filePath, expected, matchMode } };
}

describe("Repository local probes", () => {
  it.each([
    ["package.json", "react", "18.3.1", JSON.stringify({ dependencies: { react: "18.3.1" } })],
    ["pom.xml", "org.example:core", "1.2.0", "<project><dependencies><dependency><groupId>org.example</groupId><artifactId>core</artifactId><version>1.2.0</version></dependency></dependencies></project>"],
    ["build.gradle", "org.example:core", "1.2.0", "implementation(\"org.example:core:1.2.0\")"],
    ["Cargo.toml", "serde", "1.0", "[dependencies]\nserde = \"1.0\""],
    ["go.mod", "example.com/core", "v1.2.0", "module local\nrequire example.com/core v1.2.0"],
  ])("parses %s deterministically", async (manifestPath, name, version, content) => {
    const probe = createRepositoryDependencyProbe(repository({ [manifestPath]: content }));
    await expect(probe.observe(dependency(name, manifestPath, version), context)).resolves.toMatchObject({
      status: "SUPPORTED", reasonCode: "DEPENDENCY_VERSION_MATCHED", details: { manifestPath },
    });
  });

  it("distinguishes absent, exact mismatch, unresolved ranges, and damaged manifests", async () => {
    const probe = createRepositoryDependencyProbe(repository({
      "package.json": JSON.stringify({ dependencies: { exact: "1.0.0", ranged: "^2.0.0" } }),
      "bad-package.json": "{",
    }));
    await expect(probe.observe(dependency("missing", "package.json"), context)).resolves.toMatchObject({ status: "REFUTED" });
    await expect(probe.observe(dependency("exact", "package.json", "2.0.0"), context)).resolves.toMatchObject({ status: "REFUTED" });
    await expect(probe.observe(dependency("ranged", "package.json", "2.1.0"), context)).resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "DEPENDENCY_VERSION_UNRESOLVED" });
    await expect(probe.observe(dependency("x", "bad-package.json"), context)).resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "MANIFEST_FORMAT_UNSUPPORTED" });
    const damaged = createRepositoryDependencyProbe(repository({ "package.json": "{" }));
    await expect(damaged.observe(dependency("x", "package.json"), context)).resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "MANIFEST_PARSE_FAILED" });
  });

  it.each([
    ["config.json", "service.retry", "3", "{\"service\":{\"retry\":3}}"],
    ["config.yaml", "service.retry", "3", "service:\n  retry: 3"],
    ["config.toml", "service.retry", "3", "[service]\nretry = 3"],
    ["application.properties", "service.retry", "3", "service.retry=3"],
  ])("reads scalar configuration from %s", async (filePath, key, expected, content) => {
    const probe = createRepositoryConfigurationProbe(repository({ [filePath]: content }));
    await expect(probe.observe(config(key, expected, filePath), context)).resolves.toMatchObject({
      status: "SUPPORTED", reasonCode: "CONFIG_VALUE_MATCHED", details: { configPath: filePath },
    });
  });

  it("does not weaken unsupported configuration semantics", async () => {
    const probe = createRepositoryConfigurationProbe(repository({ "config.yaml": "items:\n  - one" }));
    await expect(probe.observe(config("items", "one", "config.yaml"), context)).resolves.toMatchObject({
      status: "UNKNOWN", reasonCode: "CONFIG_YAML_UNSUPPORTED",
    });
  });

  it("uses literal containment but requires registered bounded evaluators for regex and structure", async () => {
    const repo = repository({ "src/a.ts": "export function run(): number { return 1; }" });
    await expect(createRepositoryFileProbe(repo).observe(file("EXACT", "function run"), context)).resolves.toMatchObject({ status: "SUPPORTED" });
    await expect(createRepositoryFileProbe(repo).observe(file("REGEX", "run\\(\\)"), context)).resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "REGEX_EVALUATOR_UNAVAILABLE" });
    await expect(createRepositoryFileProbe(repo, { regex: { evaluatorId: "safe-regex-v1", evaluate: ({ pattern, content }) => content.includes(pattern) } })
      .observe(file("REGEX", "function run"), context)).resolves.toMatchObject({ status: "SUPPORTED", reasonCode: "REGEX_MATCHED" });
    await expect(createRepositoryFileProbe(repo, { structural: [{ evaluatorId: "ts-ast-v1", extensions: [".ts"],
      contains: ({ expected, content }) => content.includes(expected) }] }).observe(file("STRUCTURAL", "return 1"), context))
      .resolves.toMatchObject({ status: "SUPPORTED", reasonCode: "STRUCTURAL_MATCHED" });
  });

  it("turns evaluator timeout and parser damage into UNKNOWN", async () => {
    const repo = repository({ "src/a.ts": "value", "config.json": "{" });
    const slow = createRepositoryFileProbe(repo, { evaluationTimeoutMs: 10,
      regex: { evaluatorId: "async-safe-v1", evaluate: async () => new Promise<boolean>(() => undefined) } });
    await expect(slow.observe(file("REGEX", "value"), context)).resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "REGEX_EVALUATION_TIMEOUT" });
    await expect(createRepositoryConfigurationProbe(repo).observe(config("a", "b", "config.json"), context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "CONFIG_PARSE_FAILED" });
    const broken = createRepositoryFileProbe(repo, {
      regex: { evaluatorId: "throwing-safe-v1", evaluate: () => { throw new Error("broken evaluator"); } },
    });
    await expect(broken.observe(file("REGEX", "value"), context)).resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "REGEX_EVALUATION_FAILED" });
  });

  it("covers file probe refusal, refutation, and structural evaluator failures", async () => {
    const repo = repository({ "plain": "alpha", "src/a.ts": "alpha" });
    await expect(createRepositoryFileProbe(repo).observe(file("EXACT", "beta"), context))
      .resolves.toMatchObject({ status: "REFUTED", reasonCode: "FILE_LITERAL_NOT_FOUND" });
    await expect(createRepositoryFileProbe(repo).observe(file("STRUCTURAL", "alpha", "plain"), context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "STRUCTURAL_EVALUATOR_UNAVAILABLE" });
    const noMatch = createRepositoryFileProbe(repo, { structural: [{ evaluatorId: "ast-v1", extensions: [".TS"], contains: () => false }] });
    await expect(noMatch.observe(file("STRUCTURAL", "beta"), context))
      .resolves.toMatchObject({ status: "REFUTED", reasonCode: "STRUCTURAL_NOT_MATCHED" });
    const failed = createRepositoryFileProbe(repo, { structural: [{ evaluatorId: "ast-v1", extensions: [".ts"],
      contains: () => { throw new Error("damaged"); } }] });
    await expect(failed.observe(file("STRUCTURAL", "alpha"), context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "STRUCTURAL_EVALUATION_FAILED" });
    const slow = createRepositoryFileProbe(repo, { evaluationTimeoutMs: 10,
      structural: [{ evaluatorId: "ast-v1", extensions: [".ts"], contains: async () => new Promise<boolean>(() => undefined) }] });
    await expect(slow.observe(file("STRUCTURAL", "alpha"), context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "STRUCTURAL_EVALUATION_TIMEOUT" });
    await expect(createRepositoryFileProbe(repo, { regex: { evaluatorId: "regex-v1", evaluate: () => false } })
      .observe(file("REGEX", "beta"), context)).resolves.toMatchObject({ status: "REFUTED", reasonCode: "REGEX_NOT_MATCHED" });
    await expect(createRepositoryFileProbe(repo).observe(file("EXACT", "alpha", "missing.ts"), context))
      .resolves.toMatchObject({ status: "REFUTED", reasonCode: "FILE_NOT_FOUND" });
    const unavailable: RepositoryReadPort = { read: async () => { throw new Error("offline"); } };
    await expect(createRepositoryFileProbe(unavailable).observe(file("EXACT", "alpha"), context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "REPOSITORY_READ_FAILED" });
    const unsafe: RepositoryReadPort = { read: async () => { throw new RepositoryReadError("REPOSITORY_PATH_ESCAPE"); } };
    await expect(createRepositoryFileProbe(unsafe).observe(file("EXACT", "alpha"), context)).rejects.toMatchObject({ code: "REPOSITORY_PATH_ESCAPE" });
    expect(() => createRepositoryFileProbe(repo, { evaluationTimeoutMs: 9 })).toThrow("FILE_PROBE_TIMEOUT_INVALID");
    expect(() => createRepositoryFileProbe(repo, { regex: { evaluatorId: "BAD", evaluate: () => true } })).toThrow("REGEX_EVALUATOR_ID_INVALID");
    expect(() => createRepositoryFileProbe(repo, { structural: [{ evaluatorId: "BAD", extensions: [".ts"], contains: () => true }] }))
      .toThrow("STRUCTURAL_EVALUATOR_ID_INVALID");
    expect(() => createRepositoryFileProbe(repo, { structural: [{ evaluatorId: "ast-v1", extensions: ["ts"], contains: () => true }] }))
      .toThrow("STRUCTURAL_EXTENSION_INVALID");
    expect(() => createRepositoryFileProbe(repo, { structural: [
      { evaluatorId: "ast-a", extensions: [".ts"], contains: () => true },
      { evaluatorId: "ast-b", extensions: [".TS"], contains: () => true },
    ] })).toThrow("STRUCTURAL_EXTENSION_INVALID");
  });

  it.each([
    ["package.json", "x", "1", "[]", "MANIFEST_PARSE_FAILED"],
    ["package.json", "x", "1", JSON.stringify({ dependencies: [] }), "MANIFEST_PARSE_FAILED"],
    ["pom.xml", "x:y", "1", "<!DOCTYPE project><project/>", "MANIFEST_XML_UNSAFE"],
    ["pom.xml", "x:y", "1", "<dependency><groupId>x</groupId></dependency>", "MANIFEST_PARSE_FAILED"],
    ["build.gradle.kts", "x:y", "1", "implementation(\"invalid\")", "MANIFEST_PARSE_FAILED"],
    ["Cargo.toml", "serde", "1", "[dependencies]\ninvalid", "MANIFEST_PARSE_FAILED"],
    ["go.mod", "x/y", "1", "require (\nx/y v1 extra\n)", "MANIFEST_PARSE_FAILED"],
    ["go.mod", "x/y", "1", "require (\nx/y v1", "MANIFEST_PARSE_FAILED"],
    ["unknown.lock", "x", "1", "x=1", "MANIFEST_FORMAT_UNSUPPORTED"],
  ])("fails damaged dependency input %s closed", async (manifestPath, name, version, content, reasonCode) => {
    await expect(createRepositoryDependencyProbe(repository({ [manifestPath]: content }))
      .observe(dependency(name, manifestPath, version), context)).resolves.toMatchObject({ status: "UNKNOWN", reasonCode });
  });

  it("covers dependency defaults, missing versions, and read failures", async () => {
    const defaults = createRepositoryDependencyProbe(repository({ "Cargo.toml": "[dependencies]\nserde = { path = \"../serde\" }" }));
    await expect(defaults.observe({ ...dependency("serde", "Cargo.toml", "1"), parameters: { name: "serde", versionConstraint: "1" } }, context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "DEPENDENCY_VERSION_UNRESOLVED" });
    await expect(createRepositoryDependencyProbe(repository({ "package.json": JSON.stringify({ dependencies: { react: "1.0.0" } }) }))
      .observe({ ...dependency("react", "package.json"), parameters: { name: "react" } }, context))
      .resolves.toMatchObject({ status: "SUPPORTED", reasonCode: "DEPENDENCY_FOUND" });
    await expect(createRepositoryDependencyProbe(repository({})).observe(
      { ...dependency("missing", "package.json"), parameters: { name: "missing" } }, context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "MANIFEST_NOT_FOUND" });
    const unavailable: RepositoryReadPort = { read: async () => { throw new Error("offline"); } };
    await expect(createRepositoryDependencyProbe(unavailable).observe(dependency("x", "package.json"), context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "REPOSITORY_READ_FAILED" });
    const unsafe: RepositoryReadPort = { read: async () => { throw new RepositoryReadError("REPOSITORY_PATH_INVALID"); } };
    await expect(createRepositoryDependencyProbe(unsafe).observe(dependency("x", "package.json"), context))
      .rejects.toMatchObject({ code: "REPOSITORY_PATH_INVALID" });
  });

  it.each([
    ["config.json", "a", "1", "[]", "CONFIG_PARSE_FAILED"],
    ["config.yaml", "a", "1", "bad line", "CONFIG_PARSE_FAILED"],
    ["config.yaml", "a", "1", "a:\t1", "CONFIG_YAML_UNSUPPORTED"],
    ["config.yaml", "a", "1", "a: { unsafe }", "CONFIG_YAML_UNSUPPORTED"],
    ["config.toml", "a", "1", "a = \"unterminated", "CONFIG_PARSE_FAILED"],
    ["config.toml", "a", "1", "not-a-pair", "CONFIG_TOML_UNSUPPORTED"],
    ["application.properties", "a", "1", "a=one\\two", "CONFIG_PROPERTIES_UNSUPPORTED"],
    ["application.properties", "a", "1", "invalid", "CONFIG_PARSE_FAILED"],
    ["config.ini", "a", "1", "a=1", "CONFIG_FORMAT_UNSUPPORTED"],
  ])("fails damaged configuration input %s closed", async (filePath, key, expected, content, reasonCode) => {
    await expect(createRepositoryConfigurationProbe(repository({ [filePath]: content })).observe(config(key, expected, filePath), context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode });
  });

  it("covers configuration mismatch, non-scalars, missing values, defaults, and read failures", async () => {
    const probe = createRepositoryConfigurationProbe(repository({ "config.json": JSON.stringify({ a: 1, nested: { value: true } }) }));
    await expect(probe.observe(config("a", "2", "config.json"), context)).resolves.toMatchObject({ status: "REFUTED", reasonCode: "CONFIG_VALUE_MISMATCH" });
    await expect(probe.observe(config("nested", "true", "config.json"), context)).resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "CONFIG_VALUE_NON_SCALAR" });
    await expect(probe.observe(config("missing", "1", "config.json"), context)).resolves.toMatchObject({ status: "REFUTED", reasonCode: "CONFIG_KEY_NOT_FOUND" });
    await expect(createRepositoryConfigurationProbe(repository({})).observe(
      { ...config("missing", "1", "config.json"), parameters: { key: "missing", expected: "1" } }, context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "CONFIG_FILE_NOT_FOUND" });
    const unavailable: RepositoryReadPort = { read: async () => { throw new Error("offline"); } };
    await expect(createRepositoryConfigurationProbe(unavailable).observe(config("a", "1", "config.json"), context))
      .resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "REPOSITORY_READ_FAILED" });
    const unsafe: RepositoryReadPort = { read: async () => { throw new RepositoryReadError("REPOSITORY_FILE_NOT_REGULAR"); } };
    await expect(createRepositoryConfigurationProbe(unsafe).observe(config("a", "1", "config.json"), context))
      .rejects.toMatchObject({ code: "REPOSITORY_FILE_NOT_REGULAR" });
    expect(() => createRepositoryConfigurationProbe(repository({}), { maxKeyDepth: 0 })).toThrow("CONFIG_KEY_DEPTH_INVALID");
  });
});
