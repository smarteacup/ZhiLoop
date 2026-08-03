import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  InjectionRolloutController,
  UserPromptInjectionService,
} from "../packages/codex-context-injection/dist/index.js";
import { DEFAULT_CONFIGURATION } from "../packages/config/dist/index.js";
import { ContextOrchestrator } from "../packages/context-orchestrator/dist/index.js";
import { SqliteKnowledgeRegistryProjection } from "../packages/knowledge-registry/dist/index.js";
import { KnowledgeMcpService } from "../packages/knowledge-mcp/dist/index.js";
import { KnowledgeReranker } from "../packages/knowledge-reranker/dist/index.js";
import {
  calculateKnowledgeContentHash,
  MarkdownKnowledgeRepository,
} from "../packages/markdown-repository/dist/index.js";
import { resolveQueryContext } from "../packages/query-context/dist/index.js";
import {
  buildRetrievalTrace,
  fingerprintRetrievalConfiguration,
} from "../packages/retrieval-evaluation/dist/index.js";
import {
  MultiChannelRetrievalEngine,
  SqliteKnowledgeRetrievalSource,
} from "../packages/retrieval-engine/dist/index.js";

const observedAt = "2026-08-03T06:00:00.000Z";
const hermes = {
  projectId: "project-hermes-tachograph",
  repositoryRoot: "/Users/workspace/cpp/hermes-tachograph",
  portable: false,
};
const algorithmStrategy = {
  projectId: "project-algorithm-strategy",
  repositoryRoot: "/Users/workspace/java/algorithm-strategy",
  portable: false,
};

function asset(input) {
  const draft = {
    schemaVersion: 1,
    id: input.id,
    subjectKey: input.id,
    kind: input.kind,
    scope: input.scope,
    version: 1,
    status: input.status,
    title: input.title,
    summary: input.summary,
    body: input.body,
    aliases: input.aliases ?? [],
    keywords: input.keywords ?? [],
    applicability: input.applicability ?? [],
    nonApplicability: input.nonApplicability ?? [],
    symbols: input.symbols ?? [],
    relations: input.relations ?? [],
    evidence: [{ evidenceId: `evidence-${input.id}`, verdict: "SUPPORTS" }],
    confidence: input.confidence,
    sourceEpisodes: ["episode-019f837a-34d4-7e60-800c-6361f6fb6d49"],
    contentHash: "",
    correlationId: "real-session-injection-simulation",
    createdAt: observedAt,
    updatedAt: observedAt,
  };
  return Object.freeze({ ...draft, contentHash: calculateKnowledgeContentHash(draft) });
}

