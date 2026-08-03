export { renderAdditionalContext } from "@zhiloop/context-renderer";

import type { UserPromptInjectionResult } from "./types.js";

export function serializeUserPromptHookResult(result: UserPromptInjectionResult): string {
  return result.output === undefined ? "" : JSON.stringify(result.output);
}
