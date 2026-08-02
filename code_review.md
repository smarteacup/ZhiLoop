# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | P3 Gate | 23 次 |
| 耗时 | 300s | 9740s |
| 高风险 | 4 | 65 |
| 中风险 | 5 | 107 |
| 低风险 | 0 | 0 |
| 修复程度 | 9/9（100%） | 100% |

## 改动说明

新增 P3 跨模块 Golden Gate，真实串联 Scope Resolver、Verifier Registry、Evidence Policy 和 Invalidation Engine；固定验证生命周期上限、GLOBAL 晋升、项目隔离、Verifier ERROR 与正文保留。只增加测试、Fixture 和文档，不改变生产 API。

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 测试直接伪造 Evidence 导致 Gate 假绿 | 所有 Evidence 均由真实 Registry 和 typed Probe 生成。 |
| 高 | Project A Candidate/Scope/Evidence 被 Project B 复用 | 同时断言 Scope Resolver 冲突拒绝和 Policy 失败关闭。 |
| 高 | 裸 Project ID 满足 GLOBAL 数量门槛但不可追溯 | 使用结构化 VerifiedProjectEvidenceRef 并断言跨项目 Evidence ID。 |
| 高 | Probe ERROR 被当成 SUPPORTED 或 REFUTED | 抛错场景必须保持 PROPOSED、禁止发布并输出 ERROR reason。 |
| 中 | 只测生命周期正向路径 | 增加 ERROR、证据不足、项目串用、不相关变化负向断言。 |
| 中 | 扫描真实工作区造成不稳定 Gate | Probe 和 ProjectContext 全部版本化、确定性，不读取本机源码。 |
| 中 | Golden 只检查状态、不检查迁移是否合法 | 精确断言 transitionPath。 |
| 中 | STALE 过程中正文被清空或替换 | 对 body 做失效前后逐字比较并断言 preserveBody。 |
| 中 | Fixture 期望随实现悄然漂移 | expected.json 带 schemaVersion，Gate 对关键字段精确匹配。 |

## 配置与兼容性检查

没有删除字段、数据库迁移、环境变量、Hook 或 Daemon 配置。Gate 不读写用户目录、不扫描真实业务仓库，也不调用模型或网络服务。

## Gate 证据

| 检查项 | 结果 |
|---|---|
| P3 专项 | 3/3 测试，7 个组合场景 |
| 全仓 | 342/342 模块；38/38 架构/Gate |
| 整体覆盖率 | Lines 96.97%、Branches 90.36% |
| 供应链 | 0 vulnerabilities |

## Review 结论

P3 Gate 未发现未修复风险。三个 Gate 条件和四类关键负向门禁均满足，可以进入 P4。
