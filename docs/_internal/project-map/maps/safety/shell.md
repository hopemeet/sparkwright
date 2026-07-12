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
  -> output or shell.background task
  -> background task adopts live shell stream via TracedProcessRunner
  -> trace + task state
```

## Contracts

- Shell is a normal tool and must not bypass core policy or trace.
- Shell `previewArgs()` only formats `tool.requested.payload.preview` for UI
  display; safety classification, path-scope checks, policy, and approval still
  use the parsed command arguments at execution/gating time.
- Unsafe shell commands require approval according to configured policy.
- A returned shell result describes _post-execution_ reality, not the
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
- Shell mutation audit excludes SparkWright runtime control-plane state such as
  `.sparkwright/sessions/` and `.sparkwright/workflow-runs/` so host-owned
  session traces and durable workflow state are not reported as model shell
  mutations.
- Configured in-process delegates can select `shell`, but shell remains gated
  by the parent run's write-enabled policy; capability descriptors should mark
  this with `gatedByRunWrite` rather than attempting command-specific read-only
  downgrades.
- The core repeated-tool guard keys shell retries by command plus cwd, ignoring
  incidental execution fields such as `timeoutMs`, so a model cannot bypass the
  loop guard by varying timeout-only arguments.
- Long-running shell uses one foreground budget. `foregroundTimeoutMs` defaults
  to 300000 ms and is capped at 600000 ms. It is the only accepted per-call
  timeout field; legacy `timeoutMs` is rejected by the closed tool schema and
  no longer has a runtime alias. Tool output reports `foregroundTimeoutMs` and
  `promotionAvailable`.
- Invalid shell execution arguments discovered during shell input
  normalization are surfaced through the normal core tool lifecycle as
  `tool.failed` (`TOOL_ARGUMENTS_INVALID`) instead of escaping before the shell
  span closes. Unknown legacy fields fail closed during schema validation.
- When the foreground budget expires, hosts with a task manager promote the live
  process to durable task state. Hosts without promotion abort the process and
  return `timedOut: true` with a diagnostic saying promotion was unavailable.
- `background:true` is a direct background handoff after core policy/approval,
  not a zero-millisecond foreground timeout. It returns
  `backgroundOrigin:"explicit"`, creates an `awaited:false` task, and never
  reports `promoted:true`. Timeout handoff reports origin `promoted` and remains
  awaited.
- The shared handoff callback is `onBackground`; deprecated `onPromote` remains
  source-compatible for embedders. New task records use `shell.background`;
  active historical `shell.promoted` records remain eligible for deduplication.
- Shell-tool resolves `policy:{ awaited, lifetime }` at the handoff boundary.
  Hosts execute it directly; `origin` remains diagnostic provenance rather than
  an independent keep-alive decision point.
- Explicit background shell calls support `lifetime:"job"|"service"` (job
  default). Every finite command remains a job even when it runs for minutes or
  hours; service is reserved for indefinite servers, watchers, and endless
  loops. Service v1 only requires survival through an internal 1000ms startup
  grace window; it has no port/output/health probe. Equivalent active explicit
  tasks deduplicate before process spawn by normalized command + canonical cwd
  - lifetime within the parent run.
- Background handoff observations return the concrete task id and early output
  as launch confirmation. They explicitly discourage `task get` merely to
  reconfirm launch; the advanced deferred `task` schema is loaded only when a
  wait, incremental output read, or stop is actually needed.
- Shell promotion is also governed by the resolved run `backgroundTasks`
  policy. `enabled` allows promotion, `foreground-only` keeps foreground shell
  behavior without promotion, and `disabled` reports promotion unavailable even
  when a task manager exists.
- Background shell tasks keep `task.*` as their trace lifecycle; stdout/stderr are
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
- Date: 2026-07-11T22:10:00+0800
- Scope: removed the legacy per-call timeout alias from public input/output and
  runtime normalization; `foregroundTimeoutMs` is now the sole contract.
- Read: `packages/shell-tool/src/tool.ts`, focused tests.
- Tests: full `npm run release:check`.

- Status: Verified
- Date: 2026-07-11T21:45:00+0800
- Scope: hid the legacy timeout alias from model schema, strengthened finite
  job vs indefinite service guidance, and removed redundant launch polling.
- Read: `packages/shell-tool/src/tool.ts`,
  `packages/shell-tool/test/shell-tool.test.ts`.
- Tests: `npm exec -- vitest run packages/shell-tool/test/shell-tool.test.ts`.

- Status: Verified
- Date: 2026-07-11T00:19:00+0800
- Scope: restored concise background task guidance and advanced/deferred task
  control after a same-prompt Terra A/B showed the nano-specific eager/prose
  compensation was unnecessary.
- Read: `packages/shell-tool/src/tool.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/host/src/tool-identities.ts`, focused tests.
- Tests: shell-tool, agent-runtime, host, and CLI focused gates; real
  `openai/gpt-5.6-terra` CLI traces; `npm run release:check`.

- Status: Verified
- Date: 2026-07-10T23:00:00+0800
- Scope: explicit shell background is distinct from timeout promotion; approval
  precedes detach, explicit work is non-awaited, service startup uses a bounded
  grace window, and equivalent active commands deduplicate before spawn.
- Read: `packages/shell-tool/src/tool.ts`, `packages/host/src/shell.ts`,
  `packages/shell-tool/test/shell-tool.test.ts`, `packages/host/test/tools.test.ts`.
- Tests: focused shell-tool and host shell suites; package typechecks.

- Status: Read-only
- Date: 2026-07-07T00:55:52+0800
- Scope: workflow observation now ignores failed or hook-blocked tool attempts
  when producing offline distill/shadow reports. Shell execution, command
  parsing, sandboxing, promotion, approval, and shell trace lifecycle contracts
  are unchanged.
- Read: `packages/host/src/workflow-trace-observation.ts`,
  `packages/host/src/workflow-distill.ts`,
  `packages/host/src/workflow-shadow.ts`,
  `docs/_internal/project-map/maps/safety/shell.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-shadow.test.ts test/workflow-distill.test.ts`; shell-specific
  tests were not run because no shell runner or policy code changed.

- Status: Verified
- Date: 2026-07-05T23:09:50+0800
- Scope: workflow-runtime-v1 P9a D5 safety boundary: workspace mutation audit
  now excludes workspace `.sparkwright/workflow-runs/` alongside session
  runtime state. Shell execution, classification, approval, sandbox clamps, and
  process runners were not changed.
- Read: `packages/host/src/workspace-snapshot.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"runtime control-plane files"`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Read-only
- Date: 2026-07-05T22:20:59+0800
- Scope: workflow-runtime-v1 P8a routed-page check: offline `workflow shadow`
  compares historical shell command strings against workflow declarations but
  does not execute shell, classify commands, request approvals, change
  sandbox/access clamps, or add a shell runner.
- Read: `packages/host/src/workflow-shadow.ts`,
  `packages/host/src/workflow-trace-observation.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflow-shadow.test.ts`.
- Tests: not run for live shell behavior; P8a made no shell execution semantic
  change. Focused shadow gates passed in host/CLI.

- Status: Read-only
- Date: 2026-07-05T20:18:29+0800
- Scope: workflow-runtime-v1 P5 post-review routed-page check: branch
  validation and delegate_parallel infra-error handling changed host workflow
  projection only. Parallel command/script branches still reuse existing command
  hook execution, `workflow-node-api.ts`, `TracedProcessRunner`,
  shell-sandbox clamps, and run write gates; no shell runner, sandbox tier, or
  direct script capability path was added.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/host/src/workflow-node-api.ts`,
  `packages/host/src/traced-process-runner.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts -t "parallel|join|delegate_parallel|branch
diagnostics"`; `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-hooks.test.ts`.

- Status: Read-only
- Date: 2026-07-05T18:02:15+0800
- Scope: workflow-runtime-v1 P5 routed-page check: parallel command/script
  branches reuse existing command hook execution, `workflow-node-api.ts`,
  `TracedProcessRunner`, shell-sandbox clamps, and run write gates. P5 adds no
  new shell runner, sandbox tier, or direct script capability path.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/host/src/workflow-node-api.ts`,
  `packages/host/src/traced-process-runner.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
-t "parallel|join|delegate_parallel"`; `npm --workspace @sparkwright/host
test -- test/workflows.test.ts test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

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
