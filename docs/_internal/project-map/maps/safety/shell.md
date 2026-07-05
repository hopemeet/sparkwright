# Shell

## Purpose

Shell execution gives the agent local command power while routing risk through
classification, policy, approval, sandboxing, trace, and task promotion.

See [workspace-writes.md](workspace-writes.md) and [../../modules/coding-tools.md](../../modules/coding-tools.md).

## Main Files

- `packages/host/src/shell.ts`
- `packages/host/src/traced-process-runner.ts`
- `packages/host/src/workflow-node-api.ts`
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
- Shell `previewArgs()` only formats `tool.requested.payload.preview` for UI
  display; safety classification, path-scope checks, policy, and approval still
  use the parsed command arguments at execution/gating time.
- Unsafe shell commands require approval according to configured policy.
- A returned shell result describes *post-execution* reality, not the
  pre-execution classification. `decision` is the safety class only (a completed
  result with `decision: require_approval` means approval was granted upstream
  and the command ran). `executed: true` and `approvalStatus`
  (`approved`/`not_required`) are the affirmative execution signals; the model
  must read those (and `exitCode`) rather than treating `decision` as a block.
  All three `runWithPromotion` return paths set them.
- Shell should not mutate managed capability files directly; use dedicated tools.
- Shell command parsing strips here-doc bodies before safety/path-scope
  inspection, so source text inside heredocs (for example shebangs or sample
  absolute paths) is not mistaken for an argument; the declaring command line
  is still inspected.
- When `workspaceRoot` is configured, shell cwd path-scope uses
  workspace-relative semantics: relative `cwd` values such as `.` and
  `packages/host` resolve against the workspace root, not the host process
  cwd. Denial reasons include the given path, resolution anchor, resolved path,
  and allowed roots so "wrong semantic anchor" and real escape attempts are
  distinguishable.
- Shell mutation audit uses `workspace-snapshot.ts` for snapshot/diff/rollback;
  the same host primitive is reused by MCP side-effect detection.
- Configured in-process delegates can select `shell`, but shell remains gated
  by the parent run's write-enabled policy; capability descriptors should mark
  this with `gatedByRunWrite` rather than attempting command-specific read-only
  downgrades.
- The core repeated-tool guard keys shell retries by command plus cwd, ignoring
  incidental execution fields such as `timeoutMs`, so a model cannot bypass the
  loop guard by varying timeout-only arguments.
- Long-running shell uses one foreground budget. `foregroundTimeoutMs` defaults
  to 300000 ms and is capped at 600000 ms. Per-call legacy `timeoutMs` is an
  observable alias for `foregroundTimeoutMs`; it no longer configures process
  hard-kill. Tool output reports `foregroundTimeoutMs`,
  `promotionAvailable`, and whether the alias was used.
- Invalid shell execution arguments discovered during shell input
  normalization, including `timeoutMs: 0`, are surfaced through the normal
  core tool lifecycle as `tool.failed` (`TOOL_ARGUMENTS_INVALID`) instead of
  escaping before the shell span closes.
- When the foreground budget expires, hosts with a task manager promote the live
  process to durable task state. Hosts without promotion abort the process and
  return `timedOut: true` with a diagnostic saying promotion was unavailable.
- Shell promotion is also governed by the resolved run `backgroundTasks`
  policy. `enabled` allows promotion, `foreground-only` keeps foreground shell
  behavior without promotion, and `disabled` reports promotion unavailable even
  when a task manager exists.
- Promoted shell tasks keep `task.*` as their trace lifecycle; stdout/stderr are
  buffered in `TaskStore`, mirrored as `task.output`, and summarized on the
  terminal task event through `ProcessOutputSummary`.
- Workflow P4 script processes reuse the host process/sandbox substrate rather
  than defining a second runner. `workflow-node-api.ts` maps script execution
  into `TracedProcessRunner.runJsonRpc()` with shell-sandbox policy inputs,
  stdout reserved for newline-delimited JSON-RPC, and stderr reserved for
  progress/telemetry. Script requests for governed command side effects go back
  through the host node API (`invoke(type:"command")`) instead of granting the
  script a raw shell capability.

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
- Date: 2026-07-05T15:31:20+0800
- Scope: workflow-runtime-v1 P4 shell/process safety: stdio script node
  execution reuses `TracedProcessRunner` and shell-sandbox access clamps, while
  governed command effects stay host-mediated through the node API.
- Read: `packages/host/src/traced-process-runner.ts`,
  `packages/host/src/workflow-node-api.ts`,
  `packages/host/src/external-command-agent.ts`,
  `packages/host/test/traced-process-runner.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
  test/traced-process-runner.test.ts test/workflow-hooks.test.ts
  test/external-command-agent.test.ts`; `npm --workspace @sparkwright/host run
  typecheck`; `npm run release:check`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: shell promotion availability now honors the host-resolved
  `backgroundTasks` policy while preserving the existing foreground timeout and
  promoted task trace/store contract.
- Read: `packages/host/src/shell.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/maps/safety/shell.md`.
- Tests: `npm --workspace @sparkwright/host test --
  test/spawn-agent.test.ts -t "foreground-only background policy|promotes slow dynamic"`;
  host typecheck/build.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after canonical `bash` exposure; shell execution,
  sandboxing, promotion, rollback, and approval semantics did not change.
- Read: `packages/host/src/shell.ts`,
  `packages/core/src/approval-policy.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `docs/_internal/project-map/maps/safety/shell.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts test/protocol.test.ts test/config.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`.

- Status: Verified
- Date: 2026-06-26T01:00:00+0800
- Read: `packages/shell-tool/src/tool.ts`, `packages/host/src/shell.ts`.
- Tests: `npm --workspace @sparkwright/shell-tool run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm run check:reserved:strict`; `npm run schema:check`; `npm run build`;
  `npm run check:dist-fresh`. Added `executed`/`approvalStatus` to
  `ShellToolOutput` (output schema, required list, preserveFields).
