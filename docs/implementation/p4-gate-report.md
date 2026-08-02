# P4 Gate 验证报告

**结论**：通过  
**日期**：2026-08-02  
**Fixture**：`p4-shadow-v1`

## 1. 验收结果

| Gate | 结果 | 证据 |
|---|---|---|
| 模拟对话生成、验证并发布人可读 Markdown | 通过 | 真实 Hook Adapter、Ledger、Episode、Compiler、Scope、Verifier、Policy、Markdown、Registry 全链执行；发布状态 IMPLEMENTED |
| 删除 SQLite 后等价重建 | 通过 | 删除临时 Registry 文件，从 Markdown 重建 1 asset/1 version；资产、版本、Relation、Evidence、FTS 快照一致 |
| Shadow 错误自动确认率 `< 1%` | 通过 | 500 cases；200 正例、300 负例；false positive 0、false negative 0、错误自动确认率 0% |
| Shadow 无用户可见写入 | 通过 | 500 次策略评估，Publisher 调用/写入为 0 |

## 2. Shadow 指标

```text
fixtureVersion: p4-shadow-v1
total: 500
expected publish: 200
expected blocked: 300
false positives: 0
false negatives: 0
incorrect auto-confirmation rate: 0 / 300 = 0.00%
threshold: < 1.00%
shadow writes: 0
```

负例分别覆盖 Verifier 的 UNKNOWN、REFUTED 和 ERROR；正例覆盖 IMPLEMENTATION 的 code evidence 与 EXPERIENCE 的 code + test evidence。因此结果不是由“全部拒绝发布”得到。

## 3. 完整门禁

| 检查 | 结果 |
|---|---|
| P4 Gate 专项 | 2/2 |
| 全仓模块测试 | 409/409，36 files |
| 架构/Gate 测试 | 40/40 |
| 整体覆盖率 | Lines 97.00%、Branches 90.14%、Functions 98.42%、Statements 94.87% |
| Workspace / import policy | 22 workspaces，通过 |
| npm audit | 0 vulnerabilities |

## 4. 结论与边界

P4 三项 Gate 均满足，可以进入 P5。该结论只授权继续实现混合召回与受控注入，不代表真实安装或启用；当前仍未写入 `~/.ckl`、未修改 Codex/CCM 配置、未启动 daemon。
