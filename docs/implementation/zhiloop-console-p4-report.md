# ZhiLoop Console P4 实施与真实验收报告

## 1. 结论

`build-zhiloop-console` 的 P0-P4 范围已经实现并部署为 ZhiLoop `0.3.9`。当前安装运行在当前用户 macOS LaunchAgent 的 `SHADOW` 模式：知识生产、检索、Codex 辅助问答、注入/MCP 审计、闭环和治理链路均已接通；没有经过 ACTIVE 资格和灰度门禁的内容不会实际进入模型上下文。

控制台是只读会话目录与受控治理面，不提供 Codex 对话写入能力。Sidecar 仍是 Ledger、任务、配置、知识状态和审计数据的唯一写入者。

## 2. 已交付模块

| 层 | 模块 | 关键能力 |
|---|---|---|
| Contract | `packages/control-api` | 版本化 schema、状态/原因码、cursor、revision、idempotency |
| P0 | Session Catalog、Operational Read Model、Gateway、Web | 会话目录、总览、任务、诊断、部署状态与安全本地会话 |
| P1 | Durable Job、自动采集、Configuration、Observability | lease/checkpoint/retry、增量发现、草稿/激活/回滚、告警和 SSE |
| P2 | Knowledge Worker、Extraction、Registry、Governance | snapshot、candidate、Evidence、Markdown/SQLite、版本治理与双向 provenance |
| P3 | Retrieval Query、Codex Query | Exact/FTS/Vector/Relation、RRF、Context Envelope、trace、带引用问答 |
| P4 | Active Runtime、MCP、Closure、Feedback、Rollout | 真实投递审计、L1→L2/L3、有限闭环、质量证据、灰度和高风险确认 |
| Deploy | Local Deployment、CLI | 不可变 release、LaunchAgent、Hook 共存、journal、doctor、回滚、UI |

## 3. 真实会话链路

验收会话：`019f837a-34d4-7e60-800c-6361f6fb6d49`。

1. 采集到 Ledger 的 source sequence 为 `3..100`，共 98 个事件、49 个 Turn。
2. 会话仍活跃，因此 snapshot 明确标记 `PARTIAL`；不伪装为完整闭合会话。
3. 当前有效 snapshot 为 `snapshot_397d195e58e31ff32f8363a2d2ee19701abd71a15d190fa1`，绑定 compiler v3、policy 与 configuration identity。
4. 模型生成 8 条 Candidate；策略提交后 6 条成为 `ACCEPTED`、eligible 且已索引的知识版本，2 条保留为 `PROPOSED`。
5. 精确自然语言检索 `DMS 3213 Codis idempotency` 返回 FTS rank 1、L1 pointer、三条 Evidence 和完整 Retrieval Trace。
6. “问 ZhiLoop”在真实浏览器中 44.0 秒返回 `SUCCEEDED`，答案只引用 `9812cc...@1`，unsupported facts 为 0。
7. 当前 rollout 为 SHADOW，因此 retrieval/injection audit 显示 `SHADOWED`，没有伪造 `INJECTED`。

## 4. 部署与安全验收

| 检查 | 结果 |
|---|---|
| 版本 | `0.3.9` |
| LaunchAgent | `dev.zhiloop.sidecar` READY |
| Doctor | release、权限、service、compatibility、rollout 全部 PASS |
| 部署事务 | journal `COMMITTED`；失败路径验证自动逆序回滚 |
| 升级配置 | 未传 `--codex-executable` 时继承已有受管绑定；显式参数覆盖 |
| READY 等待 | 冷启动有界等待 15 秒，超时仍回滚 |
| Gateway | loopback only、一次性 bootstrap、HttpOnly session、CSRF/Origin/Host/CSP |
| Codex query | read-only、ephemeral、MCP disabled、最小环境、120 秒最大门禁 |
| CCM | `~/.ccm/config.json` SHA-256 保持 `fdfcd36b64b35783ce2a8895d86dff5ac91a50798a3ebc836ac7a56ffb84178b` |
| 隐私 | 日志与诊断不保存 prompt、知识正文、凭证或完整环境变量 |

## 5. 本轮真实验收发现并修复的问题

1. retryable worker failure 在自动 attempt 用尽后被错误固化为不可重试；现支持显式 terminal retry，且不重放成功阶段。
2. 无新增事件时错误复用旧 pipeline snapshot；现将 compiler/policy/config identity 纳入复用条件。
3. release builder 可能复制 stale `dist`；现校验构建产物版本与 release manifest 一致。
4. 启动期 future 配置错误标记为无需重启；现四个消费者字段都返回 `requiresRestart`。
5. 统一任务页的 P2 job cancel/retry 错误路由到 P1；现按 durable store 所有权分派。
6. Gateway 与浏览器分别存在 15 秒和 10 秒问答截断；现普通查询保持短门禁，模型问答端到端允许 120 秒。
7. 升级会丢失 Codex executable 绑定；现安全继承已有受管配置。
8. LaunchAgent 冷启动偶发超过 5 秒；现 READY 门禁扩展到有界 15 秒并保留事务回滚。

## 6. 已知非阻塞限制

- 当前 lexical FTS 不提供跨语言语义翻译。知识标题为英文时，纯中文同义查询可能 `NO_CONTEXT`；精确符号、错误码、配置键和同语种自然语言查询不受影响。后续可通过多语言 alias 或向量模型改善，不能用无证据模型回答掩盖未召回。
- Linux/Windows 安装器与跨机器同步不属于本变更。
- ACTIVE 不是安装后的默认状态，也不应通过单一布尔配置开启。

## 7. 运维入口

```bash
~/.local/bin/zhiloop doctor --json
~/.local/bin/zhiloop ui
~/.local/bin/zhiloop capture --session <session-id> --dry-run --json
```

完整构建门禁使用 `npm run check`，本地安装门禁使用 `npm run verify:shadow`。
