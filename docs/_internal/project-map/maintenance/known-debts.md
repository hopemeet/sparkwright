# Known Debts

## Purpose

Collect cross-cutting maintenance risks that should influence design and review.

## Contracts

These are not promises of current behavior. They are risk flags to revisit when changing adjacent code.

## Known Debts

- Raw `trace.jsonl` can become very large; retention, rotation, and human report layers are still limited.
- `workspace.read` events can be noisy and can hide higher-value diagnostics.
- Repeated tool calls can inflate trace volume and make failure analysis harder.
- Session metadata does not yet make final/completion state prominent enough for humans.
- TUI `/export` is readable, but not a full diagnostic report.
- Host runtime is a broad composition point where capability, session, trace, and policy changes meet.
- From-trace resume is only best-effort and can be mistaken for full restore.
- Capability self-evolution design exists, but stable runtime behavior should remain explicit and reviewable.

## Consumers

- Maintainers planning larger changes.
- Reviewers checking whether a local change worsens an existing risk.

## Change Checklist

- Move an item to a specific module/map page when it becomes actionable.
- Add source links when a debt is tied to a test failure or recurring regression.
- Remove debts only after code, tests, and docs all reflect the fix.

## Last Verified

- Status: Read-only
- Date: 2026-06-18
- Read: requested source/docs set and current project-map first pass.
- Tests: not run; documentation-only map pass.
