# ADR 0002: Trace, Approval, And Policy In v0

## Status

Proposed

## Context

Many agent frameworks start by making tool execution easy, then add control and audit later. SparkWright's differentiator is controlled execution, not just orchestration.

## Decision

Trace, approval, and policy are required v0 primitives.

Workspace writes should require approval by default.

Events should be emitted for run lifecycle, model calls, tool calls, approval, workspace operations, and artifact creation.

## Consequences

Positive:

- safety model shapes the architecture early
- traces become a first-class product surface
- enterprise and local automation use cases remain credible
- risky actions can be intercepted consistently

Negative:

- v0 implementation is slightly larger
- the first demo needs approval plumbing before it feels fully useful
- API design must handle paused runs from the start

## Follow-Up

Approval should support CLI prompts first, then server callbacks and external policy engines later.
