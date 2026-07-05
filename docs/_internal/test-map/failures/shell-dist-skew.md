# Shell Dist Skew

## Record

- Pattern ID: `shell-dist-skew`
- Status: `active`
- First seen: 2026-06-22
- Last seen: 2026-06-22
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 0 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 1 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

Package-local shell-tool tests pass against `src`, but host or CLI behavior
does not show the new shell fields, timeout semantics, or output shape.

## Root Cause

Downstream packages import `@sparkwright/shell-tool` through package exports
that point at `dist`. Source changes are invisible downstream until the package
is rebuilt.

## Diagnostic Move

Check both source and built output:

```bash
rg -n "foregroundTimeoutMs|timedOut|taskId" packages/shell-tool/src packages/shell-tool/dist
```

If `src` contains the behavior and `dist` does not, classify as `stale_dist`.

## Prevention

Run the package build before downstream host/CLI tests:

```bash
npm --workspace @sparkwright/shell-tool run build
```

For release-level confidence, use:

```bash
npm run check:dist-fresh
```

## Related

- Scenario: [../scenarios/shell-foreground-timeout.yaml](../scenarios/shell-foreground-timeout.yaml)
- Coverage: [../coverage/shell.md](../coverage/shell.md),
  [../coverage/config-schema.md](../coverage/config-schema.md)
- Matrix: [../matrices/environment-sensitivity.md](../matrices/environment-sensitivity.md)
