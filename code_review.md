# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | `main@024e920+structured-output-v2` |
| CR 耗时 | 420s |
| 🔴 高风险 | 1 个 |
| 🟡 中风险 | 0 个 |
| 🟢 低风险 | 0 个 |
| 修复程度 | 已修复 1/1（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 46 次 |
| 总耗时 | 22650s |
| 🔴 高风险累计 | 221 个 |
| 🟡 中风险累计 | 304 个 |
| 🟢 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次变更修复真实 Codex Structured Outputs 调用被服务端拒绝的问题。知识编译器现在会从领域 Schema 生成 Codex 严格 Schema：对象属性全部 required、可选字段使用 nullable `anyOf`、对象关闭额外字段、断言联合改为受支持的 `anyOf`，并在领域二次校验前移除 `null` 占位。

候选业务契约没有放宽：模型输出仍需通过原有 `knowledge-extraction-output` Schema，候选仍只会物化为 `PROPOSED`。同时强化 `subjectKey` 格式契约，并将 compiler、prompt 与响应 Schema 标识统一升级为 v2，避免旧幂等记录错误复用。

对外接口和配置文件没有变化；兼容性边界是 v1 与 v2 使用不同抽取身份，已有 v1 结果保留，新请求按 v2 重新编译。

## 风险矩阵

| 维度 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增/重构 | 🔴 高 | `packages/knowledge-compiler/src/mvp-compiler.ts:21` | Schema 与提示已变化但版本仍为 v1，且 `$id` 仍指向 v1，可能命中旧幂等结果并破坏审计可复现性。 | 候选仓库 claim、重放、Schema 缓存与知识来源审计。 | compilerVersion、promptVersion、Schema `$id` 全部升级为 v2，文档同步；已修复。 |

## 配置检查

本次 diff 不包含 `.properties`、`.yml`、`.yaml` 或运行时配置变更，无 pre/prod/inner 配置迁移项。

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 真实 Transcript | 2355 行、5.76 MB、0 malformed；投影 90 个公开事件 |
| Ledger 幂等 | 首次 90 appended；复读 90 duplicate |
| 真实 Codex 编译 | Structured Outputs Schema 被服务端接受；单次成功生成 6–8 个候选 |
| 候选仓库 | `ACQUIRED → IN_PROGRESS → SUCCEEDED → ALREADY_SUCCEEDED` |
| 生命周期门禁 | 全部候选为 `PROPOSED`；默认正式召回 0，审计视图可见 |
| 模块测试 | knowledge-compiler 9/9 |
| 全仓 Gate | 51/51 架构/Gate；624/624 模块测试 |
| 覆盖率 | Lines 96.86%、Branches 89.77%、Functions 97.97% |

## Review 结论

本次发现的 1 个高风险版本治理问题已闭环，无遗留 actionable finding。严格 Schema 经过真实 Codex 服务端接受、业务 Schema 二次校验、候选仓库幂等与全仓测试验证，可以合入。
