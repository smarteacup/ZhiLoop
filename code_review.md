# ZhiLoop Code Review

## 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | CKL-301 / Project Identity Resolver |
| CR 耗时 | 520s |
| 高风险 | 5 个 |
| 中风险 | 7 个 |
| 低风险 | 0 个 |
| 修复程度 | 已修复 12/12（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 18 次 |
| 总耗时 | 7360s |
| 高风险累计 | 40 个 |
| 中风险累计 | 72 个 |
| 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次新增 `@zhiloop/project-identity`，通过纯 Remote 规范化规则、Git CLI Probe 和 filesystem fallback 生成 ProjectContext。portable Git 身份跨 worktree/clone 稳定，本地 Git 使用 common-dir，无 Git 使用 real root + marker。

模块不联网、不修改 Git、不读取源码正文。Git 命令使用 execFile 参数数组，并通过超时和输出上限隔离异常仓库。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 高 | `resolver.ts` / portable identity | 把当前 repositoryRoot 放入 portable ID 会让 linked worktree 和不同 clone 变成不同项目。 | Scope、证据和知识历史被拆分 | portable ID 只由版本域和 normalized Remote 生成；root/branch 只保留为 Context。 |
| 增 | 高 | `resolver.ts` / remote normalization | 直接保存 HTTPS Remote 会泄露 username/token，并让 SSH/HTTPS 同仓得到不同 ID。 | 凭证泄露、项目重复 | 去除 scheme/凭证/query/fragment/default port/.git；常见托管站统一 path 大小写。 |
| 增 | 高 | `resolver.ts` / local worktree | 无 Remote 时按 worktree root 哈希仍会拆分同一仓库。 | 本地项目知识无法共享 | 使用 real `git-common-dir` 生成非 portable ID；真实 linked worktree Gate 通过。 |
| 增 | 高 | `resolver.ts` / Git execution | shell 拼接 cwd、branch 或 remote name 可触发命令注入。 | 本地任意命令执行 | 仅用 execFile + 参数数组；remote name/branch/facts 有格式、长度和控制字符门禁。 |
| 增 | 高 | `resolver.ts` / custom marker | 自定义 `../marker` 可越过祖先扫描目录并把无关路径作为根标记。 | 项目误合并、越界探测 | marker 必须是 1～255 字符单一相对 basename，拒绝 absolute、`.`、`..` 和 separator。 |
| 增 | 中 | `resolver.ts` / remote collision | 不同 Remote 若过度 lower-case 自建 Host path，可能把大小写敏感仓库合并。 | 两项目同 ID | 只对已知大小写不敏感 Host lower path；自建 Host 保留大小写。 |
| 增 | 中 | `resolver.ts` / malformed remote | SCP host、编码 dot segment、local/file URL 可产生看似 portable 的伪身份。 | 不可移植 ID 被跨机使用 | 校验 host label/path，拒绝 encoded dots、local/file 和 unsupported scheme，降级 local。 |
| 增 | 中 | `resolver.ts` / multiple remotes | remote 枚举顺序或 branch 配置变化会随机选择不同身份。 | Project ID 抖动 | 固定 pushDefault > branch remote > origin > sorted first；非法和 `.` remote 跳过。 |
| 增 | 中 | `resolver.ts` / hanging Git | Git hook/config 或异常进程输出可能阻塞后台 Resolver。 | Worker 延迟、内存增长 | 单命令默认 2s/最大30s，maxBuffer 64KiB，不触网。 |
| 增 | 中 | `resolver.ts` / symlink | 同一路径的 symlink/真实路径若直接字符串哈希会产生两个本地 ID。 | 本地知识重复 | cwd、root、common-dir 全部 realpath + NFKC。 |
| 增 | 中 | `resolver.ts` / sequential subprocesses | 6～7 个 Git 子进程串行执行中位约57.49ms。 | 高频 Prompt 后台开销 | 独立只读命令分两组并行；中位降至31.31ms、P95 32.11ms。 |
| 增 | 中 | `vitest.config.ts` / coverage | 新包可能再次遗漏全仓 coverage include。 | Gate 假绿 | Project Identity 纳入 coverage；Lines 98.13%、Branches 88.23%。 |

## 删除与兼容性检查

- 没有删除或修改 ProjectContext 字段、Scope 类型、Episode Builder projectResolver 或既有 ID。
- TDD 将原抽象公式细化为 portable Git / local Git / filesystem 三个带版本域公式；尚无生产 Project ID 数据需要迁移。
- 根 Project References、lockfile、coverage include 新增第 13 个 workspace；依赖图无环，新包只依赖 Domain 和 Node 内置模块。
- Episode Builder 当前默认 fallback 保持不变；Daemon 后续应显式注入本 Resolver 结果，避免未装配时悄然改变既有测试行为。

## 配置检查

没有新增环境变量、Git 写配置、网络地址或用户目录。Git executable/timeout 和 marker names 是构造参数，默认值受硬上限约束。

## Gate 证据

| 检查项 | 结果 | 结论 |
|---|---|---|
| Project Identity 专项 | 9/9 | 通过 |
| 真实 Git worktree | Remote 与无 Remote 两种身份均一致 | 通过 |
| 架构/Gate | 27/27 | 通过 |
| 全仓模块 | 285/285，25 Test Files | 通过 |
| 覆盖率 | Resolver Lines 98.13%、Branches 88.23%、Functions 100%；整体 Lines 96.77% | 通过 |
| 性能 | 真实仓库中位31.31ms、P95 32.11ms | 通过 |
| 供应链 | npm 官方 registry 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- Remote normalization/hash 是微秒级；主要成本是 Git 子进程。并行化后真实仓库 P95 32.11ms。
- Resolver 不应位于 Hook 同步快路径，也不应按 Event 重复调用；Daemon 应按 root/common-dir 缓存，并在 Git config/worktree 变化时失效。
- Filesystem fallback 最坏向上扫描到文件系统根，每层按固定 marker 列表 access；只在 Git Probe 失败时发生。

## 已知边界

- Git 不可执行时无法获得 linked worktree common-dir，只能明确降级 FILESYSTEM_LOCAL。
- 不验证 Remote 可达性；identity resolution 永不触网。
- 没有实现 Daemon 缓存、Git config watcher 或 Episode Builder 自动装配。
- CodeGraph 尚未初始化；影响范围通过真实 Git worktree、攻击输入、全量 TypeScript、依赖边界和全仓测试验证。

## Review 结论

CKL-301 未发现未修复风险，三项验收条件全部满足。可以进入 CKL-302 Scope Resolver。
