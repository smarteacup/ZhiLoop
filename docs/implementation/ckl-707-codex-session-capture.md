# CKL-707：指定 Codex 会话主动采集

## 目标与边界

CKL-707 允许用户按本地 Codex session ID 主动回填历史或正在运行的会话，解决 Hook 安装前会话、Hook 未热加载和手动选择重点会话的沉淀问题。本模块只保证规范化事件进入 conversation ledger，不把事件入库等同于知识已经编译或可注入。

## 模块拆分

| 模块 | 职责 |
|---|---|
| `codex-session-capture/locator` | 在配置根目录下有界扫描，以首条 `session_meta` 精确确认会话身份 |
| `codex-session-capture/service` | 调用 transcript adapter、统计投影、批量 append、append 后提交游标 |
| `conversation-ledger/ingestion_cursors` | 持久化带完整性校验的 adapter 锚点游标 |
| `sidecar/application` | 串行化采集任务，并让 Hook spool 快路径独立运行 |
| `sidecar/transport` | 通过 `0600` Unix socket 接收有界 `capture-session` 请求 |
| `deployment-cli` | 提供 `capture --session ... [--dry-run]` 和稳定退出码 |

## 一致性模型

每个读取批次先执行 ledger append，再提交对应 transcript cursor。若进程在两者之间中断，下一次会重放同一批事件；transcript adapter 生成的 event ID 是确定性的，ledger 会返回 duplicate 而不会新增行。反过来，游标绝不先于事件推进，因此不会静默丢失会话片段。

`ingestion_cursors` 使用独立表但不提升 SQLite `user_version`，使旧的 `0.1.2` 仍能打开带有新表的 ledger，满足部署失败时的可回滚性。

## 安全与性能边界

- session selector 禁止空值、NUL、换行、路径分隔符和超过 200 字符。
- sessions root 必须是绝对目录，遍历不跟随 symlink；深度、文件数量、首行、单行、单批和总批次数均有上限。
- 身份只由首条 `session_meta` 决定，正文命中和文件名命中都不是授权依据。
- 日志只含组件、稳定 code、时延和数量，不含 prompt、assistant message 或坏行正文。
- CLI 不直接写 SQLite；采集变更由 Sidecar 单写者完成。
- 采集任务串行化，但 Hook 仍先落本地 spool，不等待历史 transcript 读取完成。

## 当前事件覆盖

现有 transcript adapter 投影：

- `session.started`
- `user.prompted`
- `turn.stopped`，包含该轮 `last_agent_message`

其他 rollout 项（工具调用、工具输出、隐藏 reasoning、中间 agent 消息、token 统计等）被有意识地忽略。若后续需要更丰富的证据，应先扩展统一事件 taxonomy、schema 和 normalizer，再调整采集器，避免把 Codex 私有 rollout 结构直接泄漏到知识层。
