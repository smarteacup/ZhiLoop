## Why

ZhiLoop 当前默认把召回知识按 `L2_COMPACT` 一次性注入，候选较多时会因 token 预算裁掉已成功召回的知识。需要借鉴 Skills 的渐进披露方式：先让 Codex 看见动态筛选后的知识简介，再只展开任务实际需要的正文和证据，同时保证强制门禁不会依赖模型主动发现。

## What Changes

- 首次注入改为混合层级：强制规则和明确需求以 L2 门禁摘要注入，其他候选以 L1 指针注入。
- 在注入上下文中提供明确的 `ckl.search`、`ckl.get`、`ckl.related`、`ckl.check` 展开协议。
- `ckl.search` 和 `ckl.related` 默认返回 L1 知识简介，避免运行中搜索再次批量注入紧凑正文。
- `ckl.get` 支持按需从 L1 展开到 L2，或从 L1/L2 展开到 L3 正文和证据。
- 保持 Scope、状态、当前版本、权限和去重校验在 Push 与 Pull 两条链路一致。
- 增加渐进披露链路模拟、专项测试、Trace 和使用反馈覆盖。

## Capabilities

### New Capabilities

- `progressive-knowledge-disclosure`: 定义动态简介注入、强制门禁保留和 Codex 按需展开知识的行为契约。

### Modified Capabilities

无。仓库此前没有 OpenSpec capability 基线，本次以新能力建立契约。

## Impact

- 编排策略：`packages/context-orchestrator`、`packages/config`、Context Envelope Schema。
- Codex 注入：`packages/codex-context-injection`。
- 运行时知识工具：`packages/knowledge-mcp` 及其 daemon/plugin 适配层。
- 可观测性与评估：Retrieval Trace、反馈记录和链路模拟。
- 文档：ADR、TDD、配置示例和实施说明。
