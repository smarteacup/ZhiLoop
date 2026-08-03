import { describe, expect, it } from "vitest";

import { parseRoute } from "./routes.js";

describe("console routes", () => {
  it("decodes bounded session routes and rejects malformed escape sequences", () => {
    expect(parseRoute("#/sessions/session%3A1")).toEqual({ name: "sessions", sessionId: "session:1" });
    expect(parseRoute("#/sessions/%ZZ")).toEqual({ name: "overview" });
    expect(parseRoute("#/unknown")).toEqual({ name: "overview" });
    expect(parseRoute("#/jobs")).toEqual({ name: "jobs" });
    expect(parseRoute("#/diagnostics")).toEqual({ name: "diagnostics" });
    expect(parseRoute("#/configuration")).toEqual({ name: "configuration" });
    expect(parseRoute("#/closure/session%3A1")).toEqual({ name: "closure", sessionId: "session:1" });
    expect(parseRoute("#/knowledge/rule%3Acompiler")).toEqual({ name: "knowledge", knowledgeId: "rule:compiler" });
    expect(parseRoute("#/knowledge/%ZZ")).toEqual({ name: "overview" });
  });
});
