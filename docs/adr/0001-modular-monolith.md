# ADR-0001：采用模块化单体与端口适配器

**状态**：Proposed  
**日期**：2026-08-01

## 背景

CKL 首版是本地运行系统，但需要同时隔离 Codex、CCM、存储、代码分析、模型和检索实现，以支持后续内容调整和插件化。

## 决策

采用 TypeScript/Node 模块化单体。领域包只包含类型、状态机和端口；Codex、SQLite、Markdown、模型和代码分析作为基础设施适配器。进程间拆分仅限 Hook Handler 与后台 Daemon。

```mermaid
flowchart LR
    H["Hook Handler"] -->|"EventEnvelope"| D["Daemon"]
    D --> A["Application Modules"]
    A --> P["Domain Ports"]
    P --> I["Infrastructure Adapters"]
```

## 原因

- 本地部署和调试成本低。
- 可以使用单个 SQLite 事务保证一致性。
- 包边界足以隔离易变适配器。
- 后续可按端口拆分服务，而不重写领域协议。

## 替代方案

### 单包脚本

优点是启动快；缺点是 Codex 格式、存储和知识策略会互相耦合。拒绝。

### 微服务

优点是独立部署；缺点是本地运维、通信和一致性成本过高。首版拒绝。

### 多进程插件集合

优点是隔离强；缺点是版本兼容和故障诊断复杂。仅保留为未来部署方式。

## 后果

- 必须建立包依赖检查和公开 API。
- 禁止跨包访问内部数据表或文件布局。
- Daemon 是首版唯一应用编排入口。
- 插件只能包装 Adapter，不允许复制领域逻辑。

## 成功指标

- Domain 包不依赖任何外部系统 SDK。
- 循环依赖数量为 0。
- Codex Hook Adapter 可被 Fixture Adapter 替换并通过相同契约测试。

