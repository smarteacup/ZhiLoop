# CKL-104 Hook Handler 与本地 Spool

## 1. 模块边界

`@zhiloop/hook-runtime` 是 Codex Hook 进程内的轻量运行时，只执行四件事：

1. 从 stdin 接收有上限的 Hook JSON；
2. 复用 `ingestion-codex` 将输入转换成 `EventEnvelope`；
3. 对完整事件信封脱敏，并在不超过 100 ms 的入队期限内交给 Daemon Sink；
4. Sink 拒绝或超时时，把脱敏事件原子写入本地 Spool。

该模块不加载 SQLite 聚合入口，不调用模型，不扫描代码，不启动 Worker，也不重建索引。Daemon 传输协议仍由后续部署模块装配；当前通过 `HookEventSink` 端口隔离。

## 2. 失败开放语义

| 场景 | Hook 结果 | Codex 退出码 | 数据处理 |
|---|---|---:|---|
| 输入合法且 Daemon 接收 | `enqueued` | 0 | Daemon 后台入账 |
| Daemon 拒绝/不可用 | `spooled` | 0 | 本地原子落盘 |
| Daemon 超过入队期限 | `spooled` | 0 | 中止信号发送给 Sink，本地原子落盘 |
| Hook 输入无效或过大 | `dropped-invalid` | 0 | 不保存不可信输入，只返回结构化诊断 |
| Daemon 与 Spool 同时失败 | `dropped-spool-failed` | 0 | 不阻塞 Codex；只暴露错误类型，不暴露正文 |

`runCodexHookCommand` 对运行时路径固定返回 `exitCode: 0`，且不向 stdout 输出协议外内容。安装时仍应使用 Codex Hook 自身的外部 timeout 作为进程级硬上限。

## 3. Spool 存储协议

每个事件对应一个文件，文件名为 `SHA-256(eventId).json`。记录格式为：

```json
{
  "spoolVersion": 1,
  "queuedAt": "2026-08-01T08:00:00.000Z",
  "redactionCount": 1,
  "event": {}
}
```

- 目录权限为 `0700`，事件文件权限为 `0600`；拒绝符号链接目录和符号链接文件。
- 写入先创建同目录临时文件、写入并 `fsync`，再通过硬链接原子提交，最后同步目录。
- 确定性目标文件实现跨 Hook 进程去重；相同 `eventId` 但信封不同会抛出冲突，不会覆盖。
- payload 与 session/turn/path 等信封元数据均在落盘和入队前脱敏；`eventId` 与来源 `contentHash` 保持稳定。
- 损坏记录改名为 `.corrupt-<uuid>` 保留取证，不阻塞后续有效记录恢复。

## 4. 恢复与幂等

Daemon 调用 `LocalEventSpool.drain()`，按 `occurredAt`、`queuedAt` 和文件名稳定排序当前有界批次。只有 Sink 确认接收后才删除活动文件；删除失败时文件保留，后续重复投递由 SQLite Ledger 的唯一 `eventId` 和内容冲突检查吸收。

单次扫描默认最多打开 100 个事件文件，文件列表使用流式目录迭代，避免大 backlog 一次性进入内存。`scanTruncated`、`remaining`、诊断和停止原因供 Daemon 调度重试或告警。

## 5. 验证结果

- 27 条 Hook Runtime 专项测试覆盖成功入队、Sink 拒绝、严格超时、完整信封脱敏、stdin 越界、并发落盘、权限、符号链接、损坏隔离、取消、清理失败和 SQLite 幂等补录。
- Hook Runtime 覆盖率：Lines 98.00%，Branches 92.30%，Functions 100%。
- Node.js 24.18.0、2,000 次内存 Sink 样本：P50 0.0288 ms，P95 0.0407 ms，P99 0.0795 ms，最大 0.5865 ms。
- 测试仅使用内存 SQLite 和系统临时目录；未创建 `~/.ckl`，未安装 Codex Hook，未修改 Codex/CCM 配置。
