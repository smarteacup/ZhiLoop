# ZhiLoop 本地部署与回滚

## 1. 部署结论

部署形态是 macOS 当前用户的本地 sidecar，默认安装为 `SHADOW`。它会把 Codex Hook 事件经过规范化与脱敏后写入本地 SQLite ledger，并在后台执行 snapshot、知识编译、分层发布、索引、检索、MCP 与闭环审计；`SHADOW` 下即使决策成功也只记录计划投递，不向模型返回知识内容。`ACTIVE` 必须经过指纹绑定的质量证据、灰度范围和高风险确认，跨机器同步不属于本部署。

ZhiLoop 只合并 `~/.codex/hooks.json`，不修改 `~/.ccm`。CCM 已有 Hook、matcher、timeout、未知字段和凭证配置必须保留。任何所有权冲突、symlink、并发漂移、版本不兼容或 READY 超时都会停止部署并触发逆序回滚。

## 2. 运行链路

```text
Codex Hook
  -> ~/.local/bin/zhiloop-sidecar hook
  -> ~/.ckl/run/sidecar.sock
  -> Daemon Hook deadline/fail-open
  -> Codex 事件规范化与秘密脱敏
  -> ~/.ckl/knowledge/events.sqlite
  -> SHADOW 空输出
```

LaunchAgent `dev.zhiloop.sidecar` 只使用绝对路径，不依赖交互式 shell 的 `PATH`。本地 Unix socket 权限为当前用户专有；Hook 遇到缺失服务、超时、非法输入、超限输入或异常响应时以空输出成功退出。

## 3. 安装布局

| 路径 | 用途 | 所有权 |
|---|---|---|
| `~/.local/share/zhiloop/releases/<version>` | 不可变发行内容 | 安装器 |
| `~/.local/share/zhiloop/current` | 当前发行原子指针 | 安装器 |
| `~/.local/bin/zhiloop-sidecar` | Hook/serve/health/worker 启动器 | 安装器 |
| `~/.local/bin/zhiloop` | install/upgrade/doctor/uninstall CLI | 安装器 |
| `~/.ckl/config.json` | SHADOW sidecar 配置 | 安装器，`0600` |
| `~/.ckl/knowledge/events.sqlite` | 对话事件 ledger | 用户持久数据 |
| `~/.ckl/install/manifest.json` | 当前版本与托管路径 | 安装器，`0600` |
| `~/.ckl/install/journal.json` | 最近部署事务与回滚证据 | 安装器，`0600` |
| `~/.ckl/install/receipts` | Codex Hook 所有权 receipt | 安装器，`0600` |
| `~/Library/LaunchAgents/dev.zhiloop.sidecar.plist` | 当前用户服务 | 安装器 |

状态目录使用 `0700`，敏感文件使用 `0600`，启动器使用 `0700`。日志只记录时间、组件、错误码、时延和数量，不记录 prompt、tool payload、知识正文、凭证或环境变量，并按大小与保留数量轮转。

## 4. 构建发行包

```bash
npm run build
npm run release:local -- --output /absolute/path/to/zhiloop-0.4.7
```

发行构建器复制 sidecar、部署 CLI、运行时 workspace、必要的生产依赖与插件资产，生成逐文件 SHA-256、权限、源码 commit、Node 绝对路径和 Node 版本。安装前会重新验证完整文件清单、哈希、Node 可执行文件与支持版本（`>=24.18.0 <27`）。同一版本出现不同内容时拒绝覆盖。

## 5. 计划与安装

先查看计划，不加 `--apply` 不会修改主机：

```bash
/absolute/artifact/apps/sidecar/dist/deploy-main.js \
  install --artifact /absolute/path/to/zhiloop-0.4.7 --json
```

确认自动化测试已经通过后应用：

```bash
/absolute/artifact/apps/sidecar/dist/deploy-main.js \
  install --artifact /absolute/path/to/zhiloop-0.4.7 \
  --codex-executable /absolute/path/to/codex --apply --json
```

