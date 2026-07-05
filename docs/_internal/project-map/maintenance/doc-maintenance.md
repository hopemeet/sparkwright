# Doc Maintenance

## Purpose

Keep `docs/_internal/project-map/` useful as the codebase grows.

## Contracts

- The project map is internal maintenance documentation.
- It should be short, linked, and verified.
- It should document boundaries and impact paths, not duplicate full reference docs.
- In this checkout `docs/_internal/` is ignored by git. Treat "same commit/PR"
  as "same local task and handoff" unless a branch explicitly tracks these
  files; if tracked, keep map updates with the behavior change.

## Consumers

- Maintainers before and after cross-cutting changes.
- Future agents asked to modify SparkWright safely.

## Verification Status

Every page's `Last Verified` block carries a `Status:` line. It is the rollup a
reader checks before trusting the page. Use exactly one of:

- `Verified` — claims were cross-checked against current source AND the relevant
  tests were run and pass. Safe to rely on.
- `Read-only` — claims were cross-checked by reading current source, but no
  tests were run. Trust it to find _where_ to look; confirm behavior in code
  before depending on a specific contract.
- `Stale?` — the page predates known code changes in its area, or a claim is
  suspected wrong. Re-verify before relying on it; do not build on it as-is.

Rules:

- A `Date` without a `Status` is incomplete — always set both.
- Bumping `Date` does not by itself upgrade `Status`. Only running the tests
  upgrades a page to `Verified`.
- When you touch code a page describes but do not re-check the page, set it to
  `Stale?` rather than leaving an old `Verified`/`Read-only` standing.

## Change Checklist

- Update root `README.md` when a new file becomes a frequent touch point.
- Keep module pages focused on ownership.
- Keep map pages focused on data flow and contracts.
- Prefer links to existing reference docs over copied protocol detail.
- Add `Open Questions` when unsure; do not invent behavior.
- Refresh `Last Verified` after meaningful code changes.
- If tests were not run, say so explicitly.

## Known Debts

- First pass is broad but shallow for some capability packages.
- Some package-specific tests are listed only at package level, not per workflow.
- Because `_internal` is local-only in this checkout, drift checks are advisory
  unless the map is copied into a tracked review branch.

## Last Verified

- Status: Read-only
- Date: 2026-06-27T18:53:34+0800
- Read: `.gitignore`, `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/maintenance/doc-maintenance.md`,
  `docs/_internal/project-map/maintenance/known-debts.md`.
- Tests: not run; documentation-only maintenance pass.
