# P6 Gate 验收报告

## 1. 结论

P6 Gate 通过。固定版本 `fixtures/p6/v1/interaction-golden.json` 驱动 100 Turn 闭环测试，直接连接 Interaction Policy、Closure Verifier、Stop Continuation、Feedback Store 和 Retrieval Engine；六项指标全部满足实施计划门槛。

本 Gate 只验证确定性领域行为和适配器协作，不安装 Hook、不启动 Daemon，也不修改用户 Codex、CCM 或 `~/.ckl` 配置。

## 2. 固定数据集

| 数据 | 数量 | 用途 |
|---|---:|---|
| Turn | 100 | 统一分母和 20 Turn 滚动窗口 |
| 可确认触发 | 100 | 验证限频与无人处理安全默认 |
| 失败后续跑 Turn | 10 | 验证有限续跑和递归 Stop 防护 |
| 已声明边界违规 Turn | 20 | 验证门禁漏判率 |
| suppress 后召回复查 | 50 | 验证同 Scope 不再返回资产 |

数据集使用版本字段并固定 Turn 编号。Gate 不从生产数据抽样，因此结果可重复、可在 CI 中回归；真实分布监控属于部署后的运行验收。

## 3. 指标结果

| 指标 | 计算 | 结果 | 门槛 | 结论 |
|---|---|---:|---:|---|
| 每 20 Turn 最大确认次数 | 所有连续 20 Turn 窗口取最大值 | 1 | ≤ 1 | 通过 |
| 无人工处理比例 | `(100 - 5) / 100` | 95% | ≥ 90% | 通过 |
| suppress 重复出现率 | `0 / 50` | 0% | < 2% | 通过 |
| 闭环死循环数量 | recursive Stop 再次续跑次数 | 0 | = 0 | 通过 |
| 自动续跑平均次数 | `10 / 100` | 0.10/Turn | ≤ 0.20/Turn | 通过 |
| 违反门禁仍成功比例 | `0 / 20` | 0% | < 1% | 通过 |

其中确认发生在 Turn 1、21、41、61、81；其余触发均采用类型对应的安全默认。Stop 第一次遇到失败测试时输出精确修正，递归调用携带 `stop_hook_active=true` 后禁止再次续跑。

## 4. 防止“测了假闭环”

- 确认率调用真实 `evaluateInteractionPolicy`，历史只记录实际生成的 ConfirmationRequest。
- 门禁漏判调用真实 `ClosureVerifier`，每个违规样本都修改命中禁止前缀的路径。
- 续跑调用真实 `StopContinuationService`，并实际执行一次递归 Stop 检查。
- suppress 先写入真实 SQLite Feedback Store，再把 profile 交给真实 Retrieval Engine；不是直接断言 Store 状态。
- 阈值来自版本化 fixture，测试脚本不内嵌另一套宽松阈值。

## 5. 验证证据

```text
npm run build
node --test scripts/p6-gate.test.mjs
npm run check
npm audit --audit-level=high --registry=https://registry.npmjs.org
```

结果：P6 专项 1/1；全仓 558/558 模块测试、44/44 架构/Gate 测试；34 个 Workspace 依赖与 import policy 通过；整体 Lines 96.98%、Branches 89.89%、Functions 98.43%；官方 npm registry 报告 0 vulnerabilities。

## 6. 后续边界

P6 证明闭环策略在固定数据集上的安全性，不等同于真实 App Server 兼容或生产稳定性。P7 将分别实现 App Server Event Adapter、可恢复历史回填和可逆插件包装，再进行最终安装沙箱与兼容性验收。
