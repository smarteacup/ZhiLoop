# CKL-203 MVP Knowledge Compiler

## 1. 目标与边界

CKL-203 在 `@zhiloop/knowledge-compiler` 中实现首个可用的语义提取适配器 `MvpKnowledgeCompiler`。它通过 CKL-202 的 `StructuredGenerationModel` 端口调用任意支持结构化生成的模型，并且只允许输出：

```text
REQUIREMENT | DESIGN | DECISION | IMPLEMENTATION | EXPERIENCE
```

本模块不绑定供应商 SDK、不持久化 Candidate、不验证断言真假、不发布或召回知识。模型负责提出语义草稿；CKL-202 Runner 继续负责超时重试、原子校验、Grounding、身份和元数据。

## 2. 模型端口

```ts
interface StructuredGenerationModel {
  generate(
    request: StructuredGenerationRequest,
    context: StructuredGenerationContext,
  ): Promise<unknown>;
}
```

请求将系统指令、结构化 Episode 输入和 response Schema 分开，避免把用户对话拼进系统指令。Context 只包含 extractionKey、inputHash、attempt 和 AbortSignal，不包含模型供应商或凭证。

`MvpKnowledgeCompiler` 默认绑定：

- `compilerVersion = mvp-compiler-v1`
- `promptVersion = mvp-extraction-prompt-v1`

Runner request 的版本必须与 Compiler 实例完全匹配；错配直接 `FAILED/ADAPTER_REJECTED`，不会在错误的幂等身份下运行另一版 Prompt。

## 3. 五类语义

| Kind | 提取边界 |
|---|---|
| `REQUIREMENT` | 明确需求、约束、门禁或不可违反的边界 |
| `DESIGN` | 架构、技术方案或组件协作方式 |
| `DECISION` | 在备选项中已经选择的结论 |
| `IMPLEMENTATION` | 可从代码、文件或行为验证的实现事实 |
| `EXPERIENCE` | 可复用的问题、方案和可观察结果经验 |

同一 Episode 可以输出多个 Candidate，也可以输出多个同类 Candidate；问候、继续确认、临时进度和无证据猜测不应生成 Candidate。空数组是合法的“没有耐久知识”结果。

通用 CKL-202 Schema 支持完整九类知识；MVP Compiler 会复制它并把 kind enum 收窄为五类，同时使用独立 `$id`：

```text
https://zhiloop.dev/schemas/mvp-knowledge-extraction-output/v1
```

即使模型绕过供应商的 response schema 返回结构正确的 `FACT/RULE/...`，Adapter 也会将整批标记为可重试 `INVALID_OUTPUT`，不会让非 MVP 类型穿透。

## 4. PROPOSED 状态

`KnowledgeCandidate.status` 现在是必填字面量：

```ts
status: "PROPOSED"
```

模型草稿中不存在 status 字段，严格 Schema 也不允许模型提供它。Runner 在落印时统一写入 `PROPOSED`。因此建议、方案和模型生成内容不可能仅凭措辞成为 `ACCEPTED`、`IMPLEMENTED` 或 `VERIFIED`；后续状态只能由用户承诺检测、代码证据和 Evidence Engine 推进。

既有 Candidate Schema 同步要求 `status=PROPOSED`，缺失或伪造为 `ACCEPTED` 都会被拒绝。

## 5. 纠错、证据与隐藏推理

系统指令明确要求：

- 用户 correction 中的新内容是当前权威陈述；被纠正内容不能作为当前知识重新输出；
- 只能使用 `input.evidenceRefs` 中的 sourceRef；
- Assertion 只是待验证检查，不能自证；
- 不得虚构文件、符号、命令、项目、测试或用户接受；
- 只输出简洁结论和可观察事实，不输出隐藏推理、chain-of-thought、analysis、rationale、Prompt 或模型元数据。

草稿 Schema 顶层和嵌套对象均 `additionalProperties=false`，也没有 reasoning/rationale 字段。模型若返回额外解释，整批原子失败。`body` 是可见知识正文，不是隐藏思维存储通道；具体 Adapter 仍必须使用系统指令约束其内容。

## 6. 失败与安全边界

- 模型异常由 CKL-202 Runner 按不可用错误重试；
- malformed JSON/对象由通用 Schema 产生路径诊断；
- 非 MVP kind 由 Adapter 转成 `INVALID_OUTPUT`；
- Compiler/Prompt version 错配和无效 Model port 在调用前失败；
- Model request、MVP kind 列表和 response Schema 均被冻结；
- 专用 Schema 是通用 Schema 的深拷贝，不会污染 Schema Registry。

只有终态 Episode 能进入输入投影：`OPEN` Episode 会被拒绝，`COMPLETED` 和 `ABANDONED` 可编译。后者允许保留失败路径中的可复用 Experience，同时避免内容仍在增长时提前编译。

## 7. 验证与性能

- 8 条 MVP Compiler 专项测试覆盖五类单批输出、多同类 Candidate、专用 Schema/Prompt、PROPOSED、非 MVP 拒绝、隐藏字段拒绝、版本错配、模型重试和构造参数。
- Candidate Schema 增加 PROPOSED 正反契约；Input 增加 OPEN Episode 门禁测试。
- Node 架构/Gate 增加五类端到端假模型验证；Compiler 生产源码继续无供应商 SDK、存储、文件系统或子进程依赖。
- 全仓 245 条模块测试、20 条架构/Gate 测试通过。
- Knowledge Compiler：Lines 94.07%、Branches 89.14%、Functions 91.83%；`mvp-compiler.ts` Lines 100%、Functions 100%。
- Node.js 25.8.1，假模型单批 100 Candidate、50 次样本：中位 1.87ms、P95 2.35ms，约 53,530 candidates/s；不含模型网络时间。
- npm 官方 registry 审计：0 vulnerabilities。

## 8. 已知边界

- 当前只有供应商无关端口和 Prompt/Schema 契约，没有真实远程模型 Adapter 或凭证配置。
- 类型语义质量需要 P2 Gate 的版本化 Golden Episode 评估；当前测试证明契约与五类通路，不声称衡量真实模型准确率。
- Candidate 始终是 PROPOSED；用户接受/否定、纠错证据生成属于 CKL-204。
- 断言和 Evidence hint 的真实性由后续 Evidence Engine 验证，模型置信度不能提升生命周期状态。
- 本模块未安装 Hook、未启动 Daemon，也未读写 `~/.ckl`、`~/.codex` 或 `~/.ccm`。