const requirementId = "dms.strategy.code13-3213";
const knowledge = [
  asset({
    id: "fatigue.strategy.hermes-3200",
    kind: "IMPLEMENTATION",
    status: "IMPLEMENTED",
    scope: { level: "SYMBOL", projectId: hermes.projectId, symbols: ["RuleFatigueStrategy", "FatigueRuleWrapper"] },
    title: "Hermes 3200 疲劳策略生产逻辑",
    summary: "闭眼或哈欠行为命中 Rule1 至 Rule5 且未升级为 3201 时产生 3200。",
    body: "RuleFatigueStrategy 聚合 5、10、20 分钟窗口内的次数、持续时间、间隔和历史规则。Rule1 至 Rule5 按顺序匹配；当前 Rule1 加历史 Rule1、当前 Rule3 加历史 Rule3、当前 Rule3 加历史 Rule5 会升级为 3201，其他命中结果产生 3200。",
    aliases: ["3200", "TACHOGRAPH_TEMPORAL_FATIGUE"],
    keywords: ["闭眼", "哈欠", "Rule1", "Rule3", "Rule5", "3201"],
    symbols: ["RuleFatigueStrategy", "FatigueRuleWrapper"],
    confidence: 0.98,
  }),
  asset({
    id: requirementId,
    kind: "REQUIREMENT",
    status: "ACCEPTED",
    scope: { level: "SYMBOL", projectId: algorithmStrategy.projectId, symbols: ["DmsFatigue3213Handler"] },
    title: "DMS 3005/code13 映射到策略 3213",
    summary: "detectId=3005 且有效 code=13 的消息必须输出 strategy=3213 和 character_type=13。",
    body: "有效映射为 detectId=3005、currentCode=13、character_type=13、strategy=3213、scenario=ai-fatigue-reminder。该链路不执行旧 DMS 36/37 的时间窗口和司机评分过滤。",
    aliases: ["3005/13", "strategy 3213", "DMS 3213"],
    keywords: ["3005", "currentCode", "character_type", "ai-fatigue-reminder"],
    symbols: ["DmsFatigue3213Handler"],
    confidence: 1,
  }),
  asset({
    id: "dms.input.order-cleaner-routing",
    kind: "IMPLEMENTATION",
    status: "IMPLEMENTED",
    scope: { level: "MODULE", projectId: algorithmStrategy.projectId, modulePaths: ["src/main/java", "src/main/resources"] },
    title: "使用 OrderMQCleanServiceImpl 清洗并路由 3005 消息",
    summary: "3005 优先使用 currentCode，兼容回退 code，并由 OrderMQCleanServiceImpl 保留完整订单字段。",
    body: "Cleaner 使用 OrderMQCleanServiceImpl。3005 的 subDetectId 通过 currentCode;code 解析，因此 code=-1、currentCode=13 可以进入 3005/13 Handler。",
    aliases: ["3005 cleaner", "currentCode;code"],
    keywords: ["OrderMQCleanServiceImpl", "subDetectId", "application.yml"],
    symbols: ["OrderMQCleanServiceImpl", "DmsFatigue3213Handler"],
    relations: [{ type: "IMPLEMENTS", targetId: requirementId, targetVersion: 1, reason: "input routing for 3005/13" }],
    confidence: 0.98,
  }),
  asset({
    id: "dms.output.message-contract",
    kind: "DECISION",
    status: "ACCEPTED",
    scope: { level: "SYMBOL", projectId: algorithmStrategy.projectId, symbols: ["DmsFatigue3213Handler"] },
    title: "DMS 3213 输出字段契约",
    summary: "character_type 取有效 currentCode，云端日志不追加 timestamp，并省略 hit_rule 和 exp_flag。",
    body: "MQ、端上 PublicLog 和云端 PublicLog 的 character_type 都取有效 currentCode。云端 key 固定为 sec_ai_tachograph_reminder。该直接输出链路不执行疲劳规则和实验分组，因此不输出 hit_rule 与 exp_flag。",
    aliases: ["3213 output contract", "sec_ai_tachograph_reminder"],
    keywords: ["character_type", "hit_rule", "exp_flag", "currentCode"],
    symbols: ["DmsFatigue3213Handler"],
    relations: [{ type: "RELATED_TO", targetId: requirementId, targetVersion: 1, reason: "accepted output contract" }],
    confidence: 0.99,
  }),
  asset({
    id: "dms.output.order-model",
    kind: "DECISION",
    status: "ACCEPTED",
    scope: { level: "SYMBOL", projectId: algorithmStrategy.projectId, symbols: ["CSIOrderVo", "DmsFatigue3213Handler"] },
    title: "复用 CSIOrderVo 作为 3213 订单输出模型",
    summary: "保留 OrderVo 作为内部清洗模型，输出映射到 CSIOrderVo，不维护重复 DTO。",
    body: "DmsFatigue3213Handler 将 OrderVo 映射为已有 CSIOrderVo，删除重复的 DmsFatigueOrderDTO，避免维护两套相同订单字段。",
    aliases: ["CSIOrderVo", "DmsFatigueOrderDTO"],
    keywords: ["OrderVo", "订单模型", "DTO"],
    symbols: ["CSIOrderVo", "DmsFatigue3213Handler"],
    relations: [{ type: "RELATED_TO", targetId: requirementId, targetVersion: 1, reason: "accepted output model" }],
    confidence: 0.98,
  }),
  asset({
    id: "dms.idempotency.codis-key",
    kind: "IMPLEMENTATION",
    status: "IMPLEMENTED",
    scope: { level: "SYMBOL", projectId: algorithmStrategy.projectId, symbols: ["DmsFatigue3213Handler"] },
    title: "DMS 3213 使用 15 秒 Codis 幂等",
    summary: "幂等 Key 由 deviceId、detectId、eventTime 和 effectiveCode 组成，处理失败时删除 Key。",
    body: "使用 Codis SET-if-absent，TTL 固定 15 秒。TTL 内重复消息跳过；处理失败删除幂等 Key，使 DDMQ 能重新投递。已接受不处理 Key 过期后重新抢占的极端竞争窗口。",
    aliases: ["3213 幂等", "DMS 去重"],
    keywords: ["deviceId", "detectId", "eventTime", "effectiveCode", "Codis", "DDMQ"],
    symbols: ["DmsFatigue3213Handler"],
    relations: [{ type: "IMPLEMENTS", targetId: requirementId, targetVersion: 1, reason: "delivery idempotency for 3213" }],
    confidence: 1,
  }),
  asset({
    id: "dms.device.lookup-retry",
    kind: "IMPLEMENTATION",
    status: "IMPLEMENTED",
    scope: { level: "MODULE", projectId: algorithmStrategy.projectId, modulePaths: ["src/main/java"] },
    title: "使用 deviceId 查询设备并保持 DDMQ 重试",
    summary: "3213 使用 needDriverInfo=1 查询设备；查询异常向上抛出、回滚幂等 Key，并让 DDMQ 重试。",
    body: "DeviceService 保留原单参数方法，并增加 needDriverInfo 重载。DmsFatigue3213Handler 使用 deviceId 和 needDriverInfo=1 获取 city_id 与 driver_id。查询异常不得降级为 0/0，而应向上传递，随后回滚 Codis Key 并返回消费失败。",
    aliases: ["DeviceService retry", "needDriverInfo"],
    keywords: ["DeviceFeignClient", "deviceId", "driver_id", "city_id", "DDMQ"],
    symbols: ["DeviceService", "DeviceFeignClient", "DmsFatigue3213Handler"],
    relations: [
      { type: "IMPLEMENTS", targetId: requirementId, targetVersion: 1, reason: "device enrichment for 3213" },
      { type: "RELATED_TO", targetId: "dms.idempotency.codis-key", targetVersion: 1, reason: "failure rolls back the idempotency key" },
    ],
    confidence: 1,
  }),
  asset({
    id: "dms.logging.publiclog-output",
    kind: "IMPLEMENTATION",
    status: "IMPLEMENTED",
    scope: { level: "SYMBOL", projectId: algorithmStrategy.projectId, symbols: ["DmsFatigue3213Handler"] },
    title: "DMS 3213 输出端上和云端 PublicLog",
    summary: "每个有效 3005/13 事件输出 sec_ai_tachograph_feature 和 sec_ai_tachograph_reminder。",
    body: "端上日志保存原始 DMS 事件，云端日志保存 strategy=3213 和 MQ 内容。两类日志的 character_type 都取有效 currentCode，VisualAlgBizImpl 的全局流水日志继续保留。",
    aliases: ["PublicLog", "sec_ai_tachograph_feature", "sec_ai_tachograph_reminder"],
    keywords: ["client log", "cloud log", "character_type"],
    symbols: ["DmsFatigue3213Handler"],
    relations: [
      { type: "IMPLEMENTS", targetId: requirementId, targetVersion: 1, reason: "logging for 3213" },
      { type: "RELATED_TO", targetId: "dms.output.message-contract", targetVersion: 1, reason: "uses the accepted field contract" },
    ],
    confidence: 0.97,
  }),
];

