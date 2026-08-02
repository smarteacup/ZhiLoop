# ZhiLoop MVP 最终验收报告

## 1. 结论

ZhiLoop/CKL 的 P0～P7、CKL-001～CKL-705、四项横切任务和 MVP Definition of Done 已全部通过。最终结论以 `scripts/mvp-final-gate.test.mjs` 的同一任务单流验收为核心证据，不再用 P2～P6 的分散测试拼接跨模块结论。

“源码实施完成”不表示已经改变用户环境：验收没有安装 Hook、没有启动常驻进程、没有创建或迁移 `~/.ckl`，也没有修改 `~/.codex`、`~/.ccm` 或业务仓库。

## 2. 最终单流场景

同一个 Codex `sessionId/taskId/Episode/correlationId/projectId` 依次经过：

```text
Hook -> Event Ledger -> Session/Turn -> Episode
 -> Compiler -> Candidate Repository
 -> Verifier Registry -> Evidence Policy
 -> Markdown -> SQLite/FTS
 -> Query Context -> Retrieval -> Rerank -> L2 Context Envelope
 -> ACTIVE UserPrompt injection -> ckl.search/get
 -> Closure Verifier -> Stop one-shot correction
```

| MVP 场景 | 同流自动化证据 | 结果 |
|---|---|---|
| 技术方案、代码修改和关联测试被捕获 | 同一 Golden Hook Session 中存在 UserPrompt、write tool、成功 `npm test` 和 SessionEnd | 通过 |
| 后台编译五类知识 | 同一 Candidate claim 原子保存 Requirement/Design/Decision/Implementation/Experience | 通过 |
| 全链路可追溯 | Candidate Hint → Episode → Turn → Event 全部可解析 | 通过 |
| Implementation/Experience 有代码和测试证据 | 两类 Candidate 的 Symbol/Test Verification Result 全部 `SUPPORTED` | 通过 |
| 生命周期符合安全上限 | Requirement/Design/Decision=`ACCEPTED`，Implementation=`IMPLEMENTED`，Experience=`VERIFIED` | 通过 |
| Markdown 人可读 | 读取真实 `current.md` 并断言 Front Matter、状态和正文 | 通过 |
| SQLite/FTS 可检索 | 五条同项目资产和一条外项目控制资产均投影并命中 FTS | 通过 |
| 同项目召回、其他项目不泄漏 | 项目 A 返回自己的 5 条；项目 B 只返回自己的控制资产；Scope diagnostics 可解释 | 通过 |
| 默认控制注入复杂度 | ACTIVE Hook 生成 L2；800-token 预算选择 3 条并显式 `truncated=true` | 通过 |
| 按需展开 | 从 L2 Experience 指针经 `ckl.get` 展开 L3 正文和两条 Evidence Summary | 通过 |
| Authority 分层 | `ckl.search` 同时返回 Binding Rule、Accepted Decision、Reference，类型明确 | 通过 |
| Retrieval explain 完整 | 5 条结果均含 channel reason、rank、Evidence、Episode 和复杂度原因轴 | 通过 |
| Stop 只续跑一次 | 缺少独立 release Gate 时产生一次 correction delta；recursive Stop 拦截；第三次达到上限 | 通过 |
| 不进入审核队列 | 所有 Evidence 决策非 `ASK_USER`、interaction=`NONE`、`createReviewTasks=false` | 通过 |

Implementation 的生命周期有意最高为 `IMPLEMENTED`，不能为了字面统一提升为 `VERIFIED`；它的代码和测试证据已经验证为 `SUPPORTED`。Experience 只有在相关测试证据成立后才能进入 `VERIFIED`。这是领域安全不变量，而不是验收降级。

## 3. 分阶段与接入 Gate

| Gate | 直接证据 | 结果 |
|---|---|---|
| P0 | 干净安装、依赖/import policy、构建、Schema/配置安全门禁 | 通过 |
| P1 | 三次 Ledger 重放与 Daemon 全故障 Hook 放行 | 通过 |
| P2 | Golden Episode 五类 Candidate 与可恢复失败 | 通过 |
| P3 | Scope/Evidence/GLOBAL/STALE 生命周期 | 通过 |
| P4 | Markdown/SQLite 等价重建与 500 例 Shadow Dataset | 通过 |
| P5 | Recall/Precision/Trace、ACTIVE 注入和 MCP 展开 | 通过 |
| P6 | 100 Turn 交互/闭环/反馈指标 | 通过 |
| P7 | Plugin/CCM round-trip、兼容与 sidecar 缺失失败开放 | 通过 |
| CKL-701 | App Server 重连补偿不重复入 Ledger | 通过 |
| CKL-702 | 历史回填默认 dry-run、策略跳过和断点恢复 | 通过 |
| CKL-704 | Daemon lifecycle/rollback/cancel/worker/health | 通过 |
| CKL-705 | 默认 non-shell、read-only、structured `codex exec` Adapter | 通过 |

逐任务证据见[实施计划完成审计](completion-audit.md)。

## 4. 最终指标

| 指标 | 结果 | 门槛 |
|---|---:|---:|
| Workspace/import policy | 37/37 | 全通过 |
| 模块测试 | 623/623 | 全通过 |
| 架构/Gate 测试 | 51/51 | 全通过 |
| Statements | 94.62% | >=90% |
| Lines | 96.90% | >=90% |
| Branches | 89.94% | >=85% |
| Functions | 98.04% | >=90% |
| Recall@5 / Precision@5 | 100% / 100% | >=90% / >=80% |
| Retrieval Traceability | 100% | 100% |
| Scope leak / forbidden hit | 0 / 0 | <1% / 0 |
| 自动 L4 / over-budget | 0 / 0 | 0 / 0 |
| 无人工 Turn 比例 | 95% | >=90% |
| 自动续跑平均次数 | 0.1/Turn | <=0.2 |
| 闭环循环 | 0 | 0 |
| npm high+ vulnerabilities | 0 | 0 |

最终单流 Gate 单次约 143～189ms；同仓 P4/P5/P6 组合回归和完整 `npm run check` 均重复通过。

## 5. 最终 Review

最终审查从新增、删除、配置、运行和组合真实性五个维度检查：

- 新增：参数/NUL/大小/路径、超时、取消、并发、Scope、版本、hash 和输出上限均有正反测试。
- 删除/重构：没有删除领域不变量；Adapter、Plugin 和 Daemon 只沿公开端口装配。
- 配置：Hook 合并不覆盖 CCM；未知字段保留；兼容矩阵机器可读；安全门禁不可被配置削弱。
- 运行：测试外部写入只使用系统临时目录；没有 Home、业务仓库或外部服务副作用。
- 组合真实性：最终 Gate 直接调用实际模块并共享同一实体身份，不调用旧 Gate、不伪造阶段间结果。

审查期间补齐了默认 `codex exec` Adapter，修复其潜在 O(n²) JSONL 计数；此前干净安装发现的 watcher 启动窗口也已通过“先 watch、再 scan/reconcile”修复。最终无未关闭的高/中风险代码问题。

## 6. 部署边界

以下不属于本次源码实施计划的自动动作：

- 把 ZhiLoop 知识写入业务 Git 仓库。
- 在后台额外运行测试或任意项目命令。
- 读取非公开 Codex Memories 内部格式。
- 中心化团队同步或强制生产向量服务。
- 安装插件、发布平台相关 `zhiloop-sidecar`、注册系统服务或迁移真实用户数据。

真实启用需要用户明确安装目标、服务管理方式和回滚窗口。
