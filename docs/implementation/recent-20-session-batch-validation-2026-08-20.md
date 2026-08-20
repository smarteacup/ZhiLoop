# 最近 20 个 Codex 会话批量验收报告

日期：2026-08-20  
批量运行版本：ZhiLoop `0.5.2`–`0.5.4`；最终固化版本：`0.5.6`  
运行模式：`SHADOW + PREVIEW_ONLY`  
样本口径：按会话最后活动时间冻结最近 20 个会话；成功会话取最新 v5 成功预览，失败会话取最新 v5 检查点中的候选。当前实时会话使用本轮开始前已完成的 v5 快照，不追求持续写入期间的绝对最新游标。

## 1. 验收结论

本轮 20 个会话均完成采集或已有可复用 Ledger 边界，18 个会话完成 Candidate Preview，2 个会话在证据门禁阶段 fail-closed。模型共生成 76 条候选，其中 65 条进入可查看预览，11 条因所在会话门禁失败而停留在检查点中。没有自动发布知识。

| 指标 | 结果 | 判断 |
|---|---:|---|
| 会话成功率 | 18 / 20（90%） | 主链路可用，但未达到全量稳定 |
| 生成候选 | 76 | 长短会话都能产生结构化候选 |
| 成功预览候选 | 65 / 76（85.5%） | 失败会话中的候选目前不可形成正式预览 |
| 场景定位完整 | 76 / 76（100%） | 每条都有场景、意图、适用与不适用边界 |
| 模块定位存在 | 50 / 76（65.8%） | 流程知识可以为空；部分代码知识仍缺模块 |
| 权威分支定位 | 15 / 76（19.7%） | 当前最大质量短板，多数为 `ALL_BRANCHES / NO_AUTHORITATIVE_BRANCH` |
| 有断言候选 | 54 / 76（71.1%） | 22 条主要依赖模型和对话承诺，不能自动成为代码事实 |
| 证据结果 | 支持 33 / 反驳 8 / 未知 35 | UNKNOWN 占 46.1%，门禁严格但代码证据召回仍需提升 |
| 策略允许发布 | 1 / 76 | 仅表示策略层允许；PREVIEW_ONLY 下实际发布仍为 0 |

候选类型分布：`CURRENT_STATE 50`、`FUTURE_REQUIREMENT 11`、`USER_DECISION 15`。知识种类分布：`IMPLEMENTATION 37`、`DECISION 12`、`REQUIREMENT 12`、`EXPERIENCE 8`、`DESIGN 7`。

## 2. 逐会话效果

证据列为 `支持 / 反驳 / 未知`。定位列为 `场景 / 模块 / 权威分支` 的候选数量。

