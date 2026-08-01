# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| **CR 标识** | CKL-003 / JSON Schema |
| **CR 耗时** | 290s |
| **🔴 高风险** | 1 个 |
| **🟡 中风险** | 2 个 |
| **🟢 低风险** | 0 个 |
| **修复程度** | 已修复 3/3（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| **总 CR 次数** | 3 次 |
| **总耗时** | 760s |
| **🔴 高风险累计** | 2 个 |
| **🟡 中风险累计** | 6 个 |
| **🟢 低风险累计** | 0 个 |
| **平均修复程度** | 100% |

## 改动说明

本次变更完成 CKL-003，为 EventEnvelope、KnowledgeCandidate 和 KnowledgeAsset 建立 Draft-07 JSON Schema 与 Ajv 解析器。所有可持久化顶层对象显式携带 `schemaVersion: 1`，不支持的版本返回 `UNSUPPORTED_SCHEMA_VERSION`，缺字段或内容错误返回带 JSON Path 的诊断结果。

顶层未知字段被保存在独立 `extensions` 中，Domain 对象只投影 Schema 已知字段；嵌套对象默认禁止未知字段，自由结构只允许出现在 payload 和 Assertion parameters 等明确容器中。Schema 枚举通过契约测试与 Domain 常量保持一致。

新增 Ajv 8.20、ajv-formats 3.0.1，依赖审计为 0 个高危漏洞。当前 46 个模块测试和 9 个架构测试全部通过。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 🔴 高 | `packages/schemas/src/json/knowledge-candidate.schema.json:80` | 初版 Assertion 只要求 parameters 是对象，且未检查 assertion.candidateId 与外层 Candidate 一致，错误断言可能被交给错误 Verifier 或污染证据。 | 自动知识确认、状态晋级、证据关联 | 已为 9 种 Assertion 定义参数 Schema，并增加跨字段 candidateIdMatch 校验与拒绝测试。 |
| 增 | 🟡 中 | `packages/schemas/src/schema-registry.ts:50` | 初版仅分离顶层未知字段，但嵌套对象允许 additionalProperties，未知字段仍可能进入 Domain；手工 Known Keys 也可能与 Schema 漂移。 | 前向兼容、领域边界、序列化一致性 | 已限制嵌套扩展，并从 Schema properties 自动生成投影键；顶层扩展保留契约测试通过。 |
| 增 | 🟡 中 | `packages/schemas/src/json/event.schema.json:42` | 时间字段只校验非空字符串，非法时间会进入事件排序和生命周期判断。 | Turn 排序、事件回放、版本时间 | 已引入 ajv-formats，对 Event/Candidate/Asset/Assertion 时间统一执行 date-time 校验。 |

## 配置检查

| 配置 | 检查结果 | 结论 |
|---|---|---|
| Schema package 依赖策略 | 仅允许 Domain、Ajv、ajv-formats | 通过 |
| Schema 版本 | 三种根对象均固定 `const: 1` | 通过 |
| 未知字段策略 | 顶层保留 extensions，嵌套默认拒绝 | 通过 |
| Domain/Schema 枚举 | Source、EventType、Kind、Status、Scope、Assertion、Evidence、Relation 均有一致性测试 | 通过 |
| 供应链审计 | npm high audit 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- Ajv Validator 在模块首次加载时编译一次，之后复用，不在每条事件上重复编译。
- EventEnvelope 基准为 100,000 次解析约 802.62ms，即约 124,592 ops/s。
- 当前解析路径只进行 Schema 校验、顶层字段投影和少量跨字段检查，不包含 I/O 或模型调用。
- Schema 体积在构建后约为静态 JSON；未来若类型数量明显增加，应改为 standalone validator 以降低冷启动成本，当前不构成瓶颈。

## Review 结论

CKL-003 未发现未修复风险。版本错误可诊断、未知字段边界清楚、Assertion 参数和跨字段关系已验证，可以进入配置系统实现。
