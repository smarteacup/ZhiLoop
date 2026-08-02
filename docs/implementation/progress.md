# ZhiLoop 实施进度与验证记录

**当前里程碑**：MVP 源码基线完成并通过最终验收  
**记录日期**：2026-08-02  
**运行状态**：未安装 Hook、未启动 Daemon、未修改用户 Codex/CCM 配置

## 1. 模块交付记录

测试数量为各提交完成时的累计值；每个模块均在实现后先自测，再完成独立风险 Review，最后提交到 `main`。

| 模块 | 状态 | 提交 | 主要交付 | 自测与 Review |
|---|---|---|---|---|
| CKL-001 | 完成 | `99641d8` | npm Workspace、TypeScript、ESLint、Vitest、依赖边界、CI | 9 项架构测试；0 高/2 中风险，全部修复 |
| CKL-002 | 完成 | `da7d36e` | 领域模型、状态机、Scope、证据、GLOBAL 晋升 | 35 项 Domain 测试；行 93.84%、分支 93.87%；1 高/2 中风险，全部修复 |
| CKL-003 | 完成 | `7d2dbe7` | 三类版本化 JSON Schema、Ajv 解析与诊断 | 46 项模块测试；100,000 次 Event 解析约 124,592 ops/s；1 高/2 中风险，全部修复 |
| CKL-004 | 完成 | `54fd84a` | 六类策略、YAML/对象加载、原子激活、安全默认值 | 82 项模块测试；配置行 99.30%、分支 90.40%；1 高/3 中风险，全部修复 |
| CKL-101 | 完成 | `fc1bf7b` | 四类 Codex Hook 到标准事件的适配、确定性 ID、脱敏 Fixture | 105 项累计模块测试；适配器约 61,547 events/s；1 高/3 中风险，全部修复 |
| CKL-102 | 完成 | `4743020` | 版本化 rollout JSONL 增量读取、游标、替换/截断/格式诊断 | 121 项累计模块测试；真实 5.8 MB rollout 约 280 MiB/s；1 高/4 中风险，全部修复 |
| CKL-103 | 完成 | `31ce136` | SQLite Migration、幂等追加、消费游标、payload tombstone、入库脱敏 | 137 项累计模块测试；1000 条 WAL 写约 11.60ms、读约 7.17ms；3 高/3 中风险，全部修复 |
| CKL-104 | 完成 | `1ef5027` | 轻量 Hook Handler、100ms 入队门禁、完整信封脱敏、原子 Spool 与幂等恢复 | 164 项累计模块测试；Hook P95 0.0407ms；3 高/5 中风险，全部修复 |
| CKL-105 | 完成 | `550d935` | Session/Turn 确定性重建、重复 Stop 折叠、缺失结束推断、乱序稳定排序 | 187 项累计模块测试；10,000 事件重建中位 8.48ms；2 高/5 中风险，全部修复 |
| P1 Gate | 通过 | `92bcfb9` | 三次幂等重放、Hook 全故障恢复、source/session/turn 全链路追踪 | 189 项模块测试、14 项架构/Gate 测试；1 高/3 中风险，全部修复 |
| CKL-201 | 完成 | `82c9546` | 确定性 Episode 聚合、目标拆分/子目标、纠错双向保真、动作/产物/结果、Ledger 完整重建 | 211 项模块测试、16 项架构/Gate 测试；2 高/4 中风险，全部修复；10,000 事件中位 24.20ms |
| CKL-202 | 完成 | `2467b5f` | 模型无关提取端口、最小输入、原子草稿 Schema/Grounding、版本化幂等键、超时重试 | 235 项模块测试、19 项架构/Gate 测试；3 高/5 中风险，全部修复；100 Candidate 中位 1.71ms |
| CKL-203 | 完成 | `83cf0ae` | 五类 MVP Compiler、供应商无关结构化生成端口、专用 Schema/Prompt、Candidate 强制 PROPOSED | 245 项模块测试、20 项架构/Gate 测试；3 高/5 中风险，全部修复；100 Candidate 中位 1.87ms |
| CKL-204 | 完成 | `379c863` | Episode v2 全部用户原话、接受/拒绝/纠错信号、保守目标关联、歧义门禁、确定性 Assertion | 259 项模块测试、21 项架构/Gate 测试；4 高/6 中风险，全部修复；100 Candidate × 100 Statement 中位 1.83ms |
| CKL-205 | 完成 | `0923708` | SQLite 编译批次、租约/续租、generation fencing、原子 Candidate 落库、版本并存、默认不召回 | 274 项模块测试、23 项架构/Gate 测试；5 高/7 中风险，全部修复；100 Candidate 写 P95 2.18ms、读 P95 1.37ms |
| P2 Gate | 通过 | `0ce3cda` | v1 Golden Codex 对话、五类知识全链、Candidate→Episode→Turn 追溯、模型失败持久化恢复 | 276 项模块测试、25 项架构/Gate 测试；4 高/5 中风险，全部修复；成功链单次约 23.45ms |
| CKL-301 | 完成 | `3277f3a` | Remote 脱敏归一化、portable/local/filesystem 三类 Project ID、worktree common-dir、参数安全 Git Probe | 285 项模块测试、27 项架构/Gate 测试；5 高/7 中风险，全部修复；真实仓库中位 31.31ms |
| CKL-302 | 完成 | `a7453e2` | 七级最小可证明 Scope、可信身份门禁、项目特征识别、冲突/非法输入 PROJECT 降级 | 298 项模块测试、29 项架构/Gate 测试；5 高/7 中风险，全部修复；约 1,096,802 decisions/s |
| CKL-303 | 完成 | `51201cc` | 唯一 Verifier Registry、七类 typed Probe/Verifier、四态结果、Evidence 完整性与插件故障隔离 | 315 项模块测试、31 项架构/Gate 测试；5 高/8 中风险，全部修复；约 157,916 assertions/s |
| CKL-304 | 完成 | `9511e0c` | Evidence 状态策略、合法迁移路径、自动发布/询问、可追溯跨项目 GLOBAL 晋升 | 330 项模块测试、33 项架构/Gate 测试；6 高/8 中风险，全部修复；约 667,698 decisions/s |
| CKL-305 | 完成 | `d2bf29e` | path/symbol/config/dependency 目标指纹、相关 ChangeSet、复验防伪与正文保留 STALE | 342 项模块测试、35 项架构/Gate 测试；5 高/7 中风险，全部修复；10,000 次中位 16.916ms |
| P3 Gate | 通过 | `e156f77` | 代码/测试 Evidence 生命周期、项目隔离、结构化 GLOBAL 晋升、ERROR 失败关闭、正文保留 STALE | 342 项模块测试、38 项架构/Gate 测试；4 高/5 中风险，全部修复；整体行覆盖率 96.97%、分支 90.36% |
| CKL-401 | 完成 | `f83067e` | 严格 Front Matter、原子 current、不可覆盖版本、手工编辑 trust 门禁、tombstone 与旧版恢复 | 358 项模块测试、38 项架构/Gate 测试；7 高/9 中风险，全部修复；专项行 97.41%、分支 85.30%；原子发布 P95 22.819ms |
| CKL-402 | 完成 | `c32570f` | COMMITTED Markdown 到 SQLite 资产/版本/关系/Evidence/FTS5、事务 indexVersion、删除后重建 | 371 项模块测试、38 项架构/Gate 测试；7 高/8 中风险，全部修复；专项行 94.00%、分支 89.09%；100 资产重建 157.151ms |
| CKL-403 | 完成 | `be5128a` | contentHash 增量、稳定 chunkId、跨版本单资产事务、去抖/max-wait、Node watcher | 384 项模块测试、38 项架构/Gate 测试；6 高/9 中风险，全部修复；Indexer 行 97.98%、分支 92.85%；100 重复通知 P95 295.755ms |
| CKL-404 | 完成 | `06d6f82` | 可关闭 VectorIndexPort、embeddingVersion/cache、内存 cosine 索引、原子 replace/remove | 390 项模块测试、38 项架构/Gate 测试；5 高/7 中风险，全部修复；专项行 98.92%、分支 91.30% |
| CKL-405 | 完成 | `66e736e` | 八类治理命令、薄 CLI/复用服务、状态门禁、版本化审计/suppression、双源 doctor | 409 项模块测试、38 项架构/Gate 测试；6 高/9 中风险，全部修复；专项行 96.05%、分支 90.48% |
| P4 Gate | 通过 | `1329968` | 对话→验证→Markdown→SQLite 全链、删除投影等价重建、500 例 Shadow Dataset | 409 项模块测试、40 项架构/Gate 测试；4 高/5 中风险，全部修复；错误自动确认率 0/300=0.00% |
| CKL-501 | 完成 | `3444f55` | 精确 QueryContext、path/symbol/error/config 抽取、可信 project boundary、缺失上下文失败收窄 | 419 项模块测试、40 项架构/Gate 测试；5 高/8 中风险，全部修复；专项行 100%、分支 93.00%；10k prompt P95 0.100ms |
| CKL-502 | 完成 | `35dba63` | Exact/FTS/Vector/Relation、强制 Scope/Status 门禁、current-version 防伪、rank-only RRF | 431 项模块测试、40 项架构/Gate 测试；8 高/10 中风险，全部修复；专项行 98.13%、分支 89.04%；1,000 资产 P95 <50ms |
| CKL-503 | 完成 | `ee6a18c` | 30 候选 RerankPort、完整 ID 输出验证、超时 Abort、RRF fallback、subject 去重与解释 | 446 项模块测试、40 项架构/Gate 测试；6 高/9 中风险，全部修复；专项行 100%、分支 97.29% |
| CKL-504 | 完成 | `de2e481` | ContextEnvelope Schema、L0～L4、Scope/Status/Authority 优先级、预算降级、独立 Task Contract | 461 项模块测试、40 项架构/Gate 测试；6 高/9 中风险，全部修复；专项行 93.43%、分支 88.88% |
| CKL-505 | 完成 | `a964bab` | Retrieval Trace、四轴复杂度解释、Golden Runner、配置指纹、Recall/Precision 与完整注入 Gate | 471 项模块测试、40 项架构/Gate 测试；7 高/9 中风险，全部修复；专项行 98.01%、分支 89.89% |
| CKL-506 | 完成 | `21de066` | Codex UserPrompt additionalContext、OFF/SHADOW/ACTIVE、500ms Abort、失败开放、运行中回滚 | 485 项模块测试、40 项架构/Gate 测试；8 高/9 中风险，全部修复；专项行 95.94%、分支 88.42% |
| CKL-507 | 完成 | `f8c2681` | 四个运行中知识工具、current/Scope 复核、L2 增量与 L3 Delta、MCP/主动注入故障隔离 | 491 项模块测试、41 项架构/Gate 测试；7 高/9 中风险，全部修复；专项行 97.16%、分支 88.18% |
| P5 Gate | 通过 | `d43fb8e` | 10 Case 全链 Golden、ACTIVE Evidence、timeout 空输出、MCP L1/L2→L3 与项目隔离 | Recall@5/Precision@5/Traceability 100%；Scope/forbidden/over-budget/自动 L4 均为 0；491 模块、43 Gate 全通过 |
| CKL-601 | 完成 | `86ac991` | 结构化 Closure Result、确定性 Gate/Boundary 优先、精确 Context Retry、受限 Semantic Gate | 499 项模块测试、43 项架构/Gate 测试；8 高/10 中风险，全部修复；专项行 100%、分支 89.83% |
| CKL-602 | 完成 | `c18c3a7` | Stop JSON Adapter、精确 context/correction delta、原子有限 counter、分层 deadline 与失败开放 | 509 项模块测试、43 项架构/Gate 测试；9 高/10 中风险，全部修复；专项行 97.64%、分支 90.52% |
| CKL-603 | 完成 | `39c3601` | 类型化微确认、20 Turn 窗口、无人回答安全默认、Confirmation Schema 与上游 Adapter | 526 项模块测试、43 项架构/Gate 测试；10 高/11 中风险，全部修复；专项行 98.75%、分支 88.61% |
| CKL-604 | 完成 | `3142c0a` | Pending/Claim/Resolution SQLite、窄自然语言匹配、显式拒绝/纠正和 revision-fenced Effect | 550 项模块测试、43 项架构/Gate 测试；11 高/12 中风险，全部修复；专项行 97.58%、分支 89.02% |
| CKL-605 | 完成 | `bd80f8b` | Scope feedback、pin/suppress 后置召回、L1-L3 复杂度学习和 MCP actual-use 关联 | 558 项模块测试、43 项架构/Gate 测试；8 高/10 中风险，全部修复；专项行 98.64%、分支 91.46% |
| P6 Gate | 通过 | `27a1ee3` | 固定 100 Turn 交互、闭环、续跑与反馈联合验收 | 558 项模块测试、44 项架构/Gate 测试；5 高/6 中风险，全部修复；六项指标全部达标 |
| CKL-701 | 完成 | `d1eca77` | App Server v2 最终态映射、turn.items 断线补偿和 Ledger 重连幂等 | 575 项模块测试、45 项架构/Gate 测试；8 高/10 中风险，全部修复；专项行 98.36%、分支 95.56% |
| CKL-702 | 完成 | `02852e8` | 默认 dry-run、Scope/敏感/短会话策略、分页断点和中断恢复 | 584 项模块测试、46 项架构/Gate 测试；9 高/11 中风险，全部修复；专项行 96.42%、分支 88.07% |
| CKL-703 | 完成 | `b0effbc` | Codex 原生插件、CCM 可逆 Hook 合并、sidecar 生命周期和兼容声明 | 604 项模块测试、47 项架构/Gate 测试；7 高/9 中风险，全部修复；专项行 94.98%、分支 88.93% |
| CKL-704 | 完成 | `749e085` | Daemon 生命周期、Hook/MCP 快路径、Worker 单飞和结构化健康 | 614 项模块测试、48 项架构/Gate 测试；8 高/7 中风险，全部修复；专项行 100%、分支 94.11% |
| CKL-705 | 完成 | `a2b5c00` | 默认 read-only `codex exec`、结构化 Schema/result、JSONL 脱敏诊断、取消和有界进程输出 | 623 项模块测试、50 项架构/Gate 测试；专项行 96.00%、分支 88.46%；O(n²) 输出统计瓶颈已修复 |

