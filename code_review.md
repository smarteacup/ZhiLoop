# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-506 | 35 次 |
| 耗时 | 480s | 16260s |
| 高风险 | 8 | 140 |
| 中风险 | 9 | 208 |
| 低风险 | 0 | 0 |
| 修复程度 | 17/17（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 项目 A Envelope 注入项目 B | Prompt fingerprint、project/task、每项 Scope 与 Trace 双重一致性校验。 |
| 高 | 500ms 超时或 Provider 异常阻断原始 prompt | 所有失败结果无 hook output；序列化为空 stdout，Codex 继续。 |
| 高 | Provider 响应 Abort 的 rejection 抢先导致误分类 | timeout flag 在 Abort 前设置，catch 以该 flag 为准。 |
| 高 | OFF 回滚后在途 Provider 迟到仍注入 | 请求完成前重读 revision/mode；变化即 ROLLED_BACK。 |
| 高 | 未通过 Golden Gate 直接启用 ACTIVE | ACTIVE 强制 passing Evidence、dataset version 和 SHA-256 config fingerprint。 |
| 高 | REFERENCE 中 instruction-like 文本被当成命令 | 显式 Authority 语义、JSON 数据边界和用户/高优先级指令优先声明。 |
| 高 | Envelope 与 Trace 注入集合被替换 | ID/版本/Scope/Authority/detailLevel 顺序完全一致才渲染。 |
| 高 | Hook 输出使用错误 Codex 事件契约 | 对照当前官方 Manual，仅输出支持的 `continue` 和 `hookSpecificOutput.additionalContext`。 |
| 中 | Rollout Evidence 可由调用者事后修改 | activate 时 structuredClone，快照与嵌套 Evidence 递归 freeze。 |
| 中 | 非法 Hook input 进入 Provider | 校验事件、session/turn/cwd/prompt、permission/model/transcript 边界。 |
| 中 | Provider error 含控制字符或长敏感正文 | diagnostic 去 NUL/换行、限制 500，且不序列化到 stdout。 |
| 中 | timer 保持进程或完成后误触发 | timer `unref` 并在 finally 清理。 |
| 中 | 空 Envelope 产生无意义 developer context | 无知识且无 Task Contract 时返回 NO_CONTEXT。 |
| 中 | Task Contract 被误当成动态知识替代品 | 仍是独立 JSON 区块；没有知识时可单独注入。 |
| 中 | Feature revision 回退或重复 | revision 必须为递增安全整数。 |
| 中 | Trace/Run ID 包含控制字符污染日志 | 输出前按有限单行文本校验。 |
| 中 | Renderer 字段顺序不稳定影响快照与调试 | 对对象 key 做稳定排序后 JSON 序列化。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | Codex Context Injection 14/14；Lines 95.94%、Branches 88.42% |
| 全仓 | 485/485 模块；40/40 架构/Gate |
| 整体覆盖率 | Lines 97.04%、Branches 90.21% |
| Workspace | 28 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-506 七项验收满足，17 项风险全部修复，无遗留 actionable finding。可以进入 CKL-507。