const scenarios = [
  {
    name: "Hermes 精确命中",
    project: hermes,
    prompt: "请分析 `RuleFatigueStrategy` 中 3200 的生产逻辑",
    expectedStatus: "INJECTED",
    expectedLevel: "L1_POINTER",
    expectedIds: ["fatigue.strategy.hermes-3200"],
    expectedDetails: { "fatigue.strategy.hermes-3200": "L1_POINTER" },
    expansions: [{ id: "fatigue.strategy.hermes-3200", targetDetailLevel: "L3_EVIDENCED" }],
  },
  {
    name: "3213 需求与实现组合",
    project: algorithmStrategy,
    prompt: "在 `DmsFatigue3213Handler` 实现 3005/13 到 3213，需要遵守哪些约束？",
    expectedStatus: "INJECTED",
    expectedLevel: "L2_COMPACT",
    expectedIds: [requirementId],
    expectedDetails: { [requirementId]: "L2_COMPACT" },
    expansions: [
      { id: "dms.output.message-contract", searchQuery: "character_type hit_rule exp_flag", targetDetailLevel: "L2_COMPACT" },
      { id: "dms.idempotency.codis-key", searchQuery: "Codis", targetDetailLevel: "L3_EVIDENCED" },
    ],
  },
  {
    name: "设备异常与重试",
    project: algorithmStrategy,
    prompt: "`DeviceService` 查询异常后，如何保证 DDMQ 可以重试？",
    expectedStatus: "INJECTED",
    expectedLevel: "L2_COMPACT",
    expectedIds: ["dms.device.lookup-retry"],
    expansions: [{ id: "dms.device.lookup-retry", searchQuery: "DeviceService", targetDetailLevel: "L3_EVIDENCED" }],
  },
  {
    name: "PublicLog 字段契约",
    project: algorithmStrategy,
    prompt: "`sec_ai_tachograph_reminder` 的 character_type、hit_rule 和 exp_flag 应该怎么输出？",
    expectedStatus: "INJECTED",
    expectedLevel: "L2_COMPACT",
    expectedIds: ["dms.output.message-contract"],
    expansions: [
      { id: "dms.output.message-contract", searchQuery: "character_type hit_rule exp_flag", targetDetailLevel: "L2_COMPACT" },
      { id: "dms.logging.publiclog-output", searchQuery: "PublicLog", targetDetailLevel: "L3_EVIDENCED" },
    ],
  },
  {
    name: "高风险修改保持简介并按需展开证据",
    project: algorithmStrategy,
    prompt: "准备修改 `DeviceService` 异常处理和 3213 幂等回滚，请给出已有约束与证据",
    signals: { risk: "HIGH", ambiguous: false, conflicting: false },
    expectedStatus: "INJECTED",
    expectedLevel: "L2_COMPACT",
    expectedIds: [requirementId],
    expansions: [
      { id: "dms.device.lookup-retry", searchQuery: "DeviceService", targetDetailLevel: "L3_EVIDENCED" },
      { id: "dms.idempotency.codis-key", searchQuery: "Codis", targetDetailLevel: "L3_EVIDENCED" },
    ],
  },
  {
    name: "跨项目隔离",
    project: algorithmStrategy,
    prompt: "请分析 `RuleFatigueStrategy` 中 3200 的生产逻辑",
    expectedStatus: "NO_CONTEXT",
    expectedIds: [],
  },
  {
    name: "无关问题",
    project: algorithmStrategy,
    prompt: "请解释快速排序的平均时间复杂度",
    expectedStatus: "NO_CONTEXT",
    expectedIds: [],
  },
];

