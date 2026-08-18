# Design

The Console reads one server-composed knowledge detail. The Sidecar joins the immutable registry version with the matching freshness projection and mutable freshness state. Missing projections are reported as `NOT_PROJECTED`; they are never presented as fresh.

Eligibility is the intersection of governance eligibility and freshness eligibility. Code-anchored knowledge requires `FRESH`; knowledge without code anchors remains governed by its existing lifecycle/evidence rules. The response includes only bounded, normalized anchor metadata and at most 100 immutable transition events.

The web client validates the complete response with a strict Zod schema. Chinese labels are presentation-only; raw enums and reason codes remain in `title` or `code` text for diagnosis and support.
