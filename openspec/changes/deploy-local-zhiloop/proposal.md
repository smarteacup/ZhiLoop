## Why

ZhiLoop 的源码能力和插件包装已经完成，但当前机器没有 `zhiloop-sidecar`、`~/.ckl`、Codex/CCM Hook 或常驻进程，真实对话无法进入沉淀、召回和闭环链路。现在需要把源码基线转化为可验证、可回滚、默认不影响模型输出的本地部署。

## What Changes

- 生成可直接执行的 `zhiloop-sidecar` 发行物，提供 `hook`、`health`、`worker` 和前台 daemon 生命周期入口。
- 提供 macOS 当前用户级安装、升级、诊断和卸载流程；安装前生成计划与备份，失败时原子回滚。
- 初始化权限收窄的 `~/.ckl` 目录、运行配置、日志/状态目录和版本清单，不迁移或发布真实知识。
- 以非覆盖合并方式安装 Codex 与 CCM Hook，保留未知配置和既有凭证；卸载时只移除 ZhiLoop 自己管理的内容。
- 注册用户级 launchd 服务并执行健康检查，默认以 SHADOW 模式启动，Hook/sidecar 不可用时失败开放。
- 增加临时 HOME 的安装/升级/卸载、故障注入和真实本机 SHADOW 验收证据。

## Capabilities

### New Capabilities

- `local-zhiloop-deployment`: 定义 sidecar 发行物、用户级可逆安装、launchd 生命周期、Codex/CCM 集成和 SHADOW 首启验收契约。

### Modified Capabilities

无。仓库当前没有已同步的部署 capability 基线。

## Impact

- 应用与发行：`packages/daemon-runtime`、新增 sidecar composition/CLI、根构建与发布脚本。
- 插件与安装：`packages/plugin-runtime`、`plugins/zhiloop`、Codex/CCM 配置合并。
- 用户环境：`~/.local/bin`、`~/.local/share/zhiloop`、`~/.ckl`、`~/Library/LaunchAgents`、`~/.codex`、`~/.ccm`。
- 安全与运维：目录权限、备份/回滚、结构化健康检查、日志限界和 SHADOW→ACTIVE 门禁。
