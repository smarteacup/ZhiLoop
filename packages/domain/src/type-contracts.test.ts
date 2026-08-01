import { describe, expectTypeOf, it } from "vitest";

import type { CandidateSupport } from "./knowledge.js";
import type { KnowledgeScope } from "./scope.js";

type EmptyCandidateSupport = {
  readonly assertions: readonly [];
  readonly evidenceHints: readonly [];
};

describe("Domain type contracts", () => {
  it("requires at least one assertion or evidence hint", () => {
    expectTypeOf<EmptyCandidateSupport extends CandidateSupport ? true : false>().toEqualTypeOf<false>();
  });

  it("keeps project coordinates out of GLOBAL scope", () => {
    type GlobalScope = Extract<KnowledgeScope, { readonly level: "GLOBAL" }>;
    expectTypeOf<keyof GlobalScope>().toEqualTypeOf<"level">();
  });
});
