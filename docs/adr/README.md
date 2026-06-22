# Architecture Decision Records

This directory captures key design decisions for the SparkWright kernel. Each ADR records **why** a decision was made, not just what was decided. ADRs are append-only: superseded decisions remain in the history with a status change.

Read these before proposing structural changes. If a change conflicts with an existing ADR, supersede it explicitly with a new ADR rather than silently diverging.

## Index

| ADR  | Title                                                                                                       | Status   |
| ---- | ----------------------------------------------------------------------------------------------------------- | -------- |
| 0001 | [TypeScript-First Runtime](./0001-typescript-first.md)                                                      | Proposed |
| 0002 | [Trace, Approval, And Policy In v0](./0002-trace-approval-policy-in-v0.md)                                  | Proposed |
| 0003 | [Anchored Edits Over Line Numbers](./0003-anchored-edits-over-line-numbers.md)                              | Accepted |
| 0004 | [Approval-Gated Workspace Writes](./0004-approval-gated-workspace-writes.md)                                | Accepted |
| 0005 | [Deterministic Default Model For The Golden Path](./0005-deterministic-default-model-for-golden-path.md)    | Accepted |
| 0006 | [JSONL Traces With Tiered Detail](./0006-jsonl-traces-with-tiered-detail.md)                                | Accepted |
| 0007 | [Buffered Emitter For Pre-Run Extension Events](./0007-buffered-emitter-for-extension-events.md)            | Accepted |
| 0009 | [Step Count Is Not A Task Budget For Long-Horizon Agents](./0009-step-cap-unfit-for-long-horizon-agents.md) | Proposed |

## Format

Each ADR follows the same structure:

- **Status** — Proposed, Accepted, Superseded by ADR-NNNN, or Deprecated.
- **Context** — The forces and constraints that motivated the decision.
- **Decision** — What was decided, stated in the present tense.
- **Consequences** — Positive and negative outcomes of the decision.
- **Alternatives considered** — Options that were rejected, with the reason.
- **Follow-Up** — Where the implementation lives and what remains.

## When To Write A New ADR

Write an ADR when a change:

- shapes a kernel boundary (storage, provider, workspace, policy, approval, trace);
- introduces a new extension protocol;
- supersedes or contradicts an earlier ADR;
- locks in a default behavior that is hard to reverse later.

Do not write an ADR for routine refactors, bug fixes, or additions that fit cleanly inside an existing boundary.
