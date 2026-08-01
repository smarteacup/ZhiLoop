# CKL-303 Verifier Registry 和 MVP Verifiers

## 1. 目标与边界

`@zhiloop/evidence-engine` 提供 Verifier Registry、统一 Probe 契约和 User/Symbol/File/Dependency/Config/Command/Test 七类 MVP Verifier。它把结构化 Assertion 与外部适配器的观察结果转换成 `VerificationResult` 和可追溯 `Evidence`，并严格区分 `SUPPORTED`、`REFUTED`、`UNKNOWN`、`ERROR`。

本模块不读取文件、不扫描代码、不解析构建文件、不执行命令或测试，也不访问模型、SQLite 和网络。实际观察由注入的 Probe Adapter 完成；Registry 负责路由、隔离和结果契约，CKL-304 才根据 Evidence 决定 Candidate 状态。

## 2. 模块结构

```text
KnowledgeAssertion[]
  -> VerifierRegistry（按 AssertionKind 唯一路由）
    -> UserVerifier
    -> SymbolVerifier
    -> FileVerifier
    -> DependencyVerifier
    -> ConfigVerifier
    -> CommandVerifier
    -> TestVerifier
      -> typed VerificationProbe
        -> VerificationObservation
      -> VerificationResult + Evidence
```

UserVerifier 对应 `USER_ACCEPTED/USER_REJECTED` 两个用户承诺断言；其余 Verifier 各对应一个 Assertion kind。`CROSS_PROJECT_VERIFIED` 不在 MVP 七类中，Registry 明确返回 `UNKNOWN + NO_VERIFIER_REGISTERED`，不会误用其他 Verifier。

重复注册、Verifier 内部重复 kind、空 kind 集合和非法 verifierId 在 Registry 构造/注册阶段拒绝，保证每种 Assertion 只有一个确定路由。

## 3. Probe 与结果契约

Probe 接收原始 typed Assertion 和只读上下文：

```ts
interface ProbeContext {
  project: ProjectContext;
  correlationId: string;
  requestedAt: string;
}

interface VerificationObservation {
  status: "SUPPORTED" | "REFUTED" | "UNKNOWN";
  sourceRef: string;
  observedAt: string;
  target: string;
  reasonCode: string;
  details?: Record<string, string | number | boolean>;
}
```

Probe 没有 `ERROR` 输出：异常直接抛出，由 Verifier/Registry 隔离成 `ERROR`，且不携带 Evidence。Probe 缺失是正常的能力不足，返回 `UNKNOWN + VERIFICATION_SOURCE_UNAVAILABLE`，不伪造 Inconclusive Evidence。

Probe 返回 UNKNOWN 但有实际观察时，会生成 `INCONCLUSIVE` Evidence；REFUTED 映射 `CONTRADICTS`，SUPPORTED 映射 `SUPPORTS`。Registry 再次校验 status/verdict、assertionId、Evidence type、projectId、correlationId、observedAt、target、sourceRef 和 reason code，插件返回结构错误时统一变为 `VERIFIER_CONTRACT_VIOLATION`。

## 4. 七类 Verifier 语义

| Verifier | Assertion | Evidence type | Probe 职责 |
|---|---|---|---|
| User | USER_ACCEPTED / USER_REJECTED | USER_STATEMENT | 从不可变对话事件确认 statementRef 的接受/拒绝语义 |
| Symbol | SYMBOL_EXISTS | CODE_SYMBOL | 在指定项目、可选相对路径中确认 symbol |
| File | FILE_CONTAINS | FILE_CONTENT | 用 EXACT/REGEX/STRUCTURAL 安全匹配目标文件 |
| Dependency | DEPENDENCY_PRESENT | DEPENDENCY | 解析指定/默认 manifest 并判断版本约束 |
| Config | CONFIG_EQUALS | CONFIGURATION | 解析目标配置 key 并比较规范化值 |
| Command | COMMAND_SUCCEEDED | COMMAND_RESULT | 查询当前 Turn 已记录的 commandHash/exitCode，不重新执行命令 |
| Test | TEST_PASSED | TEST_RESULT | 查询与 testId/path/commandHash 绑定的已记录测试结果，不重新运行测试 |

Verifier 在调用 Probe 前验证 Assertion 边界：Symbol projectId 必须等于当前 ProjectContext；所有可选 path 都必须是规范相对路径，拒绝 absolute、drive、反斜杠、空 segment、`.` 和 `..`；文本、详情数量、详情值、exit code 与时间戳都有长度/格式上限。

## 5. Evidence 完整性

每条实际 Evidence 都包含：

- 确定性 128-bit `evidenceId`；identity 覆盖 assertion、type、verdict、source、观察时间、target、reason、project、correlation 和 details；
- `assertionId` 与对应 Evidence type；
- `sourceRef`、`observedAt`、`projectId`、`correlationId`；
- `details.target`、`details.verifierId`、`details.assertionKind`；
- 与 VerificationStatus 一致的 verdict。

结果和嵌套 Evidence 递归冻结。适配器异常文本不会进入 reasonCodes、Evidence 或日志载荷，避免本地路径、命令和凭证泄漏。

## 6. 并发与故障隔离

`verifyAll` 使用 `Promise.all` 并发验证独立 Assertion，但返回顺序严格等于输入顺序。单个内置 Verifier 捕获 Probe 异常；Registry 还对未来第三方 Verifier 做第二层 try/catch，因此一个插件失败不会 reject 整批。

状态边界：

- `SUPPORTED`：有 SUPPORTS Evidence；
- `REFUTED`：有 CONTRADICTS Evidence；
- `UNKNOWN`：无 Probe/无注册时不造 Evidence，有不确定观察时携带 INCONCLUSIVE Evidence；
- `ERROR`：输入、适配器或插件契约失败，不携带 Evidence，绝不等价于 REFUTED 或 SUPPORTED。

## 7. 验证与性能

- 17 条专项测试覆盖七类路由、三种观察状态、无 Probe、无注册、异常隔离、第三方插件契约、跨项目 symbol、unsafe path、非法 metadata、Evidence ID 幂等与并发顺序。
- 2 条 Node 架构/Gate 测试串联真实 Project Identity、七类 Assertion、Evidence traceability、UNKNOWN/REFUTED/ERROR 分支，并确认模块无模型、存储、文件、进程和网络依赖。
- Evidence Engine Lines 98.13%、Branches 92.30%、Functions 100%、Statements 96.96%。
- 全仓 315 条模块测试、31 条架构/Gate 测试通过；整体 Lines 96.92%、Branches 90.01%。
- 20 组、每组 1,000 条异步 Assertion：中位 6.332ms、P95 7.734ms，约 157,916 assertions/s。
- npm 官方 registry 审计：0 vulnerabilities。

## 8. 已知边界

- 本模块定义 Probe 端口和验证策略，Node filesystem/code/config/dependency Adapter 将在 Daemon 装配阶段实现；Probe 必须产生 canonical source event ID。
- REGEX/STRUCTURAL 匹配由受限 Adapter 实现，不能把模型字符串直接交给无超时的任意正则执行器。
- Command/Test Verifier 只消费当前 Turn 已记录结果，禁止为知识验证触发新的副作用命令。
- `CROSS_PROJECT_VERIFIED` 留给 CKL-304/P3 Gate 的跨项目证据聚合，不由单项目 Probe 自证。
- 当前只生成 Evidence 和 VerificationResult，不修改 Candidate、KnowledgeAsset 或生命周期状态。
- 本模块未安装 Hook、未启动 Daemon，也未读写 `~/.ckl`、`~/.codex` 或 `~/.ccm`。
