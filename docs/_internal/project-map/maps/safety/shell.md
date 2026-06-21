# Shell

## Purpose

Shell execution gives the agent local command power while routing risk through
classification, policy, approval, sandboxing, trace, and task promotion.

See [workspace-writes.md](workspace-writes.md) and [../../modules/coding-tools.md](../../modules/coding-tools.md).

## Main Files

- `packages/host/src/shell.ts`
- `packages/host/src/workspace-snapshot.ts`
- `packages/shell-tool/src/*`
- `packages/shell-sandbox/src/*`
- `packages/core/src/run.ts`
- `packages/agent-runtime/src/tasks/*`

## Data Flow

```txt
model calls shell tool
  -> shell-tool classification
  -> core policy/approval
  -> sandbox/runtime execution
  -> output or promoted task
  -> promoted task adopts live shell stream via TracedProcessRunner
  -> trace + task state
```

## Contracts

- Shell is a normal tool and must not bypass core policy or trace.
- Unsafe shell commands require approval according to configured policy.
- Shell should not mutate managed capability files directly; use dedicated tools.
- Shell command parsing strips here-doc bodies before safety/path-scope
  inspection, so source text inside heredocs (for example shebangs or sample
  absolute paths) is not mistaken for an argument; the declaring command line
  is still inspected.
- Shell mutation audit uses `workspace-snapshot.ts` for snapshot/diff/rollback;
  the same host primitive is reused by MCP side-effect detection.
- Configured in-process delegates can select `shell`, but shell remains gated
  by the parent run's write-enabled policy; capability descriptors should mark
  this with `gatedByRunWrite` rather than attempting command-specific read-only
  downgrades.
- The core repeated-tool guard keys shell retries by command plus cwd, ignoring
  incidental execution fields such as `timeoutMs`, so a model cannot bypass the
  loop guard by varying timeout-only arguments.
- Long-running shell can be promoted to durable task state.
- Promoted shell tasks keep `task.*` as their trace lifecycle; stdout/stderr are
  buffered in `TaskStore`, mirrored as `task.output`, and summarized on the
  terminal task event through `ProcessOutputSummary`.

## Consumers

- Host main toolset.
- CLI/TUI approval flows.
- Trace safety summary.
- Task commands and tools.

## Change Checklist

- Check sandbox config and fallback behavior.
- Check approval metadata and shell-safe flags.
- Check output size caps and task promotion.
- Check trace summary safety fields for command failures and untracked mutations.

## Known Debts

- Shell is powerful and cross-cuts workspace, tasks, trace, and capability state.

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/shell-tool/src/command-parser.ts`, `packages/shell-tool/src/safety.ts`, `packages/shell-tool/src/tool.ts`, `packages/shell-tool/test/shell-tool.test.ts`, `packages/host/src/shell.ts`, `packages/host/src/workspace-snapshot.ts`, `packages/host/src/runtime.ts`, `packages/host/test/tools.test.ts`, `scripts/regression-real-skill-capabilities.mjs`.
- Tests: `npm --workspace @sparkwright/shell-tool test`; `npm --workspace @sparkwright/host test -- test/tools.test.ts`; `npm run regression:real-skill-capabilities`.
