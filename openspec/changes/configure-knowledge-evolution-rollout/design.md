# Design: Configuration v2 and safe rollout

Version 1 is parsed with its original strict schema, completed with the original defaults and then mapped field-for-field into version 2. Version 2 is strict and future versions fail with `UNSUPPORTED_CONFIG_VERSION`; migration never mutates caller input.

The Console configuration remains a transport-specific schema, upgraded to `schemaVersion: 2`. Its new sections mirror the core policy and are consumed by revisioned activation components. The compilation component maps online values to the existing scheduler. Freshness scheduling is represented by a completion-based, single-flight scheduler accepting normalized `KnowledgeChangeSet` values from Git/CodeGraph adapters; the scheduler itself does not scan repositories or initialize CodeGraph.

Automatic publication is authorized per Candidate. A request is denied unless publication is enabled, mode is `SAFE_AUTO_PUBLICATION`, project and kind are allowlisted, required fresh-code evidence is present, and the supplied golden dataset/config fingerprints match the explicitly configured evidence identity. Denial retains Candidate Preview and provides one deterministic reason code.

No configuration may enable automatic tests, implicit global promotion, CodeGraph initialization, or blocking Codex on a knowledge-path failure.
