# ZhiLoop MVP 最终验收报告

## 1. 结论

ZhiLoop/CKL 的 P0-P7 源码实施基线与补充的 CKL-704 Daemon 编排核全部完成，MVP Definition of Done 通过。验收覆盖从 Codex 对话捕获到知识沉淀、证据生命周期、可读 Markdown、SQLite/FTS、Scope 隔离、动态注入、MCP 展开、有限闭环、App Server/历史回填、插件回滚和 Daemon 生命周期。

“源码基线完成”不表示已经修改用户环境：验收没有安装 Hook、没有启动常驻进程、没有创建或迁移 `~/.ckl`，也没有修改 `~/.codex`、`~/.ccm` 或业务仓库。

## 2. 最终场景映射

| MVP 场景 | 自动化证据 | 结果 |
|---|---|---|
| Codex 技术方案对话被捕获 | P1/P2 Golden Hook Fixture → Event Ledger → Turn/Episode | 通过 |
| 产出 Requirement/Design/Decision/Implementation/Experience | P2 Gate 五类原子 Candidate Batch | 通过 |
| IMPLEMENTATION 由代码证据晋级 | P3 `SYMBOL_EXISTS` → IMPLEMENTED | 通过 |
| EXPERIENCE 由代码和测试共同晋级 | P3 `SYMBOL_EXISTS + TEST_PASSED` → VERIFIED | 通过 |
| 用户纠正和结论可追溯 | P2 sourceRef → Episode → Turn → Event | 通过 |
| 知识以 Markdown 可读 | P4 publish 后断言 Front Matter、标题、正文 | 通过 |
| SQLite/FTS 可检索且可重建 | P4 删除 projection 后从 Markdown 等价重建 | 通过 |
| 同项目召回、其他项目不泄漏 | P3 Scope + P5 Golden Retrieval | 通过 |
| 默认只注入 L2 且预算受控 | P5 Gate，自动 L4=0、超预算=0 | 通过 |
| Codex 按 ID 从 L1/L2 展开至 L3 | P5 `ckl.get` 双路径 | 通过 |
| Reference/Decision/Rule Authority 分层 | P5 Orchestrator Golden Dataset | 通过 |
| explain 包含完整多路排名原因 | P5 Retrieval Trace，traceability=100% | 通过 |
| 门禁缺失只续跑一次 | P6 Stop Continuation，平均 0.1/Turn | 通过 |
| 闭环不形成循环 | P6 recursive `stop_hook_active`，loops=0 | 通过 |
| 默认不依赖人工审核队列 | P4 Shadow + P6，95% Turn 无确认 | 通过 |
| App Server 重连不重复入库 | CKL-701 Gate | 通过 |
| 历史回填默认 dry-run 且可恢复 | CKL-702 Gate | 通过 |
| Codex/CCM Hook 不覆盖并可逆卸载 | P7 临时目录安装/卸载，原始字节恢复 | 通过 |
| sidecar 生命周期和 worker 可恢复编排 | CKL-704 Gate | 通过 |

## 3. 指标汇总

| 指标 | 结果 | 门槛 |
|---|---:|---:|
| 模块测试 | 614/614 | 全通过 |
| 架构/Gate 测试 | 48/48 | 全通过 |
| Workspace 依赖/import policy | 36/36 | 全通过 |
| Lines | 96.92% | >=90% |
| Branches | 89.97% | >=85% |
| Functions | 98.15% | >=90% |
| Recall@5 / Precision@5 | 100% / 100% | >=90% / >=80% |
| Retrieval Traceability | 100% | 100% |
| Scope leak / forbidden hit | 0 / 0 | <1% / 0 |
| 自动 L4 / over-budget | 0 / 0 | 0 / 0 |
| 无人工 Turn 比例 | 95% | >=90% |
| 自动续跑平均次数 | 0.1/Turn | <=0.2 |
| 闭环循环 | 0 | 0 |
| 门禁违反仍成功 | 0% | <1% |
| npm high+ vulnerabilities | 0 | 0 |

## 4. 最终 Review

最终审查从新增、删除、配置和运行边界四个维度检查：

- 新增：NUL/大小上限、超时、取消、并发 single-flight、游标单调、Scope、版本和 hash 门禁均有正反测试。
- 删除/重构：没有删除领域不变量；插件与 Daemon 只依赖公开端口，未复制领域实现。
- 配置：插件不覆盖 Codex/CCM Hook；失败冲突保留回执；unknown Hook/字段保持；版本矩阵机器可读。
- 运行：所有外部写测试限定在系统临时目录；没有 Home、Git 业务仓库或外部服务副作用。

审查中发现的最后一个架构缺口是空 `apps/daemon`；已通过 CKL-704 补齐，并将 Daemon/Plugin Runtime 加入全仓覆盖率统计。干净安装验收又复现了 watcher 启动窗口偶发漏事件；CKL-403 现改为“先注册 watch、再扫描 reconcile”，真实 watcher 专项连续 5 轮通过。最终没有未关闭的高/中风险代码问题。

## 5. 明确非目标

以下内容没有被误算为缺陷或“待偷偷开启”的能力：

- 不自动写入业务 Git 仓库。
- 不在后台擅自运行测试或任意代码命令。
- 不读取非公开 Codex Memories 内部格式。
- 不做中心化团队同步。
- 不强制启用生产向量服务；FTS/Exact/Relation 保持可用。
- 不自动安装插件、注册系统服务或迁移真实用户数据。

真实启用属于下一阶段的部署操作，需要明确目标目录、发行包和回滚窗口；不影响本次源码 MVP 验收结论。
