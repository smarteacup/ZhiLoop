# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| **CR 标识** | CKL-203 / MVP Knowledge Compiler |
| **CR 耗时** | 360s |
| **🔴 高风险** | 3 个 |
| **🟡 中风险** | 5 个 |
| **🟢 低风险** | 0 个 |
| **修复程度** | 已修复 8/8（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| **总 CR 次数** | 14 次 |
| **总耗时** | 5320s |
| **🔴 高风险累计** | 22 个 |
| **🟡 中风险累计** | 47 个 |
| **🟢 低风险累计** | 0 个 |
| **平均修复程度** | 100% |

## 改动说明

本次在 CKL-202 端口上新增首个 MVP Compiler。它通过供应商无关 `StructuredGenerationModel` 接收结构化 Episode 输入，并用专用 response Schema/Prompt 生成 REQUIREMENT、DESIGN、DECISION、IMPLEMENTATION、EXPERIENCE 五类草稿。

Candidate 生命周期从隐含约定改为显式 `status: "PROPOSED"`，由 Runner 统一落印，模型无法指定。Compiler/Prompt 版本与实例绑定；五类以外、隐藏字段、版本错配和未验证来源均不能产生部分 Candidate。

没有新增供应商 SDK、凭证、运行配置、数据库或用户目录写入。后续真实模型 Adapter 可以实现同一端口，但不能绕过 Runner Gate。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 🔴 高 | `packages/domain/src/knowledge.ts` / Candidate status | Candidate 仅“语义上视为 proposed”但没有字段，建议可能被下游误当成已接受结论。 | 未确认知识进入正式召回或证据流程 | 增加必填字面量 `status: PROPOSED`；Runner 强制落印，Candidate Schema 拒绝缺失/ACCEPTED。 |
| 增 | 🔴 高 | `packages/knowledge-compiler/src/mvp-compiler.ts` / kind gate | CKL-202 通用 Schema 接受九类知识，仅靠 Prompt 无法保证 MVP 只产生五类。 | 未实现类型穿透、P2 行为不可控 | 专用 Schema 收窄 enum；Adapter 对通用解析后的 kind 再检查，非 MVP 整批 INVALID_OUTPUT。 |
| 增 | 🔴 高 | `packages/knowledge-compiler/src/mvp-compiler.ts` / output | 模型若返回 rationale/analysis 或自行声明状态，可能保存隐藏推理或越权结论。 | 隐私、上下文膨胀、生命周期越权 | Draft 无 status/reasoning 字段，严格 additionalProperties=false；系统指令禁止隐藏推理，额外字段整批失败。 |
| 增 | 🟡 中 | `packages/knowledge-compiler/src/mvp-compiler.ts` / schema ID | 专用 Schema 复制通用 `$id` 后修改 enum，供应商按 ID 缓存时会发生内容冲突。 | Schema 缓存错用、五类门禁失效 | 使用独立 MVP Schema `$id`，并增加断言。 |
| 增 | 🟡 中 | `packages/knowledge-compiler/src/mvp-compiler.ts` / versions | Compiler 实例和 Runner request 版本不一致仍调用模型，会让结果记录错误 Prompt/Compiler 身份。 | 无法重放、幂等批次污染 | 调用前严格匹配 compilerVersion/promptVersion，错配 terminal reject，模型调用次数为 0。 |
| 增 | 🟡 中 | `packages/knowledge-compiler/src/mvp-compiler.ts` / constants | 导出的 MVP kind 数组若可变，Schema 和运行时 Set 可能分叉。 | 类型通路不一致 | 运行时 Object.freeze；Schema 深冻结且从通用 Schema 深拷贝。 |
| 增 | 🟡 中 | `packages/knowledge-compiler/src/input.ts` / lifecycle | OPEN Episode 内容仍可能增长，提前编译会产生过期 Candidate 和新 inputHash 批次噪声。 | 重复编译、知识版本抖动 | 输入投影拒绝 OPEN；允许 COMPLETED/ABANDONED 终态。 |
| 增 | 🟡 中 | `packages/knowledge-compiler/src/mvp-compiler.ts` / model port | 无效 model 对象直到异步调用才 TypeError，会被误判成供应商暂时不可用并重试。 | 无意义重试、诊断错误 | 构造时验证 `generate` 函数和版本格式。 |

## 删除与兼容性检查

- 没有删除现有 Knowledge kind、Schema parser 或 CKL-202 retry/Grounding 行为。
- `KnowledgeCandidate.status` 是新增必填字段；仓库内 Candidate Fixture 和唯一生产构造方已同步，全量 typecheck/245 测试通过。
- 通用 Extraction Schema 仍支持完整九类，只有 MVP Adapter 的深拷贝 Schema 收窄为五类，不影响未来 Compiler。
- OPEN Episode 新增前置拒绝；尚无生产调用方，符合 TDD 的终态 Episode 编译边界。

## 配置检查

本次没有新增模型供应商、API Key、环境开关或 pre/prod/inner 配置，不存在配置迁移项。

## Gate 证据

| 检查项 | 结果 | 结论 |
|---|---|---|
| MVP Compiler 专项 | 8/8 | 通过 |
| Compiler/Schema 相关 | 45/45 | 通过 |
| 架构/Gate | 20/20 | 通过 |
| 全仓模块 | 245/245，22 Test Files | 通过 |
| 五类端到端 | 单批 5 类，全部 PROPOSED | 通过 |
| 覆盖率 | Compiler Lines 94.07%、Branches 89.14%；整体 Lines 97.00%、Branches 89.62% | 通过 |
| 性能 | 100 Candidate 中位 1.87ms、P95 2.35ms | 通过 |
| 供应链 | npm 官方 registry 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- MVP Adapter 为防御性边界会先解析草稿一次，Runner 再做通用原子校验和落印；100 Candidate P95 2.35ms，可接受且远低于模型延迟。
- 专用 response Schema 只在模块加载时深拷贝/冻结一次，不在每个请求重建。
- 真正瓶颈将是供应商网络与 Token 数；Adapter 必须消费 AbortSignal，并由 CKL-202 超时/次数门禁控制。

## 已知边界

- 假模型测试证明契约通路，不代表真实模型五类分类准确率；P2 Gate 需要 Golden Episode。
- Prompt 禁止隐藏推理且 Schema 无对应字段，但可见 body 的语义质量仍需审计和长度门禁。
- Candidate 始终 PROPOSED；CKL-204/证据引擎负责后续接受、否定和验证。
- CodeGraph 尚未初始化；影响范围通过全量 TypeScript、Schema 契约、依赖边界和全仓测试验证。

## Review 结论

CKL-203 未发现未修复风险，四项验收条件全部满足。MVP Compiler 可以进入 CKL-204 用户承诺与纠正检测。
