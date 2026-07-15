# Shell Coverage

## Current Confidence

- Status: `Partially Verified`
- Last reviewed: 2026-07-11
- Evidence source: 2026-06-22 focused gates passed on
  `fix/promoted-shell-no-rollback`: shell-tool tests, shell-tool build, host
  tools tests, host config tests, schema check, agent-runtime tests, spawn-agent
  tests, external-command-agent tests, full build, and `check:dist-fresh`.
  Real mini promoted-shell canary also passed functionally and reported
  `UNTRACKED_WRITE_CAPABLE_BOUNDARY`. 2026-06-23 CLI outcome unit coverage
  verifies untracked write-capable boundaries are reported separately from
  managed writes. 2026-06-23 scripted invalid-args shell reproducer confirmed
  the trace terminality gap without relying on model variance; the post-fix
  rerun now records structured `TOOL_ARGUMENTS_INVALID` failure evidence and a
  terminal run event. 2026-07-02 real `openai/gpt-5.4-mini` fixture QA forced
  shell promotion with `shell.foregroundTimeoutMs: 300`; bash returned
  `promoted:true`, created `task_mr3fx4fdrq53skvu`, task output contained
  `PROMOTED_OK`, and trace/session checks passed. Real-provider shell usage
  remains environment/model-sensitive.
  2026-07-10 real `openai/gpt-5.4-nano` TUI QA verified explicit
  `background:true`, `lifetime:"service"`, `awaited:false`, continued README
  reads, and same-id deduplication. It also exposed creation/control confusion:
  the model used eager `task_create` instead of deferred `task`, then claimed a
  stop without `action:"stop"`. A 2026-07-11 `openai/gpt-5.6-terra` A/B run
  completed the same scenario both with and without the nano-specific guidance;
  the simplified version discovered deferred `task`, inspected output, and
  stopped with `cancelled:true`. The eager/control-prose patch was retired as a
  model-specific maintenance and schema-token cost.

## Covered

- 2026-07-15 real Sonnet same-session resume started `npm run dev` exactly once
  as an explicit background service, observed `READY inventory-heartbeat`, and
  stopped the same `task_mrlks7qe33taeoxt`. Trace recorded `task.cancelled`
  with exit 0 and `STOPPED` output, no managed file writes, and passing
  trace/session consistency. `UNTRACKED_WRITE_CAPABLE_BOUNDARY` remained the
  expected safety advisory.

- Shell tool construction requires `foregroundTimeoutMs`.
- `foregroundTimeoutMs` is the sole per-call foreground budget field; legacy
  `timeoutMs` is rejected by the closed input schema.
- Unsafe shell syntax and destructive commands are denied before execution.
- Workspace-relative `cwd` is anchored under the configured workspace root.
- Long foreground commands promote to background tasks when a `TaskManager` is
  available.
- Real mini can follow a promoted-shell task id and retrieve buffered output
  through the deferred `task` tool after `tool_search`.
- Long foreground commands fall back to abort plus `timedOut: true` when
  promotion is unavailable.
- Host shell mutation audits roll back unmanaged writes on non-promoted paths.
- Snapshot audit records symlink entries; focused tests cover created symlink
  cleanup and parent-directory symlink replacement without writing through to
  the external target.
- Configured delegate child shell tools can inherit workspace anchoring.

## Weak Or Untested

- Real-provider model behavior around when to call shell, task output, and final
  answer timing is not deterministic.
- A 45-second nano TUI harness can end before the model reaches stop even with a
  strong prompt. Treat that as a bounded-canary partial result unless trace
  shows a false terminal claim; use focused contract tests as the stable gate.
  Do not change global tool exposure solely to make that weak-model canary pass.
- Platform-specific sandbox evidence differs across macOS and Linux.
- Shared argv launch-decision tests deterministically cover unavailable
  warn/enforce behavior, but installed-runtime integration remains
  environment-sensitive and may exercise only the current OS backend.
- Read-only Workflow Script and local extension process execution is
  fail-closed when the platform sandbox is unavailable. The deterministic
  security-plan test covers compilation; successful real process launch remains
  platform/runtime-sensitive.
- `workspaceAccess:none` delegate tests cover protected workspace writes and
  preserved private-cwd scratch writes on the installed backend. Cross-OS
  confidence still requires the shell-sandbox compiler tests plus Linux CI and
  macOS integration evidence; one platform pass is not evidence for the other.
- Stale `dist` can make host/CLI tests miss shell-tool source behavior.
- Timing-sensitive timeout tests need tiny injected budgets and should avoid
  depending on wall-clock precision.
- External MCP tools with workspace `cwd` are disclosed but not counted as
  managed shell writes.
- Real promoted-shell file effects should still be checked in isolated fixtures;
  the unit coverage verifies the summary model, not filesystem survival.
- Real-model shell prompts can produce invalid legacy timeout aliases
  (`timeoutMs: 0`); use trace verification to distinguish model argument
  variance from missing runtime terminality.
- `--access-mode read-only --yes` still denies bash because the tool is
  classified as risky/write-capable. This is the expected policy boundary; bash
  behavior canaries should use write-enabled temporary fixtures unless the
  denial itself is under test.
- Scripted shell `timeoutMs: 0` is now covered by a regression route; keep it
  because it exercises synchronous policy/argument failures before shell
  execution starts.
- Noninteractive `accept-edits` shell verification requires an auto-approval
  flag such as `--yes`; without it, stdin denial is expected. With `--yes`,
  real mini completed a failing-test/fix/passing-test flow with auto-approved
  bash approvals.
- `node -e` snippets are treated as ad-hoc probe commands, not verification
  commands, even when the run goal is verification-like.

## Focused Route

```bash
npm --workspace @sparkwright/shell-tool test -- test/shell-tool.test.ts
npm --workspace @sparkwright/shell-tool run build
npm --workspace @sparkwright/shell-sandbox test
npm --workspace @sparkwright/shell-sandbox run build
npm --workspace @sparkwright/host test -- test/workspace-snapshot.test.ts test/tools.test.ts
```

Add CLI route checks for user-facing run outcomes:

```bash
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "shell"
npm --workspace @sparkwright/cli test -- test/run-outcome.test.ts
```

## Scenario Links

- [../scenarios/shell-foreground-timeout.yaml](../scenarios/shell-foreground-timeout.yaml)
- [../scenarios/capability-inspect-shell.yaml](../scenarios/capability-inspect-shell.yaml)

## Sensitivity Links

- [../matrices/capability-sensitivity.md](../matrices/capability-sensitivity.md)
- [../matrices/environment-sensitivity.md](../matrices/environment-sensitivity.md)
- [../matrices/model-sensitivity.md](../matrices/model-sensitivity.md)

## Stale Triggers

- `packages/shell-tool/src/*`
- `packages/host/src/shell.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/toolset.ts`
- shell config schema or default timeout changes
- TaskManager/task store changes that affect promotion

## Failure Links

- [../failures/shell-dist-skew.md](../failures/shell-dist-skew.md)
- [../failures/shell-cwd-anchor.md](../failures/shell-cwd-anchor.md)
- [../failures/promoted-shell-outcome-text.md](../failures/promoted-shell-outcome-text.md)
- [../failures/shell-invalid-args-terminality.md](../failures/shell-invalid-args-terminality.md)
- [../failures/node-e-probe-verification-misclassified.md](../failures/node-e-probe-verification-misclassified.md)
- [../failures/repeated-expected-denial-outcome.md](../failures/repeated-expected-denial-outcome.md)
