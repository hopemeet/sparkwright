# ADR 0004: Approval-Gated Workspace Writes

## Status

Accepted

## Context

A coding/repo-automation agent's most consequential action is writing to the workspace. A bad write can corrupt source, leak secrets, or quietly change configuration. Other harnesses commonly let the model write directly through a `write_file` tool, treating the model's intent as authority and relying on post-hoc review (git diff, CI) to catch mistakes.

Sparkwright's positioning rejects that trade. The kernel's stated principle is **"the model proposes, the harness disposes"** — the model can request a change, but the harness owns whether and how it happens. Reviewing damage after the fact is not the same as preventing it before the fact, and post-hoc review does not compose with non-git side effects (deletes, renames, binary writes, configuration files outside source control).

## Decision

All workspace writes flow through a **propose → validate → policy → approval → diff → apply** pipeline. The model never mutates the filesystem directly. A `workspace_write` tool call produces a write _proposal_, which the harness evaluates against validation hooks and policy before materializing the diff artifact. If policy returns `requires_approval`, the run transitions to `waiting_approval` and an `approval.requested` event is emitted with the proposal diff for review. The write only lands after `approval.resolved` with `decision: "approved"` _and_ a final baseline-hash verification confirms the file has not changed since the proposal was built.

By default, workspace writes require approval. Policy may downgrade specific paths or operations to `auto_approve` for trusted automation, but the default safe stance is opt-in approval.

## Consequences

Positive:

- The approval request includes the proposed diff, while the durable diff artifact is created only for approved writes so denied proposals do not persist full proposed content.
- A single audit chain — `workspace.write.requested` → `approval.requested` → `approval.resolved` → `artifact.created` → `workspace.write.completed` — explains every mutation in trace.
- Approval channels are pluggable (CLI, Slack, web, CI gate); the harness contract does not assume a human in the loop, only a resolver.
- Baseline-hash verification at the final step protects against TOCTOU races between proposal and apply.
- The same path handles deletes, anchored edits, and binary writes uniformly.

Negative:

- The first demo needs approval plumbing before it feels useful; there is no "just write the file" shortcut.
- Run state must model `waiting_approval` and resume from it, which complicates the lifecycle (paused runs, persisted approval requests).
- Auto-approval policies must be authored explicitly; teams used to permissive defaults will feel friction until policies are tuned.
- Latency for interactive flows is bounded by approval-channel round-trip.

## Alternatives considered

- **Direct writes with post-hoc review (git diff)**: rejected because it does not generalize beyond git-tracked text files and gives no pre-mutation control point for risky operations (deletes, secrets, configs).
- **Dry-run mode toggle**: rejected as the _default_ because a global toggle is the wrong granularity — risk varies per path, per tool, per side effect, not per run.
- **Tool-level confirmation prompts only**: insufficient because confirmation without a diff artifact gives the approver nothing to evaluate; the artifact is the unit of review.
- **Approval after write, with rollback**: rejected because rollback is unreliable for non-git side effects and because a "rolled-back" trace is worse than a "denied" trace for audit.

## Follow-Up

The reference implementation lives in `packages/core/src/workspace.ts` (`ControlledWorkspace`). Approval channel adapters are described in `docs/reference/EXTENSION_INTERFACES.md` (Approval Extensions). The broader principle is documented in `docs/archive/HARNESS_PRINCIPLES.md` ("Workspace Writes Are Proposals Before Mutations"). The approval primitive will be extended to support external policy engines and async approval queues in later revisions.
