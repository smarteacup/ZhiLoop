# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-405 | 28 次 |
| 耗时 | 720s | 12840s |
| 高风险 | 6 | 96 |
| 中风险 | 9 | 149 |
| 低风险 | 0 | 0 |
| 修复程度 | 15/15（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | CLI 绕过 Domain 状态机直接写 STALE | 强制调用 transition；只允许 IMPLEMENTED/VERIFIED，重复 STALE 也拒绝。 |
| 高 | Markdown 已提交但 SQLite 投影失败造成双源不一致 | 两阶段审计保留 FAILED/STARTED，doctor 定位，rebuild 显式恢复。 |
| 高 | doctor 固定 limit 导致大库被误判健康 | Registry 加 offset；doctor 以 1,000 条分页读取至末页。 |
| 高 | suppression 与成功审计分两次提交 | 同一 BEGIN IMMEDIATE 事务 upsert suppression 并插入 SUCCEEDED audit。 |
| 高 | SQLite schema 无版本导致后续升级不可判定 | 新增 governance_meta migration；拒绝高于当前实现的版本。 |
| 高 | CLI 猜测默认用户目录造成意外写入 | 实际入口要求显式三个环境路径；help 不打开存储。 |
| 中 | 非法/重复参数可能被静默忽略 | 严格消费参数；未知、缺值、重复均返回 usage exit 2。 |
| 中 | 失败命令返回 0 误导脚本 | usage=2，执行失败/doctor unhealthy=1，成功=0。 |
| 中 | tombstone 仍可 mark-stale | 显式拒绝，并保留失败审计。 |
| 中 | stale 新版本丢失血缘 | 自动增加指向上一版本的 SUPERSEDES relation。 |
| 中 | audit 保存正文或超长错误 | 仅存操作元数据/原因/错误摘要，所有字段有 1,000 字符边界。 |
| 中 | SQLite 文件权限继承过宽 umask | 非 Windows 创建后 chmod 0600，并有真实文件测试。 |
| 中 | list 输出无界耗尽终端/内存 | CLI 服务固定最多 1,000；Registry limit 1～1,000。 |
| 中 | diff/trace 读取可变 current 失去可复现性 | 均读取 Registry immutable version 表并校验版本。 |
| 中 | invalid current 被重复误报为 orphan projection | Markdown ID 先从投影集合剔除，再独立报告 INVALID_MARKDOWN_CURRENT。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | 33/33；Lines 96.05%、Branches 90.48% |
| 全仓 | 409/409 模块；38/38 架构/Gate |
| 整体覆盖率 | Lines 97.00%、Branches 90.14% |
| Workspace | 22 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-405 三项验收条件满足，15 项风险全部修复，无遗留 actionable finding。可以执行 P4 Gate。