| # | 会话 | 结果 | 候选 | 定位 | 断言 | 证据 | 观察 |
|---:|---|---|---:|---|---:|---|---|
| 1 | `019fff7c-37e6-7941-975f-e6fba3940139` ZhiLoop 当前实时会话 | 成功 | 6 | 6 / 6 / 6 | 14 | 14 / 0 / 0 | 定位和证据质量最好；按冻结快照验收 |
| 2 | `019f4598-8e45-7351-9b78-3e9b32204324` IBG pre 服务盘点 | **失败** | 5 / 0 预览 | 5 / 5 / 0 | 10 | 0 / 0 / 0 | `VERIFICATION_DEADLINE_EXCEEDED`，5/5 次 |
| 3 | `019f8ce9-cbc5-7ce1-b658-aac224cfaead` device-shadow sdCard | 成功 | 1 | 1 / 0 / 0 | 1 | 0 / 0 / 1 | 候选偏向设备分表，和 sdCard 主问题有明显偏移 |
| 4 | `01a01969-9f09-7da1-b047-4bd9fdcd1a27` cherry-pick | 成功 | 2 | 2 / 2 / 0 | 7 | 3 / 0 / 4 | 冲突处理与代码行为均被提取 |
| 5 | `01a0193a-4265-7f61-9f5a-16b5971cd0fe` Melos 工单 | 成功 | 4 | 4 / 0 / 0 | 0 | 0 / 0 / 0 | 需求/决策可读，但没有代码断言 |
| 6 | `01a0192e-2294-7a23-91d6-3ae3b01f9972` 小需求智能体设计 | 成功 | 3 | 3 / 0 / 0 | 0 | 0 / 0 / 0 | 适合作为流程知识，不应要求代码 revision |
| 7 | `01a013d6-aab6-74f2-823d-d183abbc4f16` rtc-manager 直播测试 | 成功 | 2 | 2 / 2 / 0 | 3 | 2 / 0 / 1 | 产出偏向本地环境配置，未覆盖主要接口链路 |
| 8 | `01a014b6-601d-7dd0-994a-59b8fcf05aa9` commandId 物理表 | 成功 | 1 | 1 / 1 / 0 | 2 | 0 / 0 / 2 | 场景正确，证据仍为 UNKNOWN |
| 9 | `01a01386-4d0d-7722-995e-d51c5dd932f6` 算法 38 | 成功 | 2 | 2 / 1 / 0 | 3 | 0 / 2 / 1 | 反驳证据被保留，候选未被误发布 |
| 10 | `019fd5da-9272-7261-9467-66e07ce46bbd` black-hole common-add | 成功 | 4 | 4 / 4 / 4 | 7 | 1 / 4 / 2 | 分支定位完整；反驳体现不同分支代码差异 |
| 11 | `019fdafe-4697-7353-8549-7d028635a2ec` 美东迁移顺序 | **失败** | 6 / 0 预览 | 6 / 5 / 0 | 4 | 0 / 0 / 0 | `CODE_REVISION_CHANGED`，7/7 次；多仓知识绑定聚合目录 |
| 12 | `01a00e82-022c-7421-b654-f662b2a79c0e` pickup reason | 成功 | 4 | 4 / 4 / 0 | 5 | 0 / 0 / 4 | 业务枚举、缺省值和不一致点均被拆分 |
| 13 | `01a00e54-faa3-71b3-a115-55b5d545243b` 484 联动逻辑 | 成功 | 5 | 5 / 5 / 0 | 12 | 0 / 0 / 0 | 跨三个服务的链路结论完整，但当前验证结果未形成支持证据 |
| 14 | `019fe5a7-946f-7402-9e75-39943c31244b` 错误日志排查 | 成功 | 5 | 5 / 5 / 5 | 11 | 2 / 1 / 8 | 长会话采集协议修复后通过；UNKNOWN 较多 |
| 15 | `019fbc7e-f203-7550-9b6f-bfb89e809d0f` ZhiLoop 早期会话 | 成功 | 5 | 5 / 5 / 0 | 8 | 7 / 0 / 1 | 旧 v3 快照已重建为 v5 定位候选 |
| 16 | `019fff41-7695-7260-980f-58af9bc70778` GB28181 链路 | 成功 | 5 | 5 / 0 / 0 | 6 | 0 / 0 / 6 | 结论有价值，但模块为空，验证退化到聚合 CodeGraph |
| 17 | `019ff92f-e192-7482-b2a7-6d3f8e1f4c4e` Melos 安全修复 | 成功 | 6 | 6 / 0 / 0 | 1 | 1 / 0 / 0 | 纯流程快路径生效；1 条策略可发布但未实际发布 |
| 18 | `019ffb03-2e10-78b1-934f-5f6b099ca532` Melos 终态 | 成功 | 2 | 2 / 0 / 0 | 0 | 0 / 0 / 0 | 流程规则可作为需求知识保留 |
| 19 | `019ffa29-27fc-7a43-ad14-e003ef7b30db` Melos 评论 | 成功 | 5 | 5 / 2 / 0 | 1 | 0 / 1 / 0 | 未来需求被当前代码反驳时保持待实现，而非错误发布 |
| 20 | `019ffa1f-efca-74d3-be56-859b0585d336` pickup create curl | 成功 | 3 | 3 / 3 / 0 | 8 | 3 / 0 / 5 | 请求契约、配置查询和分表规则均被提取 |

## 3. 候选目录

### 1. ZhiLoop 当前实时会话

- 证据门禁按 claim mode 解释验证结果
- 召回采用硬定位过滤和场景渐进披露
- 旧知识定位通过非破坏投影迁移
- 代码知识使用权威项目、版本和场景定位
- 场景以版本化实体和投影维护
- CodeGraph 链路和结论沉淀为可失效 Artifact

### 2. IBG pre 服务盘点（门禁失败，未形成预览）

- picture-service 提供图片提取创建与状态接口
- IBG 媒体提取回归文档已覆盖完整调用链
- 视频解密回归应校验文件内容而非仅看 HTTP 状态
- command-service 直调用作锁提辅助诊断
- master_ibg 使用 RLP V2 创建视频锁提

### 3. device-shadow sdCard

- Device 13aws45quo950412 is stored in shard table 92

### 4. algorithm-strategy cherry-pick

- Cherry-pick 冲突应合并双方有效行为后定向验证
- 天眼规则输出包含阈值过滤和匹配分数

### 5. Melos 工单

