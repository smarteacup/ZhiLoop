# CKL-703：Codex/CCM 插件包装

## 1. 结论

CKL-703 已完成源码实现。仓库新增可被 Codex 直接发现的 `plugins/zhiloop`、仓库级 Marketplace、独立的 `@zhiloop/plugin-runtime`，以及 Hook 安装/卸载、sidecar 生命周期和版本兼容契约。

本次没有安装插件、没有修改 `~/.codex`/`~/.ccm`/`~/.ckl`，也没有启动后台进程。插件运行时要求发行包提供 `zhiloop-sidecar` 可执行文件；未找到 sidecar 时 Hook launcher 以退出码 0 和空 stdout 失败开放，MCP 与 doctor 则明确报告不可用。

## 2. 两种部署形态

| 形态 | 配置方式 | 适用场景 | 卸载方式 |
|---|---|---|---|
| Codex 原生插件 | Codex 从 `hooks/hooks.json`、`.mcp.json` 和 `skills/` 自动发现 | Codex 支持插件时的默认选择 | 禁用/卸载插件；不写用户 Hook 文件 |
| CCM/旧式包装 | 调用 `HookConfigurationInstaller`，向显式绝对路径追加相同 Hook | CCM 插件或不能直接加载 Codex 插件的宿主 | 使用同一 target 和 receipt 执行 `uninstall` |

插件中的 Skill 只告知 Scope、门禁、按需展开和失败降级原则；Hook 调用 sidecar，MCP 调用 sidecar 的 `mcp` 子命令。领域模型、检索、编译、Evidence 和闭环实现都留在既有 Workspace 包中，插件目录不包含 `.ts/.js/.mjs/.cjs` 业务源码。

## 3. Hook 合并与回滚协议

安装器不接受默认 Home 路径，只接受调用方明确传入的两个绝对路径：

- `targetPath`：宿主的 `hooks.json`。
- `receiptPath`：ZhiLoop 私有安装回执。

流程如下：

1. 解析并保留未知顶层字段、未知事件、CCM Hook，以及 Codex 当前只解析但不执行的非 command Handler。
2. 对四个 ZhiLoop matcher group 做 canonical SHA-256；完全相同的条目视为宿主预先拥有，不计入回执。
3. 若同一事件已有不同的 `zhiloop-sidecar` 命令，安装失败，不生成重复 Hook。
4. 以 `PREPARED` 回执作为安装 journal，再原子替换配置，最后将回执推进为 `ACTIVE`。
5. 重启时可从“配置尚未写入”或“配置已经写入但回执未激活”两种崩溃点恢复。
6. 卸载只删除回执记录的 fingerprint。若条目被外部修改，整个卸载不产生部分删除，回执保留供人工/上层宿主修复。
7. 配置未发生语义变化时按原始字节恢复；存在安装后新增的用户/CCM 配置时，只去掉 ZhiLoop 条目并保留新增内容。

配置与回执限制为 1 MiB/2 MiB，创建权限为 `0600`；符号链接、非普通文件、非法 JSON、循环/非 JSON 对象、回执 hash 不一致和目标漂移全部拒绝。

## 4. Sidecar 生命周期

`SidecarLifecycleService` 只依赖两个宿主端口：

- `health(signal)`：读取结构化健康快照。
- `start(signal)`：按宿主部署方式启动 sidecar。

相同进程内的并发 `ensureReady` 只触发一次启动。已经运行但版本不兼容的 sidecar 不会被静默替换或重启；调用方收到全部兼容问题后决定升级。该层不 import 任何 Domain/Storage/Retrieval 包，因此 CCM、Codex 插件和未来其他宿主可以复用同一生命周期逻辑。

## 5. 版本与健康检查

机器可读声明位于 `plugins/zhiloop/compatibility.json`，当前契约为：

- Plugin/最低 sidecar：`0.1.0`，要求相同 major。
- Sidecar protocol：1。
- Codex Hook Schema：`codex-hooks-v1`。
- App Server Schema：`codex-app-server-v2`。
- 最低已测试 Codex CLI：`0.144.4`。

健康检查会同时验证 READY 状态、Plugin contract 版本、sidecar 版本、protocol、Hook/App Server Schema 和启动时间。问题以稳定 code 返回，不把“进程存在”等同于“兼容可用”。完整矩阵见[版本兼容矩阵](version-compatibility-matrix.md)。

## 6. Hook 行为

| Hook | timeout | sidecar 责任 | sidecar 缺失 |
|---|---:|---|---|
| `UserPromptSubmit` | 1s | 最小充分知识注入 | 空 stdout，原 prompt 继续 |
| `PostToolUse` | 1s | 标准化与快速入队 | 空 stdout，工具结果不受影响 |
| `Stop` | 3s | 有限闭环验证 | 空 stdout，允许结束 |
| `SessionEnd` | 3s | 会话结束捕获 | 空 stdout，允许结束 |

`SessionEnd` 使用 Codex 允许的最大 3 秒；其余捕获路径仍由 CKL-104 的 100ms 内部门禁约束。插件 matcher group 与用户、项目、CCM 和 managed Hook 并存，由 Codex 合并执行。

## 7. 性能与瓶颈

100 个已有 matcher group 条件下执行 10,000 次纯内存合并：P50 0.122ms、P95 0.144ms、P99 0.162ms。安装与卸载的实际瓶颈是两个小 JSON 文件的同目录原子写入，不在 Hook 热路径。

Hook 每次启动 launcher 的成本取决于发行包如何实现 sidecar client；知识检索、App Server transport 和后台编译不属于插件目录，必须继续遵守各自 timeout 和队列门禁。

## 8. Review 与验证

Review 修复了 7 个高风险和 9 个中风险问题，包括：PREPARED 崩溃恢复、并发回执覆盖、冲突时部分卸载、安装窗口配置漂移、无 hooks 配置、非 command Handler 兼容、health 伪兼容、回执完整性、非 JSON 对象和缺失 sidecar 输出污染。

```text
npx vitest run packages/plugin-runtime/src --coverage ...
python3 .../validate_plugin.py plugins/zhiloop
node --test scripts/plugin-runtime-boundary.test.mjs
npm run check
npm audit --audit-level=high --registry=https://registry.npmjs.org
```

结果：专项 21/21，Lines 94.98%、Branches 88.93%、Functions 95.83%；插件结构校验通过；全仓 604/604 模块测试、47/47 架构/Gate 测试；36 个 Workspace 边界通过；整体 Lines 97.01%、Branches 90.10%、Functions 98.44%；0 vulnerabilities。

## 9. 运维边界

- 仓库提供源码、插件和包装协议，不把 `zhiloop-sidecar` 二进制复制进插件缓存。
- Codex 插件启用时会要求用户信任其非 managed command Hook；这是 Codex 安全机制，不应绕过。
- CCM 集成方必须把 receipt 放在自身私有状态目录，并为 target/receipt 使用稳定绝对路径。
- 真实安装、sidecar 发行和用户目录迁移需要单独部署授权；源码测试只使用系统临时目录。
