## 1. Policy and orchestration

- [x] 1.1 Change the default automatic injection baseline to L1 pointers and raise the pointer candidate limit without increasing the hard token ceiling
- [x] 1.2 Implement mixed L1/L2 automatic envelopes with reserved Binding Rule selection and no automatic bulk L3 risk promotion
- [x] 1.3 Add orchestrator tests for mixed detail levels, binding reservation, risk behavior and budget fallback

## 2. Runtime knowledge expansion

- [x] 2.1 Change `ckl.search` and `ckl.related` results to scoped L1 pointers
- [x] 2.2 Extend `ckl.get` with explicit L2/L3 target detail and compatible L3 default behavior
- [x] 2.3 Add MCP tests for pointer discovery, L1-to-L2, L1-to-L3, version, status and Scope enforcement

## 3. Codex integration

- [x] 3.1 Render a machine-readable progressive-disclosure protocol in UserPrompt additional context
- [x] 3.2 Update ZhiLoop knowledge Skill instructions to select and expand pointers before applying implementation details
- [x] 3.3 Add injection tests proving pointers contain no body and expose expansion affordances

## 4. Documentation and simulation

- [x] 4.1 Update ADR, TDD, implementation documents and default configuration examples
- [x] 4.2 Extend the real session simulation to exercise initial pointer injection and explicit L2/L3 expansion
- [x] 4.3 Validate the OpenSpec change and synchronize task completion state

## 5. Verification and delivery

- [x] 5.1 Run module tests, architecture gates, typecheck, lint and coverage checks
- [x] 5.2 Review security, compatibility, token budget, duplicate expansion and closure-continuation risks
- [x] 5.3 Commit and push the completed change

## 6. Production-readiness follow-up

- [x] 6.1 Extract a shared Context Renderer and enforce the token ceiling against the complete rendered `additionalContext`
- [x] 6.2 Add disclosed/omitted directory counts and a machine-readable `ckl.search` continuation action
- [x] 6.3 Add regression tests for rendered-budget trimming, binding preservation and truncation discoverability
- [x] 6.4 Synchronize implementation documents and run full build, test, lint, coverage and review gates