- matchScore 仅处理已配置 textCode
- 新增分数不得修改原有检索链路
- 两个关联小改动合并在一个 issue 实现
- 新增 matchScore 展示分数

### 6. 小需求开发智能体

- 小需求 Issue 必须提供完整开发输入
- 小需求开发采用分阶段人工门禁流程
- Melos IoT 已配置小需求开发智能体

### 7. rtc-manager 直播测试

- Git 跟踪 `.env.example` 但继续忽略 `.env.local`
- 本地网关凭据存放在项目根目录的 `.env.local`

### 8. commandId 物理表

- Command table selection uses command_id modulo the environment shard count

### 9. 算法 38

- feature-platform 可使用 JDK 8 完成 Maven 打包
- IBG 检测集合已包含算法 38

### 10. black-hole common-add

- extra 采用可空列直接透传的最小改造
- common-add 的固定与条件 PublicLog
- 当前主线 common-add 写入 t_file_detail 分表
- master_ibg common-add 写入 t_video_file 分表

### 11. 美东迁移（门禁失败，未形成预览）

- 美东新集群暂不接入 Passport
- Gateway 已新增 common file info 转发
- 迁移复用美东 tachograph 共享库
- Gateway 和 tachograph-device 已支持 get-time 接口
- HTTP 与 MQTT 使用不同的确定性分流依据
- 美东迁移采用最小依赖优先的部署顺序

### 12. pickup reason

- pickup_record.reason 的业务类型映射
- REASON_7 的源码定义与业务含义不一致
- reason 接口参数未限制为业务枚举
- 未传 reason 时按 -1 入库

### 13. 484 联动逻辑

- command-service 在发指令前二次检查 RTC 开关
- 二次拦截的 484 可能被 rtc-manager 转换为 2101
- 强制停止录制会恢复云端开关
- rtc-manager 在四个 RTC 入口直接返回 484
- RTC 云端开关由三个服务联合实现

### 14. 错误日志排查

- strategy_retry_topic carries application-generated delayed retries after thrown rule failures
- Retry startup safely repairs mismatched Hystrix configuration and executor sizes
- Retry MQ can create the DeviceFeign Hystrix pool with defaults during cold start
- Use lifecycle ordering and runtime validation instead of Hystrix JVM `-D` flags
- SmartInitializingRetryExecutor delays the external retry delegate startup

### 15. ZhiLoop 早期会话

- 提取控制台展示中文状态和真实失败诊断
- 知识保鲜采用变化驱动复验与召回前强校验
- 剩余能力按知识闭环依赖顺序实施
- CodeGraph 作为实时代码事实层
- 自动沉淀、真实证据与知识保鲜尚未闭环

### 16. GB28181 链路

- stopLive 有远端 BYE、信令失败补偿和 Endpoint 停止三类触发
- GbUdpPlatformTransport 是 GB28181 UDP 入口和多设备路由边界
- prepareLive 失败补偿可能关闭会话但遗留 RTC 资源
- GB28181 实时视频由 INVITE 准备资源、ACK 启流、BYE 清理资源
- sidestream/end 非 200 会通过 STOPPING 恢复任务持续重试

### 17. Melos 安全修复

- 当前 Melos 流程已终止
- 安全需求采用人工负责人加结构化 mention 路由
- 外部环境启动失败可作为受控预期失败
- Gate PASS 后必须输出可点击 compare 地址
- SafeMode 修复必须覆盖完整兼容性扫描
- Fastjson 工单统一采用 JVM SafeMode 参数

### 18. Melos 终态

- Strictly bound the V3 EXPECTED_ENV_FAILURE exception
- Independently review the fixed Fastjson SafeMode delivery

### 19. Melos 评论

- Keep remediation delivery isolated and evidence-complete
- Use the exact Fastjson SafeMode JVM parameter
- Allow only the approved environment failure signature
- Cover SafeMode activation and application compatibility
- Do not infer inaccessible external ticket details

### 20. pickup create curl

- V2 pickup 创建接口的请求契约
- 设备公共配置接口的本地调用契约
- command-service 的 t_command 分表算法

## 4. 证据门禁如何工作

