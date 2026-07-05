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
- Project-map package coverage is intentionally hot-path based. Packages without
  dedicated module pages are grouped under
  [../modules/edge-packages.md](../modules/edge-packages.md) and should graduate
  only when repeated changes need clearer ownership boundaries.
- In this checkout `docs/_internal/` is ignored by git, so "update the map with
  the change" cannot be enforced by normal PR diff review unless these files are
  explicitly tracked in that branch.

## Consumers

- Maintainers planning larger changes.
- Reviewers checking whether a local change worsens an existing risk.

## Change Checklist

- Move an item to a specific module/map page when it becomes actionable.
- Add source links when a debt is tied to a test failure or recurring regression.
- Remove debts only after code, tests, and docs all reflect the fix.

## Last Verified

- Status: Read-only
- Date: 2026-06-27T18:53:34+0800
- Read: `.gitignore`, `package.json`, `README.md`,
  `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/modules/edge-packages.md`.
- Tests: not run; documentation-only debt pass.
