#!/usr/bin/env node
import {
  KnowledgeGovernanceService,
  SqliteGovernanceStore,
} from "@zhiloop/knowledge-governance";
import { SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";
import { MarkdownKnowledgeRepository } from "@zhiloop/markdown-repository";

import { runKnowledgeCli } from "./knowledge-cli.js";

const argv = process.argv.slice(2);
const isHelp = argv.length === 0 || argv.includes("--help") || argv.includes("-h");
const markdownRoot = process.env["CKL_MARKDOWN_ROOT"];
const registryPath = process.env["CKL_REGISTRY_PATH"];
const governancePath = process.env["CKL_GOVERNANCE_PATH"];

let result;
if (isHelp && (markdownRoot === undefined || registryPath === undefined || governancePath === undefined)) {
  result = await runKnowledgeCli(argv);
} else if (markdownRoot === undefined || registryPath === undefined || governancePath === undefined) {
  result = {
    exitCode: 2 as const,
    stdout: "",
    stderr: "Error: CKL_MARKDOWN_ROOT, CKL_REGISTRY_PATH, and CKL_GOVERNANCE_PATH are required\n",
  };
} else {
  const registry = new SqliteKnowledgeRegistryProjection(registryPath);
  const store = new SqliteGovernanceStore(governancePath);
  try {
    const governance = new KnowledgeGovernanceService(new MarkdownKnowledgeRepository(markdownRoot), registry, store);
    result = await runKnowledgeCli(argv, { governance });
  } finally {
    store.close();
    registry.close();
  }
}

if (result.stdout.length > 0) process.stdout.write(result.stdout);
if (result.stderr.length > 0) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