1. 先把会话 Ledger 固化为不可变 snapshot，候选和证据都绑定 snapshot、Episode、事件与 compiler version。
2. 模型生成 `claimMode + KnowledgeLocator + assertions`。定位先限制项目、模块、分支与场景；断言再声明需要验证的文件、符号、调用链、配置、命令或用户承诺。
3. 代码断言优先定位到候选模块唯一命中的子 Git 仓库，验证前后各抓一次 code revision，并调用 CodeGraph 或本地有界探针。两次 revision 不一致即 `CODE_REVISION_CHANGED`，结果不得进入预览。
4. 不含代码、命令或测试断言的流程、偏好和未来需求不读取代码 revision，防止聚合工作区 IO 成为无意义瓶颈；命令与测试证据仍保留 revision 门禁。
5. `CURRENT_STATE` 的代码事实遇到 REFUTED、UNKNOWN、未解析 revision 或定位不足时保持 `PROPOSED`；`FUTURE_REQUIREMENT` 被当前代码反驳表示“尚未实现”，不是需求本身错误；`USER_DECISION` 仍需用户承诺证据。
6. 本轮运行在 `PREVIEW_ONLY`，即使策略给出 `shouldPublish=true`，也只展示候选，不写入正式知识库。

## 5. 本轮发现并修复的问题

| 版本 | 问题 | 修复与验证 |
|---|---|---|
| 0.5.2 | emoji 等扩展 Unicode 使采集预览超过协议 UTF-16 长度，控制台报 `Invalid Sidecar response` | 改为协议一致的 UTF-16 安全截断；问题会话成功预览并写入 92 条事件 |
| 运行配置 revision 2 | 聚合项目下证据验证 16 秒不足 | CodeGraph 单次预算 2 秒调整为 7.5 秒，对应端到端门禁 60 秒；Codex 编译仍为 120 秒 |
| 0.5.3 | 候选已给出模块，但验证仍扫描聚合目录 | 模块唯一命中子 Git 仓库时收敛 revision 和 CodeGraph 根，并重写相对证据路径 |
| 0.5.4 | 纯流程候选仍重复抓取代码 revision，单会话耗时约 6 分钟 | 无仓库敏感断言时跳过仓库 IO，命令/测试仍绑定 revision；真实 Melos 会话重试后快速通过 |
| 0.5.5 | 已发布的不可变 `0.5.4` 不能承载最终审查修正 | 固化命令/测试证据的 revision 门禁，并以新版本重新发布，批量统计口径不变 |
| 0.5.6 | 约 87 MB Ledger 有效载荷使启动恢复加载全部正文并阻塞健康接口 | 恢复阶段仅读取有界事件元数据，正文不出 Ledger；消除数据增长导致的升级超时 |

相关回归：60 项定向测试；完整门禁 61 项脚本检查与 1,753 项 Vitest 测试全部通过；本地发行安装/卸载验收及 `zhiloop doctor` 6/6 均通过。

## 6. 尚未通过验收的能力

### P0：多仓/聚合目录证据模型

美东迁移包含多个服务仓库，现有一个候选只绑定一个 `ProjectContext`，无法表达“一个结论由多个仓库和多个 revision 联合证明”。应把 verification target 改为候选级 `repository evidence set`，每个 assertion 绑定独立 repository identity/revision，最后聚合门禁。

### P0：失败会话的部分候选可见性

两个失败会话已经生成 11 条候选，但当前只有整个 `CANDIDATE_POLICY` 成功才创建 Candidate Preview。应持久化逐候选状态：`GENERATED → VERIFYING → VERIFIED/REFUTED/UNKNOWN/FAILED`，让用户看到已生成内容和具体失败断言，而不是整个会话显示 0 条。

### P0：权威分支覆盖率

只有 15/76 候选具备权威分支定位。对代码事实应优先从精确 Git 仓库解析 branch/commit；解析不到时保留候选，但禁止发布和跨分支召回。控制台需要直接显示仓库名、分支、commit 和解析来源，不能只显示 opaque projectId。

### P1：混合长会话的相关性

device-shadow 会话最终只得到“设备分表”候选，rtc-manager 直播会话偏向 `.env` 配置，说明 Episode 切分仍可能被后续子问题或工具结果带偏。应增加“用户目标锚定分数”和候选覆盖检查：至少有一条候选必须直接回答会话主目标，否则标记 `GOAL_COVERAGE_LOW`。

### P1：门禁吞吐与诊断

代码候选仍按会话串行验证，一个 assertion 超时会拖慢整个会话。应在有界并发下按候选验证，复用相同 repository revision/CodeGraph capability snapshot，并在页面展示 compile、repository resolution、evidence probe 的独立耗时和最后失败目标。

## 7. 最终判断

ZhiLoop 已能把真实 Codex 会话转换为带场景边界、适用条件、证据断言和策略结果的候选，且严格阻止证据不足内容自动发布。当前可以进入“人工验收候选质量”的阶段，但还不适合开启自动发布：多仓 revision、分支定位、失败候选可见性和长会话相关性必须先补齐。
