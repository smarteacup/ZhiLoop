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
    expect(p2ReasonDetail("JOB_LEASE_EXPIRED")).toContain("服务重启");
    expect(p2ReasonDetail("GRAPH_REVISION_CHANGED")).toContain("整体丢弃");
    expect(p2EnumLabel("FUTURE_P2_ENUM")).toBe("FUTURE_P2_ENUM");
  });
});
