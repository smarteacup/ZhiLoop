# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-602 | 39 次 |
| 耗时 | 600s | 18180s |
| 高风险 | 9 | 169 |
| 中风险 | 10 | 244 |
| 低风险 | 0 | 0 |
| 修复程度 | 19/19（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | Stop continuation 递归形成死循环 | `stop_hook_active` 前置短路，默认最多 1 次、高风险最多 2 次。 |
| 高 | 并发 Stop 同时消费最后一次额度 | 输出前通过同步 `claim` 原子占用，竞争失败直接结束。 |
| 高 | Verifier 新增任务外 Knowledge/Gate/Boundary | identity、完整 Gate 集合和三个 target 子集全部二次验证。 |
| 高 | Verifier 返回 PASS 却携带失败或缺失目标 | decision、Gate status 与 target shape 交叉校验，矛盾结果 UNKNOWN。 |
| 高 | Context Port 少给、多给或重复注入知识 | 返回 ID 必须与请求集合一一对应，重复项也拒绝。 |
| 高 | CKL-601 把 UNKNOWN Gate 当作 unmet 引导错误修复 | unmet 现在只取 `UNSATISFIED`，并新增 Boundary + Semantic 回归。 |
| 高 | CKL-601 生成无 Gate/Boundary target 的 correction | 全 Gate 满足但 completion 不确定时改为 ASK_USER。 |
| 高 | 下游超时拖垮 Stop Hook | deterministic 500ms、semantic 3s 与外层剩余时间取最小并 Abort。 |
| 高 | Hook 故障阻塞 Codex | 异常统一 UNKNOWN，Stop stdout 序列化为合法空对象 `{}`。 |
| 中 | `session:turn` 字符串连接产生 counter key 碰撞 | 使用 JSON tuple 编码。 |
| 中 | 验证器/上下文异常把秘密写进诊断 | diagnostic 去换行/NUL 并截断 500 字符；不进入 Stop reason。 |
| 中 | Correction 重放完整任务导致重复工作 | 只序列化未满足 Gate 描述和违规 Boundary path。 |
| 中 | Context retry 注入完整 Envelope | 只加载 verifier 指定 ID 的 L3 delta 与 trace ID。 |
| 中 | Semantic 在不需要时增加延迟 | 仅 deterministic 返回 semantic unavailable 时调用可选端口。 |
| 中 | 外层剩余时间为负仍调用下游 | deadline 在小于 1ms 时立即失败开放。 |
| 中 | Context trace 无法追踪 | trace ID 强制非空、无控制字符且不超过 500 字符。 |
| 中 | counter 早占用导致 Port 失败也损失额度 | 所有验证和 delta 成功后才 claim。 |
| 中 | 用户/任务 identity 串线 | `turn_id` 必须与 Closure taskId 一致；counter 同时绑定 session/turn。 |
| 中 | 短进程内存 counter 被误当持久保证 | Store 明确端口化，设计文档要求生产短进程装配持久实现。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| Stop 专项 | 9/9；Lines 97.64%、Branches 90.52%、Functions 100% |
| Closure + Stop 联合回归 | 18/18；Lines 98.92%、Branches 90.69% |
| 全仓 | 509/509 模块；43/43 架构/Gate |
| 整体覆盖率 | Lines 97.07%、Branches 90.18%、Functions 98.76% |
| Workspace | 31 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-602 七项验收满足，联合修复 CKL-601 两处目标语义缺口，19 项风险全部修复，无遗留 actionable finding。短进程部署必须使用持久化 `ContinuationCounterStore`，该约束属于 CKL-703 装配验收，不阻塞当前模块。可以进入 CKL-603。
