# ZhiLoop Code Review

## 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | CKL-302 / Scope Resolver |
| CR 耗时 | 480s |
| 高风险 | 5 个 |
| 中风险 | 7 个 |
| 低风险 | 0 个 |
| 修复程度 | 已修复 12/12（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 19 次 |
| 总耗时 | 7840s |
| 高风险累计 | 45 个 |
| 中风险累计 | 79 个 |
| 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次新增 `@zhiloop/scope-resolver`，把 Candidate 提示与可信 Project/Task/User/Team 上下文解析为七级 Knowledge Scope。解析固定选择最小可证明边界，不确定、冲突或不安全输入统一回退 PROJECT。

对外新增纯函数 `resolveKnowledgeScope` 及输入/输出类型，不修改既有 Domain Schema 或 Candidate 状态。USER/TEAM/GLOBAL 需要独立可信授权且不得包含项目特征；GLOBAL Scope 只是边界结果，不能替代 CKL-304 的发布与晋升策略。

同时补充专项、架构和 Project Identity 集成测试，并将新 workspace 纳入 Project References、依赖边界与全仓覆盖率 Gate。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 高 | `resolver.ts` / trusted identity | 直接相信 Candidate 内 taskId/userId/teamId 会让模型自行扩大知识边界。 | 跨任务、用户或团队污染 | 仅接受调用方可信 ID 且要求精确匹配；否则回退 PROJECT。 |
| 增 | 高 | `resolver.ts` / project binding | Candidate projectId/remote 与运行项目冲突时继续解析会错绑知识。 | 两项目隔离、后续证据验证 | 冲突立即报错，不静默覆盖。 |
| 增 | 高 | `resolver.ts` / symbol assertion | 其他项目的 SYMBOL_EXISTS Assertion 可能被用于当前项目 SYMBOL Scope。 | 跨项目证据串用 | Assertion projectId 必须等于可信 ProjectContext，否则失败关闭到 PROJECT。 |
| 增 | 高 | `resolver.ts` / partial normalization | 混合合法与非法 symbol/path 若只保留合法部分，会隐藏模型输出错误。 | Scope 误缩小、审计信息丢失 | 任一非法项、显式空 SYMBOL/MODULE 目标都整体回退 PROJECT，并输出理由码。 |
| 增 | 高 | `resolver.ts` / GLOBAL business term | 项目业务名门禁依赖调用方传 projectTerms，漏传时可能错误 GLOBAL。 | 项目知识泄露到全局召回 | 从 normalized remote/root 自动提取项目名；projectTerms 仅补充别名。 |
| 增 | 中 | `resolver.ts` / precedence | SYMBOL、MODULE 和向上 Scope 同时出现时，分支顺序不稳定会产生不同结果。 | 幂等重放、可解释性 | 固定 TASK→SYMBOL→MODULE→PROJECT/向上授权顺序，并对输出去重/排序/冻结。 |
| 增 | 中 | `resolver.ts` / project signals | 只检查 path/symbol 会漏掉实现、配置、命令、测试等项目绑定内容。 | USER/TEAM/GLOBAL 误扩大 | 汇总 kind、Assertion、Evidence Hint、路径、项目名六类信号。 |
| 增 | 中 | `resolver.ts` / GLOBAL semantics | `allowGlobal` 可能被上层误解为自动发布许可。 | 绕过 Evidence Policy | 接口文档与理由码明确这里只解析 Scope；Candidate 仍为 PROPOSED，CKL-304 独立决策。 |
| 增 | 中 | `resolver.ts` / unsafe paths | 绝对路径、Windows drive 或 `..` module path 可越出项目。 | 后续文件验证越界 | 只输出规范化安全相对路径，拒绝空 segment、absolute、drive 和 traversal。 |
| 增 | 中 | `resolver.ts` / alias quality | 过短 projectTerms 容易命中普通词并阻止所有向上 Scope。 | 召回边界过度收窄 | 外部别名限制 3～200 字符；自动项不满足长度时忽略。 |
| 增 | 中 | package/tsconfig/coverage | 新 workspace 未纳入依赖图、build 或 coverage 会形成假绿。 | CI 完整性 | Project Reference、lockfile、依赖 allowlist、coverage include 全部更新，14 workspace Gate 通过。 |
| 增 | 中 | `resolver.ts` / hot path | Scope 解析若引入模型、I/O 或高复杂度匹配会拖慢后台处理。 | Daemon 吞吐 | 保持纯同步集合/字符串策略；中位约 109 万 decisions/s，无 I/O 依赖。 |

## 删除与兼容性检查

- 没有删除或修改现有 Domain Scope/ScopeHint/ProjectContext 字段，也没有改变 Candidate Schema、状态机或默认召回状态。
- 新增 API 是独立 workspace 导出；尚无生产 Scope Resolver 调用方，因此不存在旧行为迁移。
- Scope Hint 仍可携带 projectId/remote 作为来源绑定，但它们与可信 ProjectContext 不一致时从“可忽略提示”收紧为显式错误，这是预期安全约束。
- 没有 Hook、Daemon、数据库 migration、用户目录或运行配置变更。

## 配置检查

没有新增环境变量、YAML/properties、网络地址、模型参数或用户配置。`allowGlobal` 和可信 ID 是单次函数输入，不是可绕过的全局配置；调用方仍受后续 Evidence Policy 约束。

## Gate 证据

| 检查项 | 结果 | 结论 |
|---|---|---|
| Scope Resolver 专项 | 13/13 | 通过 |
| 架构/集成 Gate | 29/29 | 通过 |
| 全仓模块 | 298/298，26 Test Files | 通过 |
| 覆盖率 | Resolver Lines 97.89%、Branches 89.83%、Functions 100%；整体 Lines 96%+ | 通过 |
| 性能 | 10,000 次中位9.117ms、P95 10.658ms，约1,096,802 decisions/s | 通过 |
| 供应链 | npm 官方 registry 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- Resolver 每次只扫描一个 Candidate 的少量 symbols、module paths、assertions、evidence hints 和项目词，时间复杂度为输入字段总长度的线性量级。
- 当前基准约 0.91 微秒/次；相比后续模型、SQLite 和代码验证开销可以忽略，不需要缓存。
- `projectTerms` 数量和正文长度由上游 Schema/Policy 控制；若后续允许大规模别名字典，应改为预编译 matcher，而不是继续线性逐词扫描。

## 已知边界

- symbol/path 只完成边界和语法判断，不证明源码存在；CKL-303 才产生 SUPPORTED/REFUTED/UNKNOWN/ERROR Evidence。
- 自动项目名可能是通用目录名，当前选择保守阻止向上扩大，不会造成跨项目泄露。
- CodeGraph 尚未初始化；本次影响范围通过依赖边界、专项攻击输入、真实 Project Identity 集成和全仓回归验证。

## Review 结论

CKL-302 未发现未修复风险，四项验收条件全部满足。可以进入 CKL-303 Verifier Registry 和 MVP Verifiers。
