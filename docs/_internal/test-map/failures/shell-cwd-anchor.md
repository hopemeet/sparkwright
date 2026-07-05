# Shell Cwd Anchor

## Record

- Pattern ID: `shell-cwd-anchor`
- Status: `active`
- First seen: 2026-06-22
- Last seen: 2026-06-22
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 1 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

A shell command with relative `cwd` runs from the process cwd or an unexpected
host location instead of the configured workspace root.

## Root Cause

The shell path resolver treats relative cwd/path arguments as process-relative
when the contract requires workspace-relative resolution under `workspaceRoot`.

## Diagnostic Move

Use a temporary workspace whose path differs from the repo process cwd, then run
simple read-only shell probes:

```bash
pwd
pwd # with cwd="."
pwd # with cwd="packages/host"
```

Assert the executed cwd stays inside the workspace root and that escape attempts
are denied.

## Prevention

- Keep shell cwd normalization inside the shell-tool/host shell boundary.
- Test both main shell and configured delegate child shell paths.
- Include cwd assertions in the shell focused route after changing workspace
  snapshot, config, delegate, or shell catalog code.

## Related

- Coverage: [../coverage/shell.md](../coverage/shell.md)
- Matrix: [../matrices/environment-sensitivity.md](../matrices/environment-sensitivity.md)
