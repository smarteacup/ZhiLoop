# M5 CodeGraph 代码事实层实施说明

ZhiLoop 不复制 CodeGraph 的代码图，而是通过 `code-intelligence` 端口实时取得结构事实。`codegraph-adapter` 只负责版本/健康检查、有界查询和 DTO 转换。

```text
Knowledge Assertion
  -> Evidence Verifier
  -> CodeIntelligencePort
  -> CodeGraph argv process (shell=false)
  -> strict JSON projection
  -> normalized path/line/symbol fact
  -> Evidence Observation
```

安全约束：

- 后台不执行 `init/index/sync`。
- 节点 ID、分数和 CodeGraph SQLite Schema 不进入 Evidence/Knowledge。
- 未初始化、版本不兼容和超时都不伪装为“符号不存在”。
- 缓存必须绑定项目指纹，指纹改变后重查。
