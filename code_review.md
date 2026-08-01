# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| **CR 标识** | CKL-201 / Episode Builder |
| **CR 耗时** | 420s |
| **🔴 高风险** | 2 个 |
| **🟡 中风险** | 4 个 |
| **🟢 低风险** | 0 个 |
| **修复程度** | 已修复 6/6（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| **总 CR 次数** | 12 次 |
| **总耗时** | 4480s |
| **🔴 高风险累计** | 16 个 |
| **🟡 中风险累计** | 37 个 |
| **🟢 低风险累计** | 0 个 |
| **平均修复程度** | 100% |

## 改动说明

新增 `@zhiloop/episode-builder`，将 Normalized Session/Turn 与 Ledger 正文确定性聚合为 Episode；支持主目标、显式子目标、目标切换、纠错双向保真、动作/产物/结果提取、版本化身份和完整证据引用。同时收紧 Domain 的 Correction 结构，增加 `builderVersion` 与 `subgoals`。

模块不调用模型、不加载 SQLite，只以 type import 依赖 Ledger。真实 SQLite Ledger → Normalizer → Builder 集成重放得到字节一致结果。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 🔴 高 | `packages/episode-builder/src/builder.ts` / prompt | payload 被清理或格式异常时若降级为“无归属活动”，会把缺失用户目标伪装成成功 Episode。 | 错误知识编译、审计失真 | UserPrompt 正文缺失时整次拒绝构建；新增 unavailable prompt 测试。 |
| 增 | 🔴 高 | `packages/episode-builder/src/builder.ts` / evidence | 只按 eventId 查正文、不核对 Normalizer 引用元数据，或允许同一引用重复归属、遗漏额外 Ledger 记录，会让“完全可重建”出现假阳性。 | Episode 串 Session/Turn、证据重复或丢失 | 核对 sequence/source/type/time/session；重复归属、缺失、不一致和未引用记录全部拒绝；真实 Ledger 集成验证全 evidenceRefs。 |
| 增 | 🟡 中 | `packages/episode-builder/src/builder.ts` / truncation | 主 prompt 被两次截断，产生重复诊断；省略号未计入字符上限。 | 诊断噪声、上下文预算越界 | 按 eventId 去重诊断，首目标复用已截断值，省略号计入硬上限；失败测试先复现后修复。 |
| 增 | 🟡 中 | `packages/episode-builder/src/builder.ts` / dedup | Turn 和 Artifact 通过数组 `includes/some` 去重，长会话可能退化为 O(n²)。 | 后台延迟、CPU 放大 | 改为 Set 常数时间去重；10,000 事件/5,000 Turn P95 29.67ms。 |
| 增 | 🟡 中 | `packages/episode-builder/src/builder.ts` / resolver | 自定义 Project Resolver 的非法运行时值或额外字段可能进入 Domain 输出。 | 项目归属错误、未知字段泄漏 | 验证 projectId/portable/可选字符串，只投影 ProjectContext 已知字段。 |
| 增 | 🟡 中 | `packages/episode-builder/src/builder.ts` / classifier | 可替换分类器可能返回非法 kind、空 statement 或在单 Turn 重复主目标，导致静默丢目标。 | Episode 错分或子任务丢失 | 校验分类结果；第二主目标降级为显式 subgoal 并产生诊断。 |

## 删除与兼容性检查

- `Correction.originalRef` 从可选改为必填，并新增原文/新引用字段；全量 TypeScript build 和 211 条测试确认仓库内没有旧构造方遗留。
- `Episode` 新增必填 `builderVersion`、`subgoals`；当前唯一生产构造方为新 Builder，后续 CKL-202 直接消费明确版本结构。
- 未删除现有 Schema、Ledger、Normalizer 行为；P0/P1 全部回归测试保持通过。

## Gate 证据

| 检查项 | 结果 | 结论 |
|---|---|---|
| 模块专项 | 22/22 | 通过 |
| SQLite Ledger 完整重建 | 2 次结果深相等，全部 eventId 可追踪 | 通过 |
| 架构边界 | Builder 无 SQLite/模型运行时依赖 | 通过 |
| 全仓质量 | 211 模块 + 16 架构/Gate | 通过 |
| 覆盖率 | Builder Lines 96.63%、Branches 86.28%；整体 Lines 97.61%、Branches 89.71% | 通过 |
| 性能 | 10,000 events 中位 24.20ms、P95 29.67ms | 通过 |
| 供应链 | npm 官方 registry 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- 主路径为 O(E + T) 校验/提取和 O(E log E) Episode 内稳定排序；Turn/Artifact 去重已消除平方级扫描。
- 默认会完整持有 Ledger records、Normalized refs 和 Episode 派生数组。百万级历史不应单批全量构建，后续 Worker 应按 Session/游标分片并物化结果。
- 默认分类器是常量数量正则；替换为模型分类器时不得放进本纯函数同步主路径，应由可重放的外部分类结果或独立端口提供。

## 已知边界

- 显式词规则不能覆盖所有自然语言目标变化；歧义保守落为 subgoal，避免误拆。
- 首版不跨 Session 合并，未来必须依赖显式 task/topic reference 和二次闭环验证。
- 工具 Outcome 只承认机器可见 exit code/status；自然语言成功结论仍标为 UNKNOWN。
- CodeGraph 尚未在仓库初始化，结构化影响扫描不可用；已由依赖边界、TypeScript 全量编译与全仓回归覆盖当前影响验证。

## Review 结论

CKL-201 未发现未修复风险，四项验收条件全部满足。Episode Builder 可以作为 P2 的稳定输入边界，下一步进入 CKL-202 Knowledge Extraction Port。
