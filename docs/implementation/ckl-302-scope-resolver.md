# CKL-302 Scope Resolver

## 1. 目标与边界

`@zhiloop/scope-resolver` 把 `KnowledgeCandidate`、可信 `ProjectContext` 和可选身份上下文解析为七级 `KnowledgeScope`。核心原则是选择最小可证明边界；无法证明时固定回退 `PROJECT`，绝不因模型提示自行扩大到 `USER`、`TEAM` 或 `GLOBAL`。

本模块是纯、同步、确定性的 Domain Policy，只决定知识适用边界，不验证 Assertion、不改变 Candidate 状态、不发布 Knowledge Asset，也不访问模型、文件系统、数据库或网络。证据验证和发布决策分别由 CKL-303 与 CKL-304 承担。

## 2. 输入与输出契约

```ts
interface ScopeResolutionInput {
  candidate: KnowledgeCandidate;
  projectContext: ProjectContext;
  taskId?: string;
  userId?: string;
  teamId?: string;
  allowGlobal?: boolean;
  projectTerms?: readonly string[];
}

interface ScopeResolution {
  scope: KnowledgeScope;
  confidence: number;
  reasonCodes: readonly string[];
  projectSpecificSignals: readonly string[];
}
```

`taskId/userId/teamId/allowGlobal` 必须来自调用方的可信运行上下文，不能把 Candidate 内的模型提示原样回填。`projectTerms` 只用于补充业务别名；Resolver 会从 normalized remote 和 repository root 自动提取默认项目名，防止调用方漏传后绕过业务名门禁。

输出递归冻结。`reasonCodes` 供策略、审计和交互层做机器判断；`projectSpecificSignals` 解释为什么知识不能向项目外扩大。

## 3. 七级解析顺序

解析顺序按边界从窄到宽执行：

```text
trusted TASK
  -> syntactically valid SYMBOL
  -> safe relative MODULE
  -> PROJECT fallback/default
  -> trusted USER
  -> trusted TEAM
  -> explicitly authorized GLOBAL
```

- `TASK`：Candidate 声明 task 时，必须存在匹配的可信 taskId；不匹配回退 PROJECT。
- `SYMBOL`：合并 Scope Hint 与当前项目 `SYMBOL_EXISTS` Assertion，去重后使用。任一非法 symbol、空 SYMBOL 目标或跨项目 Assertion 都整体失败关闭。
- `MODULE`：只接受非空、非绝对、不含空 segment 和 `..` 的相对路径，并统一 Windows separator。任一非法项不做部分截断，整体回退 PROJECT。
- `PROJECT`：显式 PROJECT 置信度为 0.9；不确定输入置信度为 0.8；安全回退置信度为 0.7。
- `USER/TEAM`：必须同时满足精确匹配的可信身份、内容无项目特征、Candidate 显式提出该级别。
- `GLOBAL`：必须同时满足 `allowGlobal === true`、内容无项目特征、Candidate 显式提出 GLOBAL。这里仅允许产生 GLOBAL Scope，不代表状态晋升或发布通过。

若 Candidate 的 projectId 或 repositoryRemote 与可信 ProjectContext 冲突，Resolver 直接报错，避免把一个项目的内容静默绑定到另一个项目。

## 4. 项目特征门禁

以下信号会阻止 USER、TEAM、GLOBAL 扩大并回退 PROJECT；如果存在更窄且合法的 SYMBOL/MODULE，则优先保留更窄 Scope：

- symbol 或 module path；
- IMPLEMENTATION 知识类型；
- Symbol/File/Dependency/Config/Command/Test Assertion；
- 对应代码、文件、依赖、配置、命令和测试 Evidence Hint；
- 正文中的绝对路径或常见源码目录路径；
- normalized remote、repository root 自动导出的项目名；
- 调用方补充的业务别名 `projectTerms`。

项目名匹配覆盖 subjectKey、title、summary 和 body，使用大小写无关比较。别名必须为 3～200 字符，避免过短词造成大面积误命中；自动导出的过短名称只会被忽略。

## 5. 安全与一致性

- 模型提示不是授权：Candidate 自带 userId/teamId/taskId 不能替代可信上下文。
- GLOBAL 是双门禁：显式 hint + 独立 `allowGlobal`；CKL-304 仍需按 Evidence Policy 决定是否发布或晋升。
- 无部分接受：混合合法/非法 symbols 或 module paths 不会静默丢弃坏值后继续。
- Assertion 项目隔离：跨项目 `SYMBOL_EXISTS` 不能生成当前项目的 SYMBOL Scope。
- 决策稳定：集合去重、信号排序和固定优先级保证同一输入得到相同冻结输出。
- 依赖最小：新包只依赖 `@zhiloop/domain`，没有 Node、存储、模型和进程能力。

## 6. 验证与性能

- 13 条专项测试覆盖七级 Scope、优先级、身份匹配、项目冲突、unsafe path、非法/空 symbol、跨项目 Assertion、业务名识别、GLOBAL 授权和冻结输出。
- 2 条 Node 架构/Gate 测试验证依赖边界，并使用真实 Project Identity 串联 PROJECT、SYMBOL 和 GLOBAL 拒绝路径。
- Scope Resolver Lines 97.89%、Branches 89.83%、Functions 100%、Statements 95.04%。
- 全仓 298 条模块测试、29 条架构/Gate 测试通过。
- 20 组、每组 10,000 次纯决策基准：中位 9.117ms、P95 10.658ms，约 1,096,802 decisions/s。
- npm 官方 registry 审计：0 vulnerabilities。

## 7. 已知边界

- symbol 只做语法和项目绑定校验，不证明源码中存在；存在性由 CKL-303 Symbol Verifier 确认。
- module path 只做安全相对路径校验，不读取文件系统；文件存在性与路径指纹由后续 Verifier/Invalidation 模块确认。
- 自动项目名来自可信 ProjectContext 的最后一个路径段；过于通用的仓库名可能保守阻止向上扩大，可由后续策略提供更精确别名，但不能绕过已有项目信号。
- Scope Resolver 不做跨项目普适性统计；GLOBAL 晋升仍必须满足 CKL-304 的证据与策略门槛。
- 本模块未安装 Hook、未启动 Daemon，也未读写 `~/.ckl`、`~/.codex` 或 `~/.ccm`。
