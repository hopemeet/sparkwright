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
- Core `createWorkspaceShellPolicy` and shell-tool path scope are intentionally
  not one fact source: the former validates structured embedder `command +
args` without rewriting requests, while the latter parses Host command text
  and normalizes execution cwd. They share workspace-relative cwd semantics,
  but command parsing stays shell-tool-owned.
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
- Foreground Host shell mutation audit uses `workspace-snapshot.ts` for
  snapshot/diff/rollback. It records regular files and symlinks, removes a
  created/replacement symlink before restoration, and routes captured binary
  writes through Core `LocalWorkspace` containment. It is still a whole-tree
  workspace audit, not protection for writes outside the workspace. MCP
  execution does not reuse this primitive: local stdio servers use their own
  transport lifecycle and a neutral cwd only avoids accidental relative-path
  project writes; it is not mutation detection or filesystem isolation.
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
- Host acquires a process-local workspace mutation lease only for Shell calls
  whose effective argument-level governance includes `write`. Foreground calls
  release after execution; explicit/promoted background calls transfer the same
  lease to the returned Task and release at terminal state. A lease-loss signal
  aborts/cancels the live task, but is not an OS fencing guarantee.
- Workflow P4 script processes reuse the host process/sandbox substrate rather
  than defining a second runner. `workflow-node-api.ts` maps script execution
  into `TracedProcessRunner.runJsonRpc()` with shell-sandbox policy inputs,
  stdout reserved for newline-delimited JSON-RPC, and stderr reserved for
  progress/telemetry. Script requests for governed command side effects go back
  through the host node API (`invoke(type:"command")`) instead of granting the
  script a raw shell capability.
- Workflow Script process writes require two independent grants: write-enabled
  run access and an explicit script `write` capability. Otherwise Host compiles
  a fail-closed no-write sandbox that denies the workspace. Command hooks do the
  same when the run explicitly records `shouldWrite:false`; legacy hook
  embedders with no access metadata keep their prior behavior.
- Host run security planning distinguishes the configured main-Shell sandbox
  status used by capability inspection from the effective extension-process
  sandbox. Read-only runs may strengthen the latter for MCP and Skill process
  launch without claiming that the configured Shell mode changed.
- `shell-sandbox` owns the shared argv launch decision
  (`sandboxed`/`unsandboxed` fallback/`unavailable`) and OS-specific resolved
  filesystem grant compilation. Host JSON-RPC, MCP stdio, Delegate, and Skill
  adapters keep separate I/O, timeout, trace, and cleanup lifecycles; this seam
  is not a general-purpose runner.
- ACP child workers also consume the shared launch decision, but keep ACP
  JSON-RPC/session/permission lifecycle in `acp-client-adapter`; they do not use
  Host shell parsing, shell mutation snapshots, or `TracedProcessRunner`.
- External-command and ACP write delegates hold the same workspace lease for
  their complete process/session window. Lease loss reaches their native abort
  path; raw processes use TERM then KILL escalation, and ACP cleanup waits for
  worker exit before its adapter releases the lease.
- ACP and external-command delegates with `workspaceAccess:none` force the
  sandbox launch decision to fail closed and protect the workspace from writes
  while keeping their private execution cwd writable. Linux enforces this with
  its positive bind scope; macOS needs explicit workspace lexical/realpath deny
  rules because its allow-default profile ignores positive filesystem grants.
  This is a workspace-write guarantee, not a claim that macOS becomes a full
  read/write allowlist.
- Sandbox `enforce` means fail closed when the selected runtime is unavailable;
  it does not imply workspace allowlisting. Linux bubblewrap reports
  `bind-allowlist`; macOS sandbox-exec uses an allow-default profile and reports
  `deny-list-guard`. Capability inspection must preserve that distinction.

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
- Date: 2026-07-15T07:26:47+0800
- Scope: P6 routed review; shell sandbox and mutation-window semantics are
  unchanged by the workspace lease import rename.
- Tests: Host shell/Agent/full suites passed.

- Status: Verified
- Date: 2026-07-14
- Scope: granted sandboxed stdio MCP servers only their generated neutral cwd
  as writable scratch; Linux still requires explicit read grants for runtime
  dependencies outside the configured workspace.
- Read: MCP adapter cwd lifecycle and shared shell-sandbox scope compiler.
- Tests: focused MCP adapter, CLI, ACP, and shell-sandbox suites; CI covers the
  real Linux bubblewrap runtime.

