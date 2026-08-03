import {
  InjectionRolloutController,
  UserPromptInjectionService,
  type UserPromptSubmitInput,
} from "@zhiloop/codex-context-injection";

import type { ActiveRolloutService } from "./rollout-service.js";
import type {
  RolloutRequestScope,
  ScopedInjectionCoordinatorDependencies,
  ScopedInjectionCoordinatorOptions,
  ScopedInjectionResult,
} from "./types.js";

function defaultScope(input: UserPromptSubmitInput): RolloutRequestScope {
  return { sessionId: input.session_id, turnId: input.turn_id };
}

export class ScopedInjectionCoordinator {
  private readonly deadlineMs: number | undefined;
  private readonly scopeResolver: (input: UserPromptSubmitInput) => RolloutRequestScope;

  constructor(
    private readonly dependencies: ScopedInjectionCoordinatorDependencies,
    private readonly rollout: ActiveRolloutService,
    options: ScopedInjectionCoordinatorOptions = {},
  ) {
    this.deadlineMs = options.deadlineMs;
    this.scopeResolver = options.scopeResolver ?? defaultScope;
  }

  async handle(input: UserPromptSubmitInput, now = new Date().toISOString()): Promise<ScopedInjectionResult> {
    const decision = this.rollout.decision(this.scopeResolver(input));
    let controller = this.rollout.injectionRollout;
    if (decision.reasonCode === "GRAY_SCOPE_EXCLUDED") {
      controller = new InjectionRolloutController();
      controller.activate(1, "SHADOW");
    }
    const injection = new UserPromptInjectionService(
      this.dependencies.provider,
      controller,
      this.deadlineMs === undefined ? {} : { deadlineMs: this.deadlineMs },
    );
    const result = await injection.handle(input);
    try {
      this.rollout.observeInjectionResult(decision, result, now);
    } catch {
      // Hook delivery remains fail-open even if durable downgrade persistence fails.
    }
    return { ...result, rolloutDecision: decision };
  }
}