安装事务依次完成发行 staging、SHADOW 配置、LaunchAgent、`current`、启动器、Codex Hook merge、manifest 与服务健康检查。每步写入 journal；任一步失败都会逆序恢复已完成步骤。升级使用同一入口的 `upgrade` 命令，新版本只有在最长 15 秒内达到兼容 READY 后才保留，否则恢复旧 `current`、manifest、Hook 和服务。升级未显式提供 `--codex-executable` 时会安全继承当前托管配置中的可执行文件绑定；首次安装需要显式绑定才能启用“问 ZhiLoop”。

## 6. 健康检查

```bash
~/.local/bin/zhiloop-sidecar health --json --config ~/.ckl/config.json
~/.local/bin/zhiloop doctor --json
```

`doctor` 检查发行摘要、配置/启动器权限、LaunchAgent 状态、socket 健康、协议兼容与 SHADOW 门禁。只有全部检查通过时退出码为 0。

可用合成 Hook 验证 fail-open 与 SHADOW 空输出：

```bash
printf '%s\n' '{"hook_event_name":"UserPromptSubmit","session_id":"smoke","turn_id":"1","cwd":"/tmp","prompt":"deployment smoke"}' \
  | ~/.local/bin/zhiloop-sidecar hook --config ~/.ckl/config.json
```

预期 stdout 为空；ledger 事件数增加；诊断日志不出现合成 prompt 正文。

## 7. 本地控制台

安装完成后可启动仅监听 loopback 的本地控制台：

```bash
~/.local/bin/zhiloop ui
```

默认会直接打开浏览器，stdout 只输出 `RUNNING`、本地 origin 和是否已打开浏览器，不记录一次性 bootstrap fragment。无图形环境可显式使用：

```bash
~/.local/bin/zhiloop ui --no-open --json
```

仅在 `--no-open` 模式下，JSON 会返回一次性 `bootstrapUrl`。该 URL 的 fragment 会在页面发起认证前从地址栏移除；Gateway 使用短期 HttpOnly SameSite 会话、内存 CSRF token、Host/Origin 校验和无 CORS 策略。浏览器硬刷新时，页面通过同源、只读、无参数的会话恢复端点重新取得内存 CSRF proof；其他 API 仍强制校验 CSRF。页面不使用 localStorage、sessionStorage 或 IndexedDB 持久化会话和知识数据。

任务状态的实时失效事件会合并为最多每 5 秒一次后台刷新；刷新期间保留上一次成功结果，避免持续事件导致页面闪烁或请求风暴。

控制台支持总览、真实能力矩阵、Codex 风格只读会话目录、脱敏事件元数据、任务/诊断、配置与部署状态，以及会话级采集和提取的 preview → commit。采集提交必须绑定 session、预览 revision、transcript identity hash 和幂等键；`STALE_REVISION` 必须重新预览。知识页支持来源、版本、Evidence、编辑影响、suppress/restore、当前 Recipe/Verification Run、Freshness revision、复验与 Repair Draft 提交；召回页支持确定性搜索、策略比较和本地 Codex 只读问答；会话页展示提取/Candidate/演进/注入时间线；闭环页展示 Gate、纠偏、续跑和高风险治理。

运维区域还提供 CodeGraph、历史知识迁移和持久化告警三个页面。CodeGraph 初始化只接受 Sidecar 已观察项目，必须先生成五分钟有效的影响预览再明确提交；迁移必须先 dry-run，可分页查看脱敏明细，并通过 revision/idempotency 门禁提交或安全回滚；告警确认与限时静默只更新独立操作投影，不删除底层告警。所有长任务使用 SSE 失效通知与单飞可取消刷新，断线后最多重试五次并指数退避。

普通检索保持 15 秒 Gateway 上限；本地 Codex 问答允许最多 120 秒，同时仍受配置项 `future.codexQueryTimeoutMs` 的更短门禁约束。下列启动期消费者配置在激活后标记 `requiresRestart`：`future.injectionMaxTokens`、`future.compilerBatchSize`、`future.codexQueryTimeoutMs`、`future.codexQueryConcurrency`。

Gateway 是独立进程，不被 Sidecar launcher 或 Codex Hook 引用。关闭 `zhiloop ui` 不影响 Hook、Ledger 或后台 Sidecar。

## 8. 主动采集指定 Codex 会话

先进行严格只读预览：

```bash
~/.local/bin/zhiloop capture \
  --session 019f837a-34d4-7e60-800c-6361f6fb6d49 \
  --dry-run --json
```

