# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | `main@36f7407+build-zhiloop-console-p0b` |
| CR 耗时 | 210s |
| 🔴 高风险 | 1 个 |
| 🟡 中风险 | 3 个 |
| 🟢 低风险 | 0 个 |
| 修复程度 | 已修复 4/4（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 50 次 |
| 总耗时 | 23649s |
| 🔴 高风险累计 | 224 个 |
| 🟡 中风险累计 | 312 个 |
| 🟢 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次变更交付 ZhiLoop Console 的 P0b 只读基础：会话目录只读发现 Codex transcript，SQLite 运行态读模型提供稳定分页投影，本地 Gateway 负责浏览器安全边界，React Web 展示能力、会话、事件、任务和诊断。核心链路保持 Sidecar 单写入者约束，Gateway 和浏览器都不能直接写 Ledger 或 Codex 会话。

对外新增版本化 Control API 查询、Unix Socket 客户端以及 loopback HTTP 页面。浏览器认证使用一次性 fragment bootstrap、短期 HttpOnly SameSite 会话和内存 CSRF token；生产知识、召回、闭环和配置写入仍以真实 `DISABLED/NOT_COMPOSED` 状态展示，没有硬编码 READY。

新增 workspace、React/Vite/jsdom 依赖和显式覆盖率入口；没有放宽 SHADOW、Hook 时限或 CCM 凭证边界。Session Catalog、Operational Read Model、Gateway、Web 均有直接模块测试，并纳入根级 build、lint、测试类型检查和依赖边界门禁。

## 风险矩阵

| 维度 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增/认证契约 | 🔴 高 | `apps/console-web/src/main.tsx`、`apps/console-gateway/src/server.ts` | Web 初版向 bootstrap 端点发送 `{bootstrap}`，Gateway 严格要求 `{token}`；真实 launcher 首次打开会稳定返回 400，控制台无法进入。 | 所有真实 UI 启动，属于 P0 发布阻塞。 | 提取 `api/bootstrap.ts` 作为单一客户端契约，改为 `{token}`，fragment 立即从地址栏清除，并新增 URL 不携带 token 的直接回归，已修复。 |
| 增/React 外部状态 | 🟡 中 | `apps/console-web/src/app/routes.ts` | `useSyncExternalStore` 的 snapshot 每次返回新对象，React 19 会认为状态持续变化并触发最大更新深度错误。 | Overview 和所有路由首次渲染。 | snapshot 改为稳定 hash 字符串，再纯解析为路由；增加畸形编码回退测试，已修复。 |
| 增/本地协议严格性 | 🟡 中 | `apps/console-gateway/src/control-client.ts` | Unix Socket 客户端初版解析首个换行后忽略同一响应中的尾随 frame，协议污染不能被发现。 | 本地 Sidecar 异常、被替换或输出串帧时的响应完整性。 | 要求响应恰好只有一个换行终止 frame，尾随数据直接 `PROTOCOL`；新增双 frame 回归，已修复。 |
| 增/测试门禁 | 🟡 中 | `vitest.config.ts`、`tsconfig.test.json` | 根测试 glob 只覆盖 `.test.ts`，遗漏 React `.test.tsx`；UI 无限渲染问题因此最初未进入门禁。 | Console Web 回归可靠性和发布 Gate。 | Vitest、测试类型检查和覆盖率排除规则同时纳入 TSX，并补齐 DOM/JSX 类型环境，已修复。 |

## 配置检查

| 配置/边界 | 变更前 | 变更后 | 结论 |
|---|---|---|---|
| Gateway bind | 无 | 显式 `127.0.0.1`/`::1`，拒绝非 loopback | 远程绑定直接失败 |
| 浏览器会话 | 无 | 一次性 bootstrap + 15 分钟默认 TTL + CSRF | token 不进入 query、cookie 非脚本可读 |
| Control 消息上限 | 既有 1 MiB 契约 | Gateway/Unix 客户端统一执行 | 请求与响应都有硬上限 |
| rolloutMode | `SHADOW` | `SHADOW` | 未放宽注入门禁 |
| Browser persistence | 无 | 明确禁止 local/session storage 与 IndexedDB | 会话/知识不在浏览器持久化 |

仓库没有 pre/prod/inner 多环境配置。本阶段新增值均为构造参数和有界默认值，部署期仍需在 P0c launcher/release 中提供唯一配置来源。

## Gate 证据

| 检查项 | 结果 |
|---|---|
| Session Catalog | 10/10，通过路径、symlink、格式、缓存、增量与 250 会话复杂度回归 |
| Operational Read Model | 6/6，通过迁移回滚、重建等价、10 万事件分页和泄漏审计 |
| Gateway + Web | 31/31，通过认证、CSRF、路径、限流、Unix 协议、键盘和浏览器存储边界 |
| Build / lint / test typecheck | 全部通过 |
| Workspace/import policy | 46 workspaces，通过 |

## Review 结论

P0b 的身份、路径、分页、事务、响应大小、认证、CSRF、敏感信息和浏览器存储边界已有直接实现与测试证据。本轮发现一个发布阻塞高风险和三个中风险，均已闭环；当前无遗留 actionable finding。Sidecar 查询组合、capture preview/commit 和本地发行仍属于下一阶段 P0c，不能把当前模块状态标记为完整可部署。