function mcpBackend(registry) {
  const source = new SqliteKnowledgeRetrievalSource(registry);
  const assets = (projected) => projected.map((item) => item.asset.asset);
  return {
    search: async ({ query, limit }) => ({
      traceId: "trace-simulation-mcp-search",
      assets: assets(source.searchFts(query, limit)),
    }),
    related: async ({ seedAssetIds, limit }) => ({
      traceId: "trace-simulation-mcp-related",
      assets: assets(source.related(seedAssetIds, limit)),
    }),
    current: async ({ assetIds }) => ({
      traceId: "trace-simulation-mcp-current",
      assets: assetIds.flatMap((id) => source.getCurrent(id)?.asset ?? []),
    }),
  };
}

async function activeContext(registry, scenario, runId) {
  const queryContext = resolveQueryContext({
    prompt: scenario.prompt,
    project: scenario.project,
    cwd: scenario.project.repositoryRoot,
    taskId: runId,
  });
  const engine = new MultiChannelRetrievalEngine(
    new SqliteKnowledgeRetrievalSource(registry),
    undefined,
    { channels: { exact: true, fts: true, vector: false, relation: true } },
  );
  const retrieval = await engine.retrieve({ context: queryContext, policy: DEFAULT_CONFIGURATION.retrieval });
  const rerank = await new KnowledgeReranker().rerank(queryContext, retrieval.items);
  const signals = scenario.signals ?? { risk: "LOW", ambiguous: false, conflicting: false };
  const envelope = new ContextOrchestrator().orchestrate({
    runId,
    traceId: `trace-${runId}`,
    queryContext,
    candidates: rerank.items,
    policy: DEFAULT_CONFIGURATION.injection,
    signals,
  });
  const trace = buildRetrievalTrace({
    traceId: `trace-${runId}`,
    runId,
    queryContext,
    retrieval,
    rerank,
    envelope,
    signals,
    automatic: true,
  });
  return { queryContext, retrieval, rerank, envelope, trace };
}

