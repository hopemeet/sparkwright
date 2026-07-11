# Coverage

Coverage pages describe confidence by behavior area. They are not a replacement
for tests; they are a guide for choosing the next useful verification route.

Each page should separate:

- behavior already covered by focused tests
- weak coverage that only checks a narrow path
- untested edges
- stale triggers that require re-verification
- scenario, matrix, and failure-pattern links

## Status Policy

Use the status vocabulary from [../README.md](../README.md#status-vocabulary).
Do not mark a page `Verified` unless the source was checked and the relevant
focused tests passed after the relevant change. When in doubt, prefer
`Partially Verified` and name the missing evidence.

## Index

| Area | Page | Primary Route |
| --- | --- | --- |
| Shell execution | [shell.md](shell.md) | [routes/capability-routes.md#shell-execution](../routes/capability-routes.md#shell-execution) |
| Trace diagnostics | [trace-diagnostics.md](trace-diagnostics.md) | [routes/capability-routes.md#trace-diagnostics](../routes/capability-routes.md#trace-diagnostics) |
| Agents and delegates | [agents.md](agents.md) | [routes/capability-routes.md#agents-and-delegates](../routes/capability-routes.md#agents-and-delegates) |
| TUI rendering | [tui-rendering.md](tui-rendering.md) | [routes/capability-routes.md#tui-first-screen-and-live-rendering](../routes/capability-routes.md#tui-first-screen-and-live-rendering) |
| Workflow durable jobs | [workflow-durable-jobs.md](workflow-durable-jobs.md) | Package A/B focused routes; Package C fault world remains closed |
| Config schema | [config-schema.md](config-schema.md) | [routes/capability-routes.md#capability-inspect](../routes/capability-routes.md#capability-inspect) |
| Skills | [skills.md](skills.md) | focused host/skills/TUI Skill gates plus real Skill capability canary |
| Cron | [cron.md](cron.md) | focused cron package/CLI gates plus isolated real cron run |
