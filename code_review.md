# ZhiLoop Code Review

## 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | CKL-303 / Verifier Registry 和 MVP Verifiers |
| CR 耗时 | 560s |
| 高风险 | 5 个 |
| 中风险 | 8 个 |
| 低风险 | 0 个 |
| 修复程度 | 已修复 13/13（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 20 次 |
| 总耗时 | 8400s |
| 高风险累计 | 50 个 |
| 中风险累计 | 87 个 |
| 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次新增 `@zhiloop/evidence-engine`，以唯一 Registry 路由七类 MVP Verifier，并把 typed Probe 观察转换成四态 VerificationResult 与三态 Evidence verdict。核心变化是将“外部事实采集”和“证据契约/故障隔离”分层，使未来 filesystem、code、config、command/test Adapter 可以替换而不改变策略语义。

对外新增 Registry、Verifier、Probe、Observation 和 Result 类型，不修改 Domain Assertion/Evidence 字段或 Candidate 状态。Command/Test 只核验已有事件，不执行命令；CROSS_PROJECT_VERIFIED 暂不注册，明确 UNKNOWN，后续由 Evidence Policy 聚合。

同时新增专项、架构和 Project Identity 集成测试，将第 15 个 workspace 纳入 build、依赖图、lockfile 和 coverage Gate。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 高 | `registry.ts` / plugin dispatch | 第三方 Verifier 抛异常会 reject Promise.all，导致整批 Evidence 丢失。 | 后台批次重试、其他 Assertion 饥饿 | Registry 二次异常隔离，单项返回 ERROR 且不泄漏异常文本。 |
| 增 | 高 | `registry.ts` / result contract | 插件可返回 SUPPORTED 但省略/伪造 Evidence，或错绑 assertionId/projectId。 | 生命周期误晋升、跨项目污染 | 校验 status/verdict/type/assertion/project/correlation/time/target/source/reason 全契约；违规转 ERROR。 |
| 增 | 高 | `verifiers.ts` / symbol project | SYMBOL_EXISTS 可携带其他项目 projectId。 | 跨项目代码证据串用 | Probe 调用前强制等于可信 ProjectContext。 |
| 增 | 高 | `verifiers.ts` / file targets | path traversal、absolute/drive path 可诱导 Adapter 越出仓库。 | 本地敏感文件读取 | 所有 symbol/file/manifest/config/test path 使用统一 canonical relative path 门禁。 |
| 增 | 高 | Command/Test semantics | Verifier 若直接运行 Assertion 中描述的命令会形成模型驱动 RCE/副作用。 | 本地命令执行、状态漂移 | 端口只按 commandHash/testId 查询当前 Turn 已记录结果；模块无 process/filesystem 能力。 |
| 增 | 中 | `registry.ts` / duplicate registration | 两个 Verifier 争抢同一 kind 会让加载顺序决定结果。 | 非确定性 Evidence | 注册阶段拒绝跨 Verifier 和单 Verifier 内重复 kind。 |
| 增 | 中 | `verifiers.ts` / UNKNOWN | Probe 缺失若当 ERROR 或 REFUTED，会错误否定知识。 | Candidate 状态与交互策略 | 缺能力固定 UNKNOWN 且不造 Evidence；不确定观察才生成 INCONCLUSIVE。 |
| 增 | 中 | `verifiers.ts` / observation target | Adapter 返回另一目标的正确结果可能被当前 Assertion 使用。 | 证据错绑 | Observation target 必须与 Verifier 计算的 canonical target 完全一致。 |
| 增 | 中 | `verifiers.ts` / metadata bounds | 超长/控制字符 details、sourceRef、reason 可污染日志或放大存储。 | 可观测性、隐私、内存 | 字段格式、长度、条数和有限数值门禁；错误文本不进入结果。 |
| 增 | 中 | `verifiers.ts` / evidence identity | Evidence ID 未覆盖 details/reason/project/correlation 时，不同观察可能碰撞。 | 证据幂等与覆盖 | 128-bit 确定性 identity 覆盖完整观察与归属字段。 |
| 增 | 中 | `registry.ts` / concurrency order | 并发 Probe 完成顺序若改变输出顺序，会破坏重放和批次对应。 | 幂等、审计 | Promise.all 保留输入顺序，并有乱序完成回归测试。 |
| 增 | 中 | `verifiers.ts` / mutable output | Adapter 或调用方修改 Evidence 可改变后续 Policy 结论。 | 状态决策一致性 | Result、Evidence、details、reasonCodes 递归冻结。 |
| 增 | 中 | workspace/coverage | 新包未纳入 root references 和 coverage 会形成 CI 假绿。 | 构建与测试完整性 | 15 workspace 依赖 Gate、root build、lockfile、coverage include 全部更新。 |

## 删除与兼容性检查

- 没有删除或修改 Domain 的九类 Assertion、Evidence、Candidate 或状态机字段。
- 新模块没有既有生产调用方；CROSS_PROJECT_VERIFIED 返回 UNKNOWN 是显式未实现能力，不改变其 Domain 表达。
- Probe 是新增端口，后续 Adapter 必须返回 canonical target/source event；不允许通过宽松兼容绕过 Registry 校验。
- 没有 SQLite migration、Hook、Daemon、环境变量或用户配置变更。

## 配置检查

没有新增 properties/YAML、功能开关、模型 endpoint、命令白名单或用户目录。所有能力通过显式 `VerificationContext.probes` 注入；缺失 Probe 安全返回 UNKNOWN。

## Gate 证据

| 检查项 | 结果 | 结论 |
|---|---|---|
| Evidence Engine 专项 | 17/17 | 通过 |
| 架构/集成 Gate | 31/31 | 通过 |
| 全仓模块 | 315/315，27 Test Files | 通过 |
| 覆盖率 | Engine Lines 98.13%、Branches 92.30%、Functions 100%；整体 Lines 96.92%、Branches 90.01% | 通过 |
| 性能 | 1000 Assertion 中位6.332ms、P95 7.734ms，约157,916 assertions/s | 通过 |
| 供应链 | npm 官方 registry 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- Registry 的计算主要是路由、字段校验、Evidence ID 和冻结；1000 条异步 Assertion P95 低于 8ms。
- 实际瓶颈会位于 filesystem/code/config Probe I/O。Daemon 应按 project snapshot 批量读取 manifest/config，并对相同 source event 去重，而不是削弱 Registry 门禁。
- verifyAll 并发启动全部 Probe；未来批次上限超过 Candidate 的 100 Assertion 门禁时，应在 Worker 层增加并发池，避免文件描述符峰值。

## 已知边界

- 当前没有 Node filesystem/code/config/dependency Adapter；CKL-303 完成的是稳定验证端口和证据契约。
- REGEX/STRUCTURAL 的资源限制必须由 Adapter 实现；禁止无超时执行模型生成正则。
- CodeGraph 尚未初始化；影响范围通过依赖边界、攻击输入、插件伪造、真实 Project Identity 集成和全仓回归验证。

## Review 结论

CKL-303 未发现未修复风险，四项验收条件全部满足。可以进入 CKL-304 Evidence Policy Engine。