预览会在 `~/.codex/sessions` 下读取有界的 rollout JSONL 首行，以 `session_meta.payload.id` 中的精确 ID 定位主文件（旧格式缺少 `id` 时才回退 `session_id`），然后报告可投影事件、忽略记录和最终游标；不会写 ledger 或 ingestion cursor。文件名、正文或子任务的父 `session_id` 中出现相同 ID 都不会被当成主 transcript 身份依据。

正式采集：

```bash
~/.local/bin/zhiloop capture \
  --session 019f837a-34d4-7e60-800c-6361f6fb6d49 \
  --json
```

CLI 只通过当前用户 Unix socket 请求 Sidecar，Sidecar 是 SQLite 唯一写入者。支持的 transcript 投影是 `session.started`、`user.prompted`、`turn.stopped`；其中 `turn.stopped` 保留该轮最终 assistant message。工具细节、隐藏推理和其他 rollout 记录不进入本次规范化事件，计入 `ignoredRecords`。

同一会话重复采集会从持久化锚点游标继续；关闭且未变化的会话返回 `projectedEvents: 0`、`appendedEvents: 0`。如果 append 已完成但游标提交前中断，重试由确定性 event ID 吸收重复。文件被替换、截断或锚点前内容改变时不会自动重置游标。

采集响应中的 `knowledgeCompiled` 只描述这个同步命令本身是否已完成知识编译；正式知识提取由 durable P2 job 独立执行。页面可在会话详情创建当前不可变 snapshot、查看候选并按策略提交。当前部署仍为 `SHADOW`，因此知识可以发布并被检索，但注入 attempt 必须显示 `SHADOWED`，不能显示 `INJECTED`。

```json
{ "knowledgeCompiled": false }
```

这表示规范化对话事件已经进入 ledger，但该采集请求不会同步等待模型编译；它不表示生产知识流水线未接通。会话页和后台任务页是后续 snapshot、candidate、publish 与 index 状态的权威视图。

## 9. 卸载、保留数据与 purge

先查看卸载计划：

```bash
~/.local/bin/zhiloop uninstall --json
```

正常卸载：

```bash
~/.local/bin/zhiloop uninstall --apply --json
```

正常卸载只移除 manifest 证明属于 ZhiLoop 的 LaunchAgent、启动器、发行目录、`current`、配置和 Hook 片段。`~/.ckl/knowledge`、spool、日志和 journal 默认保留。Hook 未漂移时精确恢复原文件；发生安全的外部漂移时只删除 receipt 所属条目；所有权冲突时拒绝猜测。

永久删除保留数据必须在已经卸载后提供独立精确确认：

```bash
~/.local/bin/zhiloop uninstall --apply --purge-data \
  --confirm PURGE-ZHILOOP-DATA --json
```

该操作不可恢复；普通 uninstall、upgrade 和失败回滚不会触发 purge。

## 10. 故障定位

- `release ... integrity`：重新构建发行目录，不要原地修改已生成 artifact。
- `changed after deployment planning`：Codex/CCM 正在写 Hook；等待写入结束后重新 plan/apply。
- `different ZhiLoop hook`：存在非本 receipt 管理的 ZhiLoop 命令；先确认其来源，不要强制覆盖。
- `sidecar did not reach compatible READY health`：查看 `~/.ckl/logs/service.stderr.log` 与 `doctor --json`；安装器已自动恢复旧版本。
- `configuration path must be a regular file` 或 symlink 错误：目标所有权不安全，修正路径后重新计划。
- Hook 无输出：SHADOW 与 fail-open 都会空输出；通过 health、ledger 计数和隐私安全诊断区分正常 SHADOW 与服务不可用。
- `SESSION_NOT_FOUND`：确认使用的是本机 Codex 会话 ID，且 rollout 仍位于 `~/.codex/sessions`。
- `SESSION_AMBIGUOUS`：同一 ID 存在多个 transcript，系统不会猜测来源；保留唯一可信文件后重试。
- `TRANSCRIPT_REPLACED`、`TRANSCRIPT_TRUNCATED` 或 `TRANSCRIPT_ANCHOR_MISMATCH`：已提交游标与文件不再兼容；当前版本不会隐式全量重建。
