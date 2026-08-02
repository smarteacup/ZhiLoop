# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-501 | 30 次 |
| 耗时 | 420s | 13620s |
| 高风险 | 5 | 105 |
| 中风险 | 8 | 162 |
| 低风险 | 0 | 0 |
| 修复程度 | 13/13（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | project 缺失时误放宽为 GLOBAL/任意项目 | boundary 同时关闭 project/global，保留 NO_TRUSTED_PROJECT_CONTEXT。 |
| 高 | `..`/仓库外绝对路径污染 Exact/Scope 通道 | 词法拒绝 traversal；绝对路径必须在可信 repositoryRoot 内。 |
| 高 | repositoryRoot 为 `/`、盘符根或含 traversal 形成宽边界 | 明确拒绝根目录、盘符根、相对根和 dot segments。 |
| 高 | 模型/规范化改写 symbol/error/config 导致精确召回丢失 | 每个 term 同时保存 exact 与 canonical，不做同义语义改写。 |
| 高 | 超长 prompt/大量 hints 造成正则与内存 DoS | prompt 100k、term 1k、每类 100 的硬边界。 |
| 中 | 独立 branch 覆盖可信 ProjectContext branch | ProjectContext 优先，冲突记录 BRANCH_INPUT_CONFLICT。 |
| 中 | cwd 是相对路径或指向仓库外 | cwd 必须安全绝对；有 root 时必须位于 root 内。 |
| 中 | 显式与 prompt token 重复放大权重 | 按 type+canonical 去重，显式 hint 优先保留。 |
| 中 | 无效 hint 静默消失无法解释 | 每类输出 INVALID_*_HINT_IGNORED reason code。 |
| 中 | term 超限静默截断 | 输出 *_LIMIT_REACHED reason code。 |
| 中 | Unicode 外观差异造成匹配漂移 | canonical 仅 NFKC，exact 原样保留。 |
| 中 | 下游修改 context 扩大边界 | 输出递归 freeze，数组/term/boundary 均不可变。 |
| 中 | Resolver 偷跑 Git/文件扫描/模型 | workspace allowlist 仅 Domain，运行时无外部/Node 依赖。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | 10/10；Lines 100%、Branches 93.00% |
| 全仓 | 419/419 模块；40/40 架构/Gate |
| 整体覆盖率 | Lines 97.09%、Branches 90.26% |
| Workspace | 23 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-501 两项验收满足，13 项风险全部修复，无遗留 actionable finding。可以进入 CKL-502。
