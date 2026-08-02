# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-401 | 24 次 |
| 耗时 | 780s | 10520s |
| 高风险 | 7 | 72 |
| 中风险 | 9 | 116 |
| 低风险 | 0 | 0 |
| 修复程度 | 16/16（100%） | 100% |

## 改动说明

新增 `@zhiloop/markdown-repository`，实现严格 Front Matter、确定性 contentHash、原子 current、不可覆盖版本、乐观并发、故障恢复、tombstone、旧版恢复和受控手工编辑固化。新增 workspace 构建/覆盖率配置和技术规格，不读写用户目录。

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | current 与 version 共用 hard link，手工编辑会篡改历史 | 改为两个独立 fsynced temp/inode，并用测试逐字验证历史不变。 |
| 高 | 合法 YAML 手工把 ACCEPTED 提升为 VERIFIED 或扩大 Scope | 读取标记 MANUAL_EDIT；Status/Scope/Evidence/confidence 等信任字段禁止 adoption。 |
| 高 | 同版本 current 存在但 version 缺失时误报幂等 | 幂等前强制核对不可变版本；缺失时原子补齐，冲突时拒绝。 |
| 高 | 两进程覆盖相同版本 | hard-link create-if-absent；已存在内容必须逐字一致。 |
| 高 | 路径穿越或目录/file symlink 读取越界 | 单段 assetId 白名单、目录 lstat、文件 O_NOFOLLOW。 |
| 高 | 写入中断留下半文件或覆盖 current | fsynced 临时文件、版本先提交、current 原子 rename、失败临时文件清理。 |
| 高 | PROPOSED 内容进入权威 Markdown | 写入门禁明确拒绝 PROPOSED；tombstone 与普通资产分型返回。 |
| 中 | 未知/重复 Front Matter 或 YAML Alias 绕过解析 | strict + uniqueKeys + maxAliasCount=0 + 顶层字段白名单 + Domain Schema。 |
| 中 | 手工正文变化无法进入不可变历史 | `adoptManualEdit` 生成下一版本和 SUPERSEDES 关系。 |
| 中 | 同 ID 更换 subject/kind/createdAt 接管谱系 | 后续 publish 固定 lineage 字段。 |
| 中 | 恢复旧版覆盖原版本 | restore 创建最高版本 + 1，来源和中间版本保持只读。 |
| 中 | 删除导致正文和证据丢失 | tombstone 新版本保存完整快照、原因和历史。 |
| 中 | 大文件造成内存/延迟异常 | 写前 byte limit、读前 stat limit。 |
| 中 | 文件/目录权限泄漏本地知识 | 目录 0700、文件 0600。 |
| 中 | 新 workspace 未进入覆盖率导致 Gate 假绿 | 加入 TypeScript references、依赖检查和 Vitest coverage include。 |

## 配置、兼容性与性能检查

没有数据库 Migration、环境变量、Hook 或 Daemon 配置。Front Matter v1 为新格式，没有旧数据迁移。100 个独立资产原子发布 Median 17.713ms、P95 22.819ms；主要成本是 durability 所需 fsync，未发现算法型随资产总量增长的写入瓶颈。`listAssetIds` 当前为 O(n) 治理扫描，正式检索由 CKL-402 SQLite 投影承担。

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | 16/16；Lines 97.41%、Branches 85.30%、Functions 100% |
| 全仓 | 358/358 模块；38/38 架构/Gate |
| 整体覆盖率 | Lines 97.02%、Branches 89.91% |
| Workspace | 18 个 workspace，依赖方向和源码 import 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-401 的四项验收条件全部满足，16 项风险已修复，无未解决高/中风险。可以进入 CKL-402 SQLite Registry Projection/FTS5。
