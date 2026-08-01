# ZhiLoop 开发与质量门禁

## 固定工具链

- Node.js：`24.18.0` LTS，记录在 `.node-version`；生产与 CI 只使用受支持的 LTS 版本线。
- npm：`11.11.0`，记录在根 `package.json#packageManager`。
- TypeScript：严格模式、NodeNext 模块、Project References。
- 测试：Vitest；Domain 使用 V8 覆盖率门禁。
- 静态检查：ESLint 与 workspace 依赖方向/循环检查。

## 常用命令

```bash
npm ci
npm run build
npm run lint
npm run test
npm run check:deps
npm run check
```

`npm run check` 是提交前与 CI 的统一质量门禁。每个 workspace 还必须能在自身目录运行 `npm run build`。

## 模块完成规则

一个模块只有同时满足以下条件才算完成：

1. 实现没有越过技术设计规定的模块边界。
2. 单元测试覆盖正常、边界、拒绝和降级路径。
3. 契约或 Fixture 能验证跨模块数据结构。
4. `npm run check` 通过。
5. Review 已检查正确性、性能瓶颈、安全性、兼容性和可观测性。
6. 发现的风险已修复，或在文档中记录为带触发条件的后续任务。
