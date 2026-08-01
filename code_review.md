# ZhiLoop Code Review

## 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | CKL-304 / Evidence Policy Engine |
| CR 耗时 | 620s |
| 高风险 | 6 个 |
| 中风险 | 8 个 |
| 低风险 | 0 个 |
| 修复程度 | 已修复 14/14（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 21 次 |
| 总耗时 | 9020s |
| 高风险累计 | 56 个 |
| 中风险累计 | 95 个 |
| 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次新增 `@zhiloop/evidence-policy`，将 Scope、VerificationResult、当前状态和版本化策略折叠为唯一 EvidencePolicyDecision。核心行为是只有用户、代码或测试 Evidence 能推进状态，所有路径复用 Domain 状态机，模型内容本身永久停留 PROPOSED。

对外新增状态 action、interaction、transitionPath、effectiveScope、shouldPublish、Evidence refs 和 reason codes。GLOBAL 晋升从裸项目计数收紧为可追溯 VerifiedProjectEvidenceRef；未满足门禁时保留 PROJECT 发布能力，并只在知识具备发布资格后询问。

模块没有持久化或外部 I/O，新增专项、架构与 Project→Scope→Verifier→Policy 全链测试，并纳入第 16 个 workspace 的 build/coverage Gate。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 高 | `policy.ts` / model-only | 把 Candidate 置信度或模型措辞当 Evidence 会直接发布幻觉。 | 全部知识生命周期 | 无 Evidence 固定 PROPOSED/不发布；Candidate status 必须仍为 PROPOSED。 |
| 增 | 高 | `policy.ts` / error semantics | ERROR/UNKNOWN 若按失败或成功聚合，会错误否定或晋升知识。 | 状态、交互、召回 | 四态分别处理；ERROR 无 Evidence，UNKNOWN 不推进，REFUTED 单独阻断。 |
| 增 | 高 | `policy.ts` / transition | PROPOSED 直接写 VERIFIED 绕过 Domain 状态机。 | 审计和状态不变量 | BFS 生成合法路径并逐边调用 transitionKnowledgeStatus 复核。 |
| 增 | 高 | `policy.ts` / code cap | IMPLEMENTATION 同时有测试时可能被自动抬到 VERIFIED。 | 未经策略允许的强权威知识 | 配置和运行时双门禁把 IMPLEMENTATION 上限固定 IMPLEMENTED。 |
| 增 | 高 | `policy.ts` / global evidence | 裸 verifiedProjectIds 可无来源自证跨项目阈值。 | GLOBAL 污染 | 改为 subject/evidence/source/time 完整的 VerifiedProjectEvidenceRef，并去重项目。 |
| 增 | 高 | `policy.ts` / evidence binding | 错 assertion/type/project/correlation 的 Evidence 可推进当前 Candidate。 | 跨 Candidate/项目证据串用 | Policy 再次验证 Result/Evidence 全归属，malformed 输入失败关闭到 PROJECT。 |
| 增 | 中 | `policy.ts` / required assertions | 只验证同 kind 的一个 Assertion 会忽略同类其他未验证目标。 | 部分实现被当完整实现 | required kind 必须存在，且该 kind 的全部 Candidate Assertion 都 SUPPORTED。 |
| 增 | 中 | `policy.ts` / terminal states | 重算 REJECTED/SUPERSEDED 可能触发无意义确认或非法复活。 | 用户打扰、状态回退 | 终态固定 KEEP；STALE 仅新 VERIFIED Evidence 恢复。 |
| 增 | 中 | `policy.ts` / early global prompt | PROPOSED 知识一提出 GLOBAL 就询问，形成确认噪声。 | 交互频率与用户遗漏 | GLOBAL 询问延迟到本地状态已具备发布资格；此前静默 PROJECT fallback。 |
| 增 | 中 | `policy.ts` / conflicts | 用户同时接受和拒绝或已发布知识冲突时自动选一方。 | 决策覆盖、知识分叉 | 统一 ASK_USER，不迁移，每次决策最多一个 interaction。 |
| 增 | 中 | `policy.ts` / policy weakening | 调用方传入弱化 requiredAssertions 或更高 maxStatus 可绕过默认配置。 | 自动发布门槛 | 运行时重验 SYMBOL/TEST 必选、maxStatus、问题上限和默认 Scope。 |
| 增 | 中 | `policy.ts` / duplicate results | 重复/extra VerificationResult 可能重复计数或覆盖查找结果。 | Evidence 聚合确定性 | Assertion/Result 唯一性、kind、candidateId 和归属全部校验。 |
| 增 | 中 | `policy.ts` / repeat publish | 状态已相同时 shouldPublish 仍为 true 会写重复版本。 | Markdown/SQLite 版本噪声 | 只有合法 transitionPath 非空时产生发布意图。 |
| 增 | 中 | workspace/performance | 新策略进入后台批次后可能形成 CPU 瓶颈或 CI 假绿。 | Worker 吞吐、覆盖率 | 纯线性集合策略约66.8万 decisions/s；root refs、依赖和 coverage 全纳入。 |

## 删除与兼容性检查

- 没有删除或修改 Domain 状态、Assertion、Evidence、Scope 或 CKL-303 Result 类型。
- 新模块无既有生产调用方；`verifiedProjectIds` 在提交前已收紧为首次发布的 VerifiedProjectEvidenceRef，不存在迁移负担。
- 状态决策只输出意图，不修改 Candidate Repository；后续存储必须把状态路径、Evidence 和发布原子提交。
- 没有数据库 migration、Hook、Daemon、环境变量或用户配置变更。

## 配置检查

复用 CKL-004 的 `VerificationPolicy`，没有新增配置项。运行时再次确认 IMPLEMENTATION/EXPERIENCE 上限、必选 Assertion、GLOBAL 阈值 2～20、每 Turn 最多一个问题和 PROJECT 默认值，防止绕过已验证配置对象。

## Gate 证据

| 检查项 | 结果 | 结论 |
|---|---|---|
| Evidence Policy 专项 | 15/15 | 通过 |
| 架构/集成 Gate | 33/33 | 通过 |
| 全仓模块 | 330/330，28 Test Files | 通过 |
| 覆盖率 | Policy Lines 97.12%、Branches 92.26%、Functions 100%；整体 Lines 96.93%、Branches 90.20% | 通过 |
| 性能 | 10,000 次中位14.977ms、P95 17.758ms，约667,698 decisions/s | 通过 |
| 供应链 | npm 官方 registry 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- 单 Candidate 的复杂度与 Assertion、Result、跨项目 Evidence 数量线性相关；上游每 Candidate 100 Assertion 上限使成本可控。
- 当前纯策略约 1.5 微秒/次，远低于 Probe I/O 和模型编译，不需要缓存。
- `supported` 对 required kind 使用线性查找；在 100 条上限内无瓶颈。若未来放宽到千级，应预构建 resultByAssertion Map。

## 已知边界

- 原子状态/发布提交尚未实现，CKL-401/Registry 装配必须避免“状态已变但 Markdown 未写”的部分成功。
- conflictIds 与 VerifiedProjectEvidenceRef 依赖可信聚合器，模型不能直接提供。
- CKL-305 才处理代码指纹和 STALE 触发。
- CodeGraph 尚未初始化；本次通过状态组合、恶意配置/Evidence、全链集成和全仓回归确认影响范围。

## Review 结论

CKL-304 未发现未修复风险，五项验收条件全部满足。可以进入 CKL-305 代码指纹与失效检测。
