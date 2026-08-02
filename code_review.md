# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | P6 Gate | 43 次 |
| 耗时 | 360s | 20790s |
| 高风险 | 5 | 203 |
| 中风险 | 6 | 283 |
| 低风险 | 0 | 0 |
| 修复程度 | 11/11（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 用手工结果替代真实闭环，指标通过但模块未协作 | Gate 直接连接 Interaction、Closure、Stop、Feedback 与 Retrieval 的公开实现。 |
| 高 | 只检查 feedback 表，不证明 suppress 能阻止召回 | SQLite 写入后生成 profile，并执行 50 次真实 Retrieval。 |
| 高 | Stop 只统计首次结果，递归续跑死循环未被发现 | 每次续跑都以 `stop_hook_active=true` 再调用一次并独立计数。 |
| 高 | 违规样本未真正命中 Task Contract 边界 | 20 个样本均变更 `secrets` 禁止前缀，并以 Closure PASS 作为漏判。 |
| 高 | 测试内重写宽松门槛造成固定数据失真 | 所有门槛只从版本化 fixture 读取，断言保持 `<`/`≤` 原始语义。 |
| 中 | 20 Turn 限频存在窗口首尾 off-by-one | 遍历全部连续窗口并使用半开区间 `[start,start+20)`。 |
| 中 | 无人工比例按触发数而非 Turn 数计算 | 固定以 100 Turn 为分母，以实际 question Turn 为人工数。 |
| 中 | suppress Scope 与 QueryContext 推导 Scope 不一致 | 两者都使用 canonical PROJECT scope key，并经 Retrieval 的 scope guard 复核。 |
| 中 | 重复的 Turn/违规/续跑编号导致指标分母失真 | fixture 校验总 Turn 和触发数量，所有集合使用固定唯一编号。 |
| 中 | 根目录独立测试错误依赖 workspace package link | 按现有 Gate 约定引用构建后的 `packages/*/dist/index.js`。 |
| 中 | Gate 通过被误解为授权部署 | 报告明确未安装 Hook、未启动 Daemon、未修改 Codex/CCM/CKL 配置。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| P6 固定集 | 1/1；100 Turn 六项指标全部通过 |
| 指标 | 1 次/20 Turn；95% 无人工；0% suppress 重复；0 循环；0.10 续跑/Turn；0% 漏判 |
| 全仓 | 558/558 模块；44/44 架构/Gate |
| 整体覆盖率 | Lines 96.98%、Branches 89.89%、Functions 98.43% |
| Workspace | 34 个，依赖/import policy 通过 |
| 供应链 | 官方 npm registry：0 vulnerabilities |

## Review 结论

P6 Gate 六项验收满足，11 项风险全部修复，无遗留 actionable finding。测试覆盖真实组件协作和递归 Stop 防护，数据与阈值可版本化回归。可以进入 CKL-701。
