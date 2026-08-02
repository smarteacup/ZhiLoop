# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-403 | 26 次 |
| 耗时 | 600s | 11720s |
| 高风险 | 6 | 85 |
| 中风险 | 9 | 133 |
| 低风险 | 0 | 0 |
| 修复程度 | 15/15（100%） | 100% |

## 改动说明

新增 `@zhiloop/knowledge-indexer`：contentHash 增量判断、稳定 heading chunk、合法手工内容 adoption、跨版本单资产事务替换、去抖/max-wait 调度和 Node 文件 watcher。Registry 新增原子 `replaceAssetHistory`。

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 持续 watcher 事件不断重置 debounce，资产永不生效 | 独立 2s max-wait，不被后续事件重置。 |
| 高 | 手工 VERIFIED/Scope/Evidence 提升被自动 adoption | 复用 CKL-401 protected trust gate，失败 SKIPPED_UNSAFE 且旧投影保留。 |
| 高 | 合并事件跨多个版本时逐个切换中间索引 | `replaceAssetHistory` 在单事务中替换 1..N 和 active。 |
| 高 | 断裂/非法历史先删除旧投影 | 全部版本事务前读取；失败返回诊断，不触碰 SQLite。 |
| 高 | Chunk sink 失败后 contentHash 被视为完成，永不重试 | 独立 sink 状态；SQLite 不回滚，下一事件只重试 chunks。 |
| 高 | watcher 路径越界映射其他资产 | root-relative、固定 assets 布局、safe assetId/version 文件白名单。 |
| 中 | 重复/乱序事件重复索引 | batch Set 去重，最终以 current/contentHash 为准。 |
| 中 | 资产异常中断同批其他资产 | syncMany 逐资产故障隔离和结构化诊断。 |
| 中 | 未变段落跨版本 chunkId 抖动 | ID 排除 version，绑定 heading occurrence、part 和内容 hash。 |
| 中 | current 物理删除误当 tombstone | 只接受显式 tombstone；删除/非法 current 保持旧投影。 |
| 中 | 调度器关闭后仍有后台写 | close 清 timer 并等待在途 batch，可选择丢弃 pending。 |
| 中 | watcher 异步 error 未处理导致进程崩溃 | 内部 error listener 保存 lastError，并提供 onError 回调。 |
| 中 | fs.watch 重复 adoption 自激 | adoption 产生的事件命中相同 contentHash，UNCHANGED 不增 indexVersion。 |
| 中 | chunk 过大或空正文 | 200～20,000 chars 硬边界、段落切分、summary fallback。 |
| 中 | 新 Registry API 覆盖率回退 | 补充连续性、active 匹配、成功替换专项；Registry Lines 94.52%。 |

## 配置、兼容性与性能检查

没有数据库 Migration、环境变量或用户配置。新增 watcher/scheduler 仅在装配显式 start 后运行，本次未启动 Daemon、未监控用户目录。10 次内容变化、每次 100 个重复通知：Median 286.239ms、P95 295.755ms；默认 250ms debounce 是主要延迟，远低于 5s SLA。

## Gate 证据

| 检查项 | 结果 |
|---|---|
| Indexer 专项 | 12/12；Lines 97.98%、Branches 92.85% |
| Registry 扩展 | 14/14；Lines 94.52%、Branches 89.83% |
| 全仓 | 384/384 模块；38/38 架构/Gate |
| Workspace | 20 个 workspace，依赖方向和源码 import 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-403 的三项验收条件全部满足，15 项风险已修复，无未解决高/中风险。可以进入 CKL-404 VectorIndexPort。