- Status: Verified
- Date: 2026-07-14
- Scope: fixed Linux bubblewrap launch when protected configuration paths
  overlap and when explicit read/write grants live beneath the private `/tmp`
  overlay; the private parent is read-only outside explicit writable grants,
  and missing secret paths no longer materialize in the host workspace.
- Read: shell-sandbox bubblewrap compiler and platform integration coverage.
- Tests: shell-sandbox 16/16 on Node 20 and Node 22; the CI matrix covers the
  Linux runtime.

- Status: Verified
- Date: 2026-07-14
- Scope: tied mutating foreground/background Shell and write-capable process
  delegates to Host workspace lease lifetimes, including loss-triggered process
  termination and ACP exit acknowledgement.
- Read: Host Shell catalog/wrapper, Task handoff, traced process runner,
  external-command adapter, and ACP worker.
- Tests: focused Shell/process/ACP suites, all workspace tests, and release
  smokes passed. Touched files are format-clean; the global format scan is
  blocked only by pre-existing dirty proposal docs outside this change.

- Status: Verified
- Date: 2026-07-14
- Scope: closed the macOS delegate positive-scope gap and warn-mode fallback for
  `workspaceAccess:none` without removing private scratch writes.
- Read: shell-sandbox protected-root compiler and Host ACP/external delegate
  launch assembly.
- Tests: shell-sandbox plus Host ACP/external focused suites 40/40.

- Status: Verified
- Date: 2026-07-13T22:42:00+0800
- Scope: source review rejected a forced Core/shell-tool policy merge and fixed
  the actual Core relative-cwd anchor drift.
- Read: Core environment policy/tests and shell-tool path parsing/scope tests.
- Tests: Core environment/policy 35/35; shell-tool 42/42; no shell-tool behavior
  changed.

- Status: Verified
- Date: 2026-07-13T22:30:00+0800
- Scope: hardened foreground snapshot rollback against symlink replacement and
  aligned schema/user wording with the backend-specific filesystem guarantee.
- Read: Host Shell/snapshot/config, Core LocalWorkspace, shell-sandbox profile
  compiler/status, configuration guide, and focused tests.
- Tests: Host config/snapshot/tools 161/161; Core workspace/checkpoint 31/31;
  shell-sandbox 14/14; schema check; affected typechecks/builds passed.

- Status: Verified
- Date: 2026-07-13T22:21:00+0800
- Scope: read-only MCP/Skill adapter inputs, Workflow Scripts, and explicit
  run-bound command hooks now use fail-closed no-write sandbox compilation;
  their distinct process lifecycles remain intact.
- Read: Host security plan, Workflow node API/hooks, runtime assembly, and
  shell-sandbox no-write compiler.
- Tests: Host focused 263/263; MCP adapter 34/34; CLI inspect 11/11.

- Status: Verified
- Date: 2026-07-13
- Scope: added configured sandbox launch to ACP child workers while preserving
  their distinct protocol lifecycle and workspaceAccess gate.
- Read: Host ACP delegate, ACP client worker, and shell-sandbox compiler.
- Tests: ACP adapter 2/2 and Host ACP/external/tool suites 122/122.

- Status: Verified
- Date: 2026-07-13
- Scope: unified argv sandbox fallback decisions and filesystem grant
  compilation across Host JSON-RPC, MCP stdio, external Delegate isolation,
  and Skill inline no-write execution.
- Read: shell-sandbox, Host process/Delegate/Skill adapters, and MCP adapter.
- Tests: shell-sandbox 14/14; Host focused process tests 37/37; MCP 34/34;
  affected typechecks passed.

- Status: Verified
- Date: 2026-07-13
- Scope: corrected the execution-boundary map after source review: workspace
  snapshot/diff/rollback belongs to foreground Host shell and is not reused by
  MCP stdio transport.
- Read: `packages/host/src/shell.ts`,
  `packages/host/src/workspace-snapshot.ts`, and
  `packages/mcp-adapter/src/index.ts`.
- Tests: documentation correction supported by source inspection; Core
  workspace/checkpoint/policy tests 59/59 passed for the behavior changed in
  this stage.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked Workflow v2 package source path; shell policy is unchanged.
- Tests: focused Workflow tests passed; release gate pending.

- Status: Read-only
- Date: 2026-07-12T16:36:08+0800
- Scope: checked snapshot-backed Workflow script source resolution; shell policy is unchanged.
- Tests: not run for shell-policy-specific behavior; Phase 4 Workflow release gate passed.

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
