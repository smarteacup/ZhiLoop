# CKL-705：默认 Codex Exec 模型适配器

## 1. 结论

CKL-705 已完成。`@zhiloop/model-codex-exec` 实现了 CKL-202 `StructuredGenerationModel` 的默认本地适配器，以非交互 `codex exec` 运行结构化知识抽取，同时保持 Compiler/Domain 对 Codex CLI、文件系统和子进程零依赖。

本模块没有在开发机上执行真实模型调用、写入 `~/.codex` 或启动后台进程。测试通过注入的进程端口验证完整命令、Schema、结果和诊断行为。

## 2. 运行契约

每次 `generate` 使用独立、权限为当前用户的临时目录：

1. 把 Compiler 提供的 JSON Schema 写入临时 `response.schema.json`。
2. 通过 stdin 传入版本化提取策略和 Episode；Episode 明确标记为不可信数据，不能把会话正文解释成运行指令。
3. 以参数数组、`shell: false` 启动：
   - `codex exec`
   - `--sandbox read-only`
   - `--ephemeral`
   - `--ignore-rules`
   - `--skip-git-repo-check`
   - `--json`
   - `--output-schema <schema>`
   - `--output-last-message <result>`
4. 从 result 文件读取唯一结构化结果；stdout 只作为 JSONL 运行事件流。
5. 无论成功、失败或取消都递归删除本次临时目录。

`--ignore-user-config` 是显式可选项，默认关闭，以保留用户选择的认证与模型 Provider；启用时仍复用 Codex 认证。模型名可选且经过字符白名单校验。

## 3. 安全与可靠性

| 风险 | 门禁 |
|---|---|
| Shell/参数注入 | `spawn(executable, args)` 且 `shell: false`；可执行文件、模型、路径和参数大小校验 |
| 会话 Prompt 注入 | Episode 作为 JSON 数据传入；顶层指令明确其不可信、只允许 Schema JSON 输出 |
| 代码或配置被模型修改 | 显式 `read-only` sandbox、ephemeral 会话、无 `workspace-write`/`danger-full-access` |
| stdout/stderr 内存膨胀 | prompt/result/JSONL/stderr 四类独立字节上限；流式 O(n) 累计计数，越界杀死子进程 |
| 卡死或遗留进程 | Adapter deadline 与调用方 AbortSignal 合并并传递给子进程 |
| 敏感诊断泄漏 | 只保留 JSONL 的事件 type、item type、status、error code 和 token usage；不保留正文、命令、reasoning、stderr 或结果 |
| 失败误分类 | Rate limit 可重试；认证拒绝不可重试；格式错误可重试；其余进程故障为 unavailable |
| 诊断无限增长 | 实例内有界 ring，默认只保留最近 20 次运行 |

## 4. 模块边界

依赖方向固定为：

```text
knowledge-compiler <- model-codex-exec <- daemon/distribution composition
```

- Compiler 只声明 `StructuredGenerationModel`，不知道 Codex CLI。
- Adapter 只依赖 Compiler 公共类型和 `KnowledgeExtractionAdapterError`。
- `scripts/model-codex-exec-boundary.test.mjs` 防止 Compiler 反向依赖 Adapter，并锁定 read-only、structured output、JSONL、non-shell 四项约束。
- 后续切换 Codex App Server 或其他 Provider 时新增同端口 Adapter，不修改 Candidate、Evidence 或知识生命周期。

## 5. Review 与验证

Review 检查了参数注入、临时文件、取消传播、输出上限、敏感诊断、错误映射、依赖倒置和并发调用。期间修复了子进程流量统计逐块重复求和可能造成的 O(n²) 开销，改为 O(n) 累计字节计数。

```text
npx vitest run packages/model-codex-exec/src --coverage ...
node --test scripts/model-codex-exec-boundary.test.mjs
npm run check
```

结果：Adapter 专项 9/9；Statements 95.32%、Branches 88.46%、Functions 93.75%、Lines 96%；架构边界 2/2；全仓 623/623 模块测试和 50/50 架构/Gate 测试通过，整体 Lines 96.90%、Branches 89.94%、Functions 98.04%。

## 6. 运行边界

- Adapter 源码完成不等于授权后台调用模型；发行装配仍应通过配置明确启用。
- 默认只读取已生成的 Episode 与当前项目只读上下文，不执行写操作。
- JSONL 诊断用于定位可用性、限流和 token 成本，不作为对话知识来源；知识正文只取经过 Schema 与 Grounding 校验的最终结果。
- 生产装配必须把项目根目录作为 `cwd`，并由外层 Compiler Runner 继续执行版本、重试、幂等和 Candidate 原子提交。
