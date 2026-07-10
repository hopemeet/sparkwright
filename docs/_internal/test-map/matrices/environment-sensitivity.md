# Environment Sensitivity Matrix

Environment determines whether a test is proving product behavior or local
setup behavior. Record environment assumptions in scenarios.

## Dimensions

| Dimension           | Notes                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| OS/platform         | shell sandbox availability and process signal text can differ           |
| sandbox runtime     | Linux bind allow-list and macOS deny-list guard have different evidence |
| network             | real MCP/provider tests may depend on network availability              |
| workspace dirtiness | unrelated files can affect snapshot/diff/audit tests                    |
| cwd                 | relative cwd/path bugs often depend on process cwd vs workspace root    |
| XDG config/state    | user config can leak into tests unless isolated                         |
| generated `dist`    | downstream packages may import stale built output                       |
| trace level         | `standard` folds/suppresses high-volume events; `debug` preserves more  |
| timing              | foreground timeout/promotion tests should use tiny injected budgets     |

## Dist Freshness Rule

If a changed package is imported by name from another workspace and its
`package.json` exports `dist`, rebuild it before downstream tests.

Diagnostic command:

```bash
rg -n "NewFieldOrBehavior" packages/<pkg>/src packages/<pkg>/dist
```

If `src` has the behavior and `dist` does not, classify the failure as
`stale_dist` until proven otherwise.

## Workspace Isolation Rule

Tests that rely on config, XDG paths, workspace writes, shell cwd, or snapshot
diffs should use temporary workspace and XDG roots. Do not let a developer's
real `~/.config/sparkwright` decide a test result.
