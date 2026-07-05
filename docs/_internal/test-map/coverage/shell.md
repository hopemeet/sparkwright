# Shell Coverage

## Current Confidence

- Status: `Partially Verified`
- Last reviewed: 2026-07-02
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

## Covered

- Shell tool construction requires `foregroundTimeoutMs`.
- `timeoutMs` is treated as an observable foreground-timeout alias.
- Unsafe shell syntax and destructive commands are denied before execution.
- Workspace-relative `cwd` is anchored under the configured workspace root.
- Long foreground commands promote to background tasks when a `TaskManager` is
  available.
- Real mini can follow a promoted-shell task id and retrieve buffered output
  through the deferred `task` tool after `tool_search`.
- Long foreground commands fall back to abort plus `timedOut: true` when
  promotion is unavailable.
- Host shell mutation audits roll back unmanaged writes on non-promoted paths.
- Configured delegate child shell tools can inherit workspace anchoring.

## Weak Or Untested

- Real-provider model behavior around when to call shell, task output, and final
  answer timing is not deterministic.
- Platform-specific sandbox evidence differs across macOS and Linux.
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
npm --workspace @sparkwright/host test -- test/tools.test.ts
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