async function simulate(registry, rollout, scenario, index) {
  const runId = `simulation-${index + 1}`;
  let context;
  const injection = await new UserPromptInjectionService({
    retrieve: async () => {
      context = await activeContext(registry, scenario, runId);
      return { envelope: context.envelope, trace: context.trace };
    },
  }, rollout).handle({
    hook_event_name: "UserPromptSubmit",
    session_id: `new-session-${index + 1}`,
    turn_id: runId,
    cwd: scenario.project.repositoryRoot,
    prompt: scenario.prompt,
  });
  assert.ok(context);
  const ids = context.envelope.items.map((item) => item.id);
  assert.equal(injection.status, scenario.expectedStatus, scenario.name);
  if (scenario.expectedLevel !== undefined) assert.equal(context.envelope.complexity.level, scenario.expectedLevel, scenario.name);
  for (const expectedId of scenario.expectedIds) assert.ok(ids.includes(expectedId), `${scenario.name}: missing ${expectedId}`);
  for (const [id, detailLevel] of Object.entries(scenario.expectedDetails ?? {})) {
    assert.equal(context.envelope.items.find((item) => item.id === id)?.detailLevel, detailLevel, `${scenario.name}: ${id} detail`);
  }
  if (scenario.expectedStatus === "NO_CONTEXT") assert.deepEqual(ids, [], scenario.name);
  const modelDiscovery = [];
  const modelSelectedExpansions = [];
  const mcp = new KnowledgeMcpService(mcpBackend(registry));
  for (const selection of scenario.expansions ?? []) {
    let visible = context.envelope.items.find((item) => item.id === selection.id);
    if (visible === undefined && context.envelope.budget.omittedItems > 0) {
      const discovered = await mcp.search({
        query: selection.searchQuery ?? selection.id,
        limit: 8,
        knownItems: context.envelope.items.map((item) => ({
          id: item.id, version: item.version, detailLevel: item.detailLevel,
        })),
      }, context.queryContext, new AbortController().signal);
      visible = discovered.items.find((item) => item.id === selection.id);
      modelDiscovery.push({
        tool: "ckl.search",
        query: selection.searchQuery ?? selection.id,
        omittedItems: context.envelope.budget.omittedItems,
        returnedIds: discovered.items.map((item) => item.id),
        selectedId: selection.id,
      });
    }
    assert.ok(visible, `${scenario.name}: model cannot select invisible pointer ${selection.id}; discovery=${JSON.stringify(modelDiscovery.at(-1))}`);
    assert.ok(visible.detailLevel === "L1_POINTER" || visible.detailLevel === "L2_COMPACT");
    const result = await mcp.get({
      id: visible.id,
      version: visible.version,
      fromDetailLevel: visible.detailLevel,
      targetDetailLevel: selection.targetDetailLevel,
    }, context.queryContext, new AbortController().signal);
    assert.equal(result.items.length, 1, `${scenario.name}: expansion ${selection.id}`);
    const expanded = result.items[0];
    assert.equal(expanded.toDetailLevel, selection.targetDetailLevel, `${scenario.name}: target detail ${selection.id}`);
    if (selection.targetDetailLevel === "L2_COMPACT") {
      assert.ok(!("content" in expanded), `${scenario.name}: L2 must not include content`);
    } else {
      assert.ok("content" in expanded && expanded.content.length > 0, `${scenario.name}: L3 content missing`);
    }
    modelSelectedExpansions.push({
      id: expanded.id,
      fromDetailLevel: expanded.fromDetailLevel,
      toDetailLevel: expanded.toDetailLevel,
      contentIncluded: "content" in expanded,
      evidenceSummaryCount: "evidenceSummary" in expanded ? expanded.evidenceSummary.length : 0,
      compactBoundariesIncluded: "applicability" in expanded,
    });
  }
  return {
    name: scenario.name,
    trigger: { event: "UserPromptSubmit", prompt: scenario.prompt, projectId: scenario.project.projectId },
    queryTerms: {
      paths: context.queryContext.paths.map((item) => item.canonical),
      symbols: context.queryContext.symbols.map((item) => item.canonical),
      errorCodes: context.queryContext.errorCodes.map((item) => item.canonical),
      configKeys: context.queryContext.configKeys.map((item) => item.canonical),
    },
    retrieved: context.retrieval.items.map((item) => ({
      id: item.asset.id,
      rank: item.rank,
      status: item.asset.status,
      scope: item.asset.scope.level,
      channels: item.contributions.map((contribution) => contribution.channel),
    })),
    filtered: context.retrieval.diagnostics
      .filter((item) => item.code === "SCOPE_FILTERED" || item.code === "STATUS_FILTERED")
      .map((item) => ({ code: item.code, assetId: item.assetId })),
    injection: {
      status: injection.status,
      level: context.envelope.complexity.level,
      estimatedTokens: context.envelope.budget.estimatedTokens,
      maxTokens: context.envelope.budget.maxTokens,
      truncated: context.envelope.budget.truncated,
      disclosedItems: context.envelope.budget.disclosedItems,
      omittedItems: context.envelope.budget.omittedItems,
      items: context.envelope.items.map((item) => ({
        id: item.id,
        authority: item.authority,
        detailLevel: item.detailLevel,
        title: item.title,
        summary: item.summary,
        contentIncluded: "content" in item,
        evidenceSummaryCount: "evidenceSummary" in item ? item.evidenceSummary.length : 0,
      })),
    },
    modelDiscovery,
    modelSelectedExpansions,
  };
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "zhiloop-real-injection-simulation-"));
const markdown = new MarkdownKnowledgeRepository(path.join(temporaryRoot, "knowledge"));
let registry;
try {
  const published = [];
  for (const item of knowledge) published.push((await markdown.publish(item, { expectedCurrentVersion: 0 })).value);
  registry = new SqliteKnowledgeRegistryProjection(path.join(temporaryRoot, "registry.sqlite"));
  for (const document of published) registry.projectCurrent(document);

  const rollout = new InjectionRolloutController();
  rollout.activate(1, "ACTIVE", {
    datasetId: "real-session-019f837a-injection-simulation",
    datasetVersion: 1,
    configFingerprint: fingerprintRetrievalConfiguration({
      retrieval: DEFAULT_CONFIGURATION.retrieval,
      injection: DEFAULT_CONFIGURATION.injection,
    }),
    defaultInjectionAllowed: true,
  });

  const results = [];
  for (const [index, scenario] of scenarios.entries()) results.push(await simulate(registry, rollout, scenario, index));
  console.log(JSON.stringify({
    publishedAssets: knowledge.length,
    authoritativeStore: "temporary Markdown current.md + immutable version",
    retrievalProjection: "temporary SQLite FTS + relations; vector disabled for deterministic simulation",
    policy: {
      eligibleStatuses: DEFAULT_CONFIGURATION.retrieval.eligibility.default,
      defaultLevel: DEFAULT_CONFIGURATION.injection.defaultLevel,
      defaultMaxTokens: DEFAULT_CONFIGURATION.injection.defaultMaxTokens,
      hookDeadlineMs: DEFAULT_CONFIGURATION.injection.userPromptDeadlineMs,
    },
    scenarios: results,
  }, null, 2));
} finally {
  registry?.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
