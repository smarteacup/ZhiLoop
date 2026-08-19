import { describe, expect, it } from "vitest";

import { p2EnumLabel, p2ReasonDetail } from "./labels.js";

describe("P2 Chinese enum labels", () => {
  it("translates extraction, policy and durable-job diagnostics while preserving unknown codes", () => {
    expect(p2EnumLabel("CANDIDATE_PREVIEW")).toBe("候选知识生成");
    expect(p2EnumLabel("KEEP_PROPOSED")).toBe("保留为候选");
    expect(p2EnumLabel("JOB_LEASE_EXPIRED")).toBe("后台任务执行租约已过期");
    expect(p2EnumLabel("CALL_PATH_EXISTS")).toBe("调用路径存在");
    expect(p2EnumLabel("CODEGRAPH_NOT_INITIALIZED")).toBe("当前项目尚未初始化 CodeGraph");
    expect(p2EnumLabel("SNAPSHOT_TEST_OBSERVATION_NOT_FOUND")).toBe("当前快照没有对应测试记录");
    expect(p2EnumLabel("ASSERTION_REFUTED")).toBe("存在被代码证据否定的断言");
    expect(p2EnumLabel("MODEL_ONLY_REMAINS_PROPOSED")).toBe("仅有模型结论，继续保留为候选");
    expect(p2EnumLabel("COMPILE_EMPTY")).toBe("当前没有知识编译任务");
    expect(p2EnumLabel("INJECTION_READ_MODEL_SEPARATE")).toBe("注入记录在召回与注入页面独立展示");
    expect(p2EnumLabel("CAPTURED_PARTIAL")).toBe("部分采集");
    expect(p2ReasonDetail("JOB_LEASE_EXPIRED")).toContain("服务重启");
    expect(p2ReasonDetail("GRAPH_REVISION_CHANGED")).toContain("整体丢弃");
    expect(p2EnumLabel("FUTURE_P2_ENUM")).toBe("未知状态（FUTURE_P2_ENUM）");
  });
});
