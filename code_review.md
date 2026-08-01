# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| **CR 标识** | CKL-002 / Domain |
| **CR 耗时** | 260s |
| **🔴 高风险** | 1 个 |
| **🟡 中风险** | 2 个 |
| **🟢 低风险** | 0 个 |
| **修复程度** | 已修复 3/3（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| **总 CR 次数** | 2 次 |
| **总耗时** | 470s |
| **🔴 高风险累计** | 1 个 |
| **🟡 中风险累计** | 4 个 |
| **🟢 低风险累计** | 0 个 |
| **平均修复程度** | 100% |

## 改动说明

本次变更完成 CKL-002 Domain，定义 Event、Episode、Knowledge Candidate/Asset、Scope、Evidence、Assertion、Relation 与知识生命周期。所有领域对象不依赖 Node、Codex、存储或模型 SDK，状态迁移、Scope 校验和 GLOBAL 晋升均为无副作用纯函数。

候选知识通过类型联合保证至少具有一个 Assertion 或 Evidence Hint；已解析 Scope 使用可判别联合限制不同层级的必填字段。GLOBAL 晋升只接受用户明确确认，或两个不同项目的验证证据；RULE/PREFERENCE 必须由用户明确确认。

同时补充源码 AST 导入检查、测试类型检查和 35 个 Domain 测试。Domain 行覆盖率 93.84%、分支覆盖率 93.87%，满足 P0 Gate。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 🔴 高 | `packages/domain/src/promotion.ts:20` | 初版跨项目晋升没有区分知识类型，可能将 RULE/PREFERENCE 在没有用户确认时提升为 GLOBAL。 | 全局知识污染、跨项目错误门禁 | 已增加 KnowledgeKind 门禁，RULE/PREFERENCE 只能通过用户明确确认晋升，并补充正反测试。 |
| 增 | 🟡 中 | `packages/domain/src/state-machine.ts:3` | 原设计未允许 IMPLEMENTED/VERIFIED/STALE 被新版本 SUPERSEDED，且 ACCEPTED 无法在用户撤销后 REJECTED。 | 知识版本更新、撤销与生命周期卡死 | 已同步修订 TDD 和状态机，49 条状态组合全部覆盖。 |
| 增 | 🟡 中 | `scripts/check-source-imports.mjs:1` | 仅检查 package.json 依赖不足以阻止 Domain 从根 hoisted devDependency 或 Node 内置模块导入代码。 | 领域层可移植性、适配器隔离 | 已增加 TypeScript AST 源码导入检查和 4 个正反测试；Domain 只允许相对导入。 |

## 配置检查

| 配置 | 检查结果 | 结论 |
|---|---|---|
| Domain package 依赖策略 | workspace/external allowlist 均为空 | 通过 |
| Domain tsconfig | `types: []`，无 Node 全局类型 | 通过 |
| 测试类型检查 | `tsconfig.test.json` + `npm run typecheck:test` | 通过 |
| Coverage Gate | Lines 93.84%、Branches 93.87% | 通过 |
| 生产/预发配置 | 本模块未引入运行时环境配置 | 不适用 |

## 性能与瓶颈复盘

- 状态迁移和默认召回资格判断为 O(1)。
- Scope 校验仅遍历当前对象字段和少量 symbols/modulePaths，为 O(n)，无 I/O。
- GLOBAL 晋升只对 projectId 去重，为 O(n) 时间与空间；输入规模受 Evidence Policy 限制，不构成瓶颈。
- Domain 导入检查只在 CI/本地 Gate 执行，不进入运行时路径。

## Review 结论

CKL-002 未发现未修复风险。状态、Scope、GLOBAL 晋升和模块隔离均有拒绝路径测试，可以进入 JSON Schema 与版本规则实现。
