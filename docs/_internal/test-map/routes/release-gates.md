# Release Gates

The repository release gate remains:

```bash
npm run release:check
```

Use this when a change is intended to be release-ready or when focused gates do
not give enough confidence.

## What Release Check Adds

The release gate layers:

- full build
- dist freshness checks
- workspace typechecks
- test typecheck
- lint and format checks
- schema drift checks
- package-boundary and internal-import checks
- runtime value-import/facade reverse-import checks
- reserved-field checks
- workspace tests
- deterministic regression matrix for host/CLI/TUI/ACP convergence scenarios
- deterministic installed/source smoke checks

`npm run regression:matrix` is part of `release:check` and covers deterministic
cross-layer regressions such as configured delegate shell `cwd`, shell
foreground promotion, no-task-manager timeout kill behavior, dynamic
`spawn_agent` finality/read-only boundaries, TUI hook output, ACP smoke, and
session consistency. Real-model mini regression runs remain opt-in/nightly and
are not a release-gate dependency when no API key is present.

## When To Prefer Focused Gates First

Run focused gates first while iterating on:

- command/parser behavior
- trace report logic
- TUI rendering details
- config validation shape
- single-package bug fixes

Then run release checks when the change is stable.

## Reporting Partial Verification

If release checks are not run, final summaries and coverage pages should say so
plainly. Use `Partially Verified` rather than implying release-level confidence.