## 2. P0 Gate 证据

在固定的 Node.js 24.18.0 LTS 与 npm 11.11.0 环境执行了从锁文件开始的完整验证：

```text
npm ci
npm run clean
npm run check
```

结果：

| Gate | 结果 |
|---|---|
| 干净安装 | 171 packages installed，0 vulnerabilities |
| Workspace 架构 | 5 个 workspace 依赖方向通过；循环、越层和未声明依赖检查通过 |
| Lint / Build / Test Typecheck | 全部通过 |
| 架构测试 | 9/9 通过 |
| 模块测试 | 82/82 通过，8 个 Test Files 全部通过 |
| 整体覆盖率 | Lines 97.89%、Branches 90.67%、Functions 100%、Statements 95.94% |
| Domain Gate | Lines 93.84%、Branches 93.87%，高于 90% 门槛 |
| Schema Fixture | Event、Candidate、Asset 的有效/无效/版本/扩展/交叉字段 Fixture 全部通过 |
| 供应链审计 | npm 官方 registry：0 vulnerabilities |

## 3. P0 验收映射

| 验收项 | 证据 | 结论 |
|---|---|---|
| 工程可在干净环境构建 | `npm ci` 后执行 clean + check | 通过 |
| 包与应用可独立编译 | TypeScript Project References 构建 5 个 workspace | 通过 |
| Domain 与基础设施隔离 | package allowlist + TypeScript AST import checker | 通过 |
| 状态与 GLOBAL 晋升不变量 | 49 条状态组合及晋升正反测试 | 通过 |
| Schema 可版本化、可诊断 | `schemaVersion: 1`、JSON Path 诊断、未知版本拒绝 | 通过 |
| 配置不能削弱安全门禁 | Zod literal/range/cross-field invariants 和攻击型 Fixture | 通过 |
| 无效配置不影响运行快照 | validate-then-swap，失败保持上一对象身份 | 通过 |

## 4. 已知边界与下一步

- P0 只建立工程、领域、Schema 和配置能力，不采集真实 Codex 对话，不读写 `~/.ckl`。
- 当前没有 SQLite、Hook、Daemon 运行时或模型调用，因此不存在生产数据迁移和后台资源占用。
- P0-P7、横切任务和补充的 CKL-704 均完成；最终验收映射见 `mvp-final-acceptance-report.md`。
- CKL-704 提供发行层可装配的 Daemon 应用核；真实 Hook/Daemon 安装仍未执行，也未修改 `~/.ckl`、Codex 或 CCM 配置。
- 后续工作属于发行与部署阶段，不应在没有明确授权时自动创建用户目录、注册系统服务或迁移真实数据。
