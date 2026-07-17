# Agents And Delegates Coverage

## Current Confidence

- Status: `Partially Verified`
- Last reviewed: 2026-07-17
- Evidence source: 2026-06-22 focused host/agent tests passed and real
  `openai/gpt-5.4-mini` read-only dynamic `spawn_agent` canaries produced valid
  trace/session structure. A configured read/write delegate canary wrote through
  parent approval and parent verification. 2026-06-23 follow-up covered direct
  external-command `delegates run`, direct `maxDepth`, scripted configured
  delegate parent read-after-write verification, real
  `openai/gpt-5.4-nano` configured delegate write/verify, and external
  read-write workspace boundary denial/disclosure. 2026-06-25 multi-surface QA
  covered user CLI `agents create`, TUI `/capabilities`, real model
  `create_agent`, real model use of the created delegate, read-only dynamic
  `spawn_agent`, and direct external-command `delegates run`. 2026-06-25 fix
  verification covered parent/child sub-agent metadata attribution across
  agent-runtime, host ACP/external delegates, direct CLI delegate JSON output,
  persisted trace summaries, and TUI sub-agent labels.
  2026-06-25 follow-up covered model-facing explicit `create_agent`
  `update`/`replace` semantics and added a reusable real
  `openai/gpt-5.4-mini` regression script for model-created agent plus
  delegated read-only use. 2026-07-01 background-task QA covered
  `task_create(kind:"agent")` schema exposure, deterministic background-agent
  task execution, and a post-fix real mini task that completed through
  `runHostAgentTask()`. 2026-07-02 real mini background-code QA confirmed an
  awaited background `agent` task can complete, inject a notification, and be
  monitored through `task(action:"wait")` plus `task(action:"output")`.
  Later 2026-07-02 fix verification covered action-specific `task` schema,
  semantic validation for empty monitor placeholders, recovered trace outcome
  classification, and a clean real mini rerun using concrete task ids.
  2026-07-07 real Sonnet QA covered skill-managed agent creation, indexed
  delegation, legacy Skill + dynamic spawn, Anthropic deferred `task` schema
  compatibility, nested background-agent opt-in parsing, `task wait`
  completion semantics, and nested awaited `task_create(kind:"agent")`
  result delivery. The 2026-07-11 closure audit treated that nested run as QA
  evidence rather than a user requirement and removed the incomplete opt-in;
  current v1 lifecycle is flat. 2026-07-14 deterministic verification covered
  argument-level Agent concurrency admission, exact delegation fingerprints,
  and same-millisecond ACP/external child-id uniqueness across Core,
  agent-runtime, and Host focused suites. 2026-07-17 focused verification
  removed the external-command aggregate truncation alias while preserving
  stream-specific tool/trace results and direct CLI execution. A later
  2026-07-17 pass removed the ACP/external-command tool-result `agentId`
  profile alias while retaining canonical `agentProfileId` and lifecycle actor
  attribution.

## Covered

- 2026-07-17 ACP/external-command result identity coverage rejects the removed
  top-level `agentId` alias on both success paths and external nonzero-exit
  metadata, while locking canonical `agentProfileId` and unchanged lifecycle
  actor/child identity.
- 2026-07-17 external-command delegate result coverage locks stream-specific
  `stdoutTruncated` / `stderrTruncated` fields on both the tool result and
  `subagent.completed`, and rejects the removed aggregate compatibility alias.
- 2026-07-17 canonical exposure verification removed the global
  `exposeChildrenAsDelegates` path. Generic targets remain indexed, direct
  aliases use `exposure` / pins / per-profile opt-in, and explicit aliases stay
  available to the user-selected `delegates run` entrypoint.
- 2026-07-15 tool-decision audit physically applied main/child Profile allow
  and deny after upstream catalog admission, normalized exact built-in aliases,
  and retained MCP wildcard matching. A real restricted main Profile exposed
  only `read`/`grep`; session `session_mrlmpwmud4y4ghev` used one read with no
  failures, approvals, or writes, and its trace tool plan contained only those
  two admitted tools.
- 2026-07-15 independent follow-up unified main, configured child, parallel
  delegate, and dynamic-spawn Profile admission. A failure-first test proved
  that merely retaining upstream `tool_search` leaked denied deferred
  descriptors; all filtered paths now rebuild discovery over retained tools.
  Real session `session_mrlx0rjs943j3rgy` confirmed the denied descriptor was
  absent from both search results.

- Real `openai/gpt-5.6-terra` foreground-only governance QA verified a denied
  explicit background shell can recover, `task_create(mode:"background")` is
  forced to `mode:"foreground"` with no promotion, and a multi-second
  `spawn_agent` remains inline. Trace verify/session check were clean on the
  valid child rerun.
- Child agents cannot receive `task_create` or call dynamic `spawn_agent` again
  in v1. Focused tests reject the removed `allowNestedBackgroundTasks` config
  and reject a dynamic spawn whose parent is already a sub-agent.
- Model-facing `task_create` scheduling is covered through canonical `mode`
  values only. Focused Agent Runtime coverage rejects the removed `awaited`
  input field while preserving durable/result `awaited` state for revival and
  Activity Drawer consumers.

- Dynamic `spawn_agent` children emit parent-visible sub-agent lifecycle events.
- Configured in-process delegates can write through the parent approval path.
- Configured in-process delegates can run shell through the parent approval
  path when their child tool catalog allows it.
- External-command delegates mirror sub-agent lifecycle and summarize progress.
- Sub-agent depth metadata is available to trace and TUI consumers.
- Delegate descriptors appear in capability inspect output and TUI capability
  panels.
- Direct `delegates run` external-command entrypoint emits approval and
  subagent lifecycle events, writes a session trace, and honors `maxDepth`.
- Configured in-process delegates can write through the parent approval path and
  the parent can verify after `subagent.completed` with a later `read_file`.
- ACP and external-command delegates with `workspaceAccess: read_write` disclose
  untracked write-capable boundaries; without parent `--write`, they fail before
  process execution and are counted as expected denials.
- ACP and external-command delegates with `workspaceAccess: none` keep a private
  cwd writable but fail closed when sandboxing is unavailable and cannot write
  a known absolute workspace path. Installed-runtime tests exercise the current
  OS backend; shell-sandbox unit coverage checks both Linux and macOS compilation.
- CLI `agents create` can create a project-local child profile with a callable
  in-process delegate, and `capabilities inspect` / TUI `/capabilities` surface
  the configured agent and delegate.
- Real `openai/gpt-5.4-nano` can create an agent profile through
  `tool_search` -> `create_agent`, then a later run can call the resulting
  delegate tool.
- A strongly prompted real `openai/gpt-5.4-nano` dynamic `spawn_agent` run can
  complete read-only with one child read and clean trace/session diagnostics.
- Parent-visible `subagent.*` metadata now uses parent `agentId` plus
  inherited `sessionId` and `childAgentId` / `agentProfileId`; direct
  external-command `delegates run` JSON output and persisted `trace.jsonl`
  agree on that shape.
- Trace summary exposes child/delegate identities through `subagentIds` /
  `subagents` separately from persisted actor `agentIds` / `agents`.
- Equivalent `create_agent` requests are idempotent even for legacy/direct
  `force:true` callers, and the model-facing schema no longer advertises
  `force`.
- `create_agent action:"update"` patches an existing profile and can sync or
  remove its delegate tool; `action:"replace"` requires `replaceReason`, writes
  a full replacement profile, and removes stale delegates for that profile.
- Legacy/direct `force:true` with a different existing profile is still accepted
  for compatibility, but is recorded as an explicit replacement mutation and
  clears stale delegates.
- `npm run regression:real-agents` verifies a real mini model can create a
  project-local agent/delegate through `tool_search` -> `create_agent`, then a
  later run can call that delegate with clean trace/session attribution.
  The create case asserts `tool_search` appears before `create_agent` so tool
  discovery regressions do not pass merely because the model guessed the hidden
  tool name.
- 2026-06-28 P0/P1 follow-up reran host/CLI focused gates for dynamic
  `spawn_agent`, indexed `delegate_agent`, `delegate_parallel`, write-capable
  delegate rejection, and configured delegate parent approval paths.
- Agent profile manager writes preserve `capabilities.agents.maxDepth` while
  mutating profiles/delegates.
- 2026-06-27 real `openai/gpt-5.4-mini` surface QA verified model-created
  agent creation/delegation, CLI-created config profiles, project markdown
  profiles with inline delegate tools and routing keywords, TUI capability
  visibility, dynamic `spawn_agent`, and successful `delegate_parallel` runtime
  fan-out. Trace verify and session check passed for all completed real-model
  runs in [../runs/2026-06-27-agent-real-mini-surface-qa.md](../runs/2026-06-27-agent-real-mini-surface-qa.md).
- 2026-06-27 deterministic fix verification added a shared parent-run
  delegation ledger across normal configured delegate calls,
  `delegate_parallel`, and dynamic `spawn_agent`. Focused host tests assert
  single-to-parallel and parallel-to-single reuse plus dynamic spawn same-scope
  reuse without re-running the child model. A post-fix real
  `openai/gpt-5.4-mini` rerun reproduced the model's single-delegate-first
  behavior, then `delegate_parallel` returned both child results with
  `alreadyCompleted: true`; the trace had two `subagent.completed` events
  instead of four and passed trace verify/session check
  (`session_mqvxzwjy7x1ixlvu`).
- 2026-07-14 hardening narrowed that ledger to exact conservative normalized
  goal fingerprints, with regression coverage proving `packages/host` directory
  results are not reused for `packages/core`. Core now serializes tools that
  declare dynamic policy without an explicit argument-level classifier;
  dynamic read-only spawn remains concurrent, while write-granted, configured
  write/shell, approval-bound, invalid, and unresolved Agent calls are serial.
  ACP/external adapters also mint distinct child ids under a frozen timestamp.
- 2026-07-14 lifecycle characterization projects stable identity, entrypoint,
  phase ordering, and terminal cardinality across configured direct/indexed/
  parallel delegates, dynamic promotion/cancellation, background Agent tasks,
  ACP, external-command, and direct CLI delegation. It deliberately leaves
  timestamps, sequence, spans, prose, and adapter result bodies out of the
  golden shape. Known adapter differences remain visible: ACP/external start
  before access admission and omit successful `terminalState`; indexed
  delegation currently reports the hidden direct `delegate` entrypoint.
- 2026-06-27 indexed delegation verification covered the new default agent
  exposure surface: capability snapshots expose `delegate_agent` instead of
  every configured `delegate_*` alias, `delegate_agent(agentId)` preserves
  target policy/approval and child write/shell behavior through the hidden
  configured delegate tool, `delegate_parallel` accepts `agentId` targets, and
  direct reserved-name collisions only apply when aliases are exposed via
  `exposure: "all"` / pins / `exposeAsDelegate`.
- 2026-06-27 real `openai/gpt-5.4-mini` indexed delegation QA verified that
  hidden named delegates are no longer model-facing, generic target parsing
  selects delegates by canonical `agentId`, `delegate_parallel`
  completes after prior `delegate_agent` calls by reusing ledger results, and
  trace/session checks pass with no duplicate sub-agent spawns. See
  [../runs/2026-06-27-indexed-agent-real-mini-qa.md](../runs/2026-06-27-indexed-agent-real-mini-qa.md).
- 2026-06-28 real `openai/gpt-5.4-mini` agent canary created a
  `mini_reviewer` profile/delegate, then delegated through the indexed
  `delegate_agent(agentId:"mini_reviewer")` route with separated parent/child
  attribution and passing trace verify/session check. The runtime path was
  healthy; `npm run regression:real-agents` failed only because the script
  still required a direct `delegate_mini_reviewer` tool request. See
  [../failures/real-regression-stale-capability-semantics.md](../failures/real-regression-stale-capability-semantics.md).
- 2026-06-28 fix verification updated `regression:real-agents` to assert the
  default indexed `delegate_agent(agentId)` route. The real mini rerun passed
  agent creation and delegation with separated parent/child attribution.
- 2026-06-28 broad real `openai/gpt-5.4-mini` QA exposed a main tool surface
  with `workspace.read`, `workspace.write`, `agents`, `shell`, and `planning`,
  then verified a strong prompt could call `spawn_agent` and
  `delegate_parallel` in the same first tool batch. The trace had 4 runs
  (`main`, `dynamic_context_reader`, `api_reviewer`, `test_reviewer`), 0 tool
  failures, 0 approvals, 0 workspace writes, and passing trace/session checks.
  See [../runs/2026-06-28-agent-real-mini-broad-qa.md](../runs/2026-06-28-agent-real-mini-broad-qa.md).
- 2026-06-29 scripted delegate long-chain QA verified
  `delegate_agent` followed by `delegate_parallel` reused the shared delegation
  ledger (`alreadyCompleted:true`) and passed trace/session checks. A
  deterministic demo-adapter diagnostic defect was fixed separately: shared
  deterministic child-scope adapters now report the active child `run.goal` and
  keep turn state per run id.
- 2026-07-01 focused background-agent task fix verification asserts that the
  host main catalog exposes eager `task_create` with `kind` enum `["agent"]`,
  requires top-level `payload`, and requires `payload.goal`, `payload.role`, and
  `payload.prompt`. Deterministic host protocol coverage starts a background
  child agent through the real `task_create` tool, and a post-fix real
  `openai/gpt-5.4-mini` rerun produced a completed durable task
  (`task_mr1lz3bphpeg925k`) and `subagent.completed` for
  `dynamic_repo-inspector`.
- 2026-07-02 real `openai/gpt-5.4-mini` background task communication QA
  created `task_mr31lao7rmsc3cet` with `task_create(kind:"agent",
  mode:"awaited")`; the durable task completed with child run
  `run_mr31laobkmjlpkys`, `subagent.completed`, and a later successful
  `task(action:"wait")` plus `task(action:"output")`.
- 2026-07-02 task action fix verification added deterministic coverage for
  action-specific deferred `task` schema and runtime `validateInput()`, then a
  real `openai/gpt-5.4-mini` rerun used concrete `task_mr39dm012zmcqavi` for
  `task(action:"wait")` and `task(action:"output")` with 0 tool failures. See
  [../runs/2026-07-02-task-action-empty-id-fix-verification.md](../runs/2026-07-02-task-action-empty-id-fix-verification.md).
- 2026-07-02 real `openai/gpt-5.4-mini` background agent + bash canary created
  awaited task `task_mr3fv85gp3mwdlrd`, waited with the concrete id, completed
  child run `run_mr3fv85l73fj98oy` with `finality:"complete"`, and injected one
  task notification even though an unrelated parent `bash` call was denied by
  read-only policy. See
  [../runs/2026-07-02-real-mini-bg-agent-bash-shell-qa.md](../runs/2026-07-02-real-mini-bg-agent-bash-shell-qa.md).
- 2026-07-03 current-source real `openai/gpt-5.4-mini` QA reran
  `regression:real-agents` successfully and added a manual awaited background
  `agent` task canary after the actor-inbox/task-notification changes. The
  manual run created `task_mr4he6sq5yvcsfsq`, waited with the concrete id,
  completed child run `run_mr4he6ssn6cqo4mq` with `finality:"complete"`,
  injected one notification, persisted durable output containing
  `BG_AGENT_CURRENT_SENTINEL`, and passed trace verify/session check. See
  [../runs/2026-07-03-real-mini-background-skill-agent-qa.md](../runs/2026-07-03-real-mini-background-skill-agent-qa.md).
- 2026-07-03 follow-up real mini task QA verified resumed runs can recover
  older durable background-agent tasks without knowing their ids: the resumed
  run used `task(action:"list", scope:"all", kind:"agent",
  status:"completed")`, found task `task_mr4tyr00d2njwhc5`, answered with
  `TASK_SCOPE_SENTINEL_ALPHA`, and passed trace report/verify/session check.
  Deterministic coverage also asserts default list scope remains current-run
  and `task_create` describes the default active `agent=1` concurrency cap. See
  [../failures/task-list-resume-run-scope.md](../failures/task-list-resume-run-scope.md).
- 2026-07-03 current-source real `openai/gpt-5.4-mini` combined Skill +
  background-agent QA verified that a project Skill can be loaded before an
  awaited `task_create(kind:"agent")`, the model can wait on the concrete task
  id, `run.notification.injected` fires once, durable output carries both
  fixture sentinels, and explicit `payload.maxSteps:4` yields
  `subagent.completed` with `finality:"complete"` plus clean trace
  report/verify/session check. See
  [../runs/2026-07-03-real-mini-skill-background-agent-maxsteps.md](../runs/2026-07-03-real-mini-skill-background-agent-maxsteps.md).
- 2026-07-04 fix verification aligned `task_create(kind:"agent")` `maxSteps`
  schema guidance with dynamic `spawn_agent`, then reran the same real mini
  Skill + background-agent fixture without explicitly requesting `maxSteps`.
  Mini selected `payload.maxSteps:4`, child finality was complete, durable
  output contained both sentinels, and trace report/verify/session check all
  passed. See
  [../failures/task-create-agent-maxsteps-underallocation.md](../failures/task-create-agent-maxsteps-underallocation.md).
- 2026-07-07 real `anthropic/claude-sonnet-4-6`
  `regression:real-agents` passed: Sonnet created a callable
  `mini_reviewer` profile through `tool_search,create_agent`, then used the
  default indexed `delegate_agent(agentId:"mini_reviewer")` route with
  separated parent/child attribution and clean trace/session checks. See
  [../runs/2026-07-07-real-sonnet-skill-agent-qa.md](../runs/2026-07-07-real-sonnet-skill-agent-qa.md).
- 2026-07-07 real Sonnet legacy Skill + `spawn_agent` fixture passed with
  `skill_load` body/reference loads, one dynamic child
  `dynamic_sentinel-checker`, child `glob`/`grep`, `subagent.completed`
  `finality:"complete"`, zero writes, zero approvals, and clean trace
  report/verify/session check.
- 2026-07-07 fix verification flattened the built-in deferred `task` schema so
  real Anthropic no longer rejects it after `tool_search`. A Sonnet smoke run
  loaded `task`, called `task(action:"list", scope:"all")`, and passed trace
  report with no findings. Deterministic coverage asserts the model-facing
  schema has no top-level `oneOf` / `anyOf` / `allOf` while runtime
  `validateInput()` still enforces action-specific ids.
- 2026-07-07 nested background-agent fix verification covered
  `capabilities.agents.allowNestedBackgroundTasks` parsing, CLI `agents create`
  preservation of sibling runtime options, `task(action:"wait")` terminal-only
  complete semantics, and a real Sonnet nested run where child
  `task_create(mode:"awaited", kind:"agent")` returned the completed task
  record/result to the child. Trace report and trace verify passed with no
  findings.
- 2026-07-07 fix verification added a host built-in Stop hook that advances
  once when a final answer omits disclosure of partial/truncated/step-limited or
  failed child finality. Focused host coverage asserts the hook triggers on
  `subagent.completed` step-limit evidence, passes when the answer already
  caveats partial child results, and ignores ordinary truncated non-agent tool
  output.
- 2026-07-07 real `openai/gpt-5.4-mini` Agent + Skill multidirection QA
  covered current-source Skill-loaded dynamic `spawn_agent`, Skill-loaded
  configured indexed `delegate_agent(agentId:"static_reader")`, Skill-loaded
  awaited `task_create(kind:"agent")`, dynamic child write-boundary safety, and
  both reusable real agent/Skill regressions. Dynamic spawn and configured
  delegate traces completed with child finality `complete`, zero writes, and
  clean trace report/verify/session checks. The write-boundary route prevented
  writes but correctly reported child `finality:"partial"` / `step_limit`; the
  parent final prose did not relay that warning. See
  [../runs/2026-07-07-real-mini-agent-skill-multidirection-qa.md](../runs/2026-07-07-real-mini-agent-skill-multidirection-qa.md).
- 2026-07-07 root-cause fix for the real mini awaited Agent + Skill run:
  detached/promoted `task_create` results now carry concrete `nextAction`
  guidance (`taskId`, `task` action, output retrieval hint, duplicate-avoidance
  text), and host task notifications include `Result summary: ...` in
  model-visible body text. Focused agent-runtime/host tests, typecheck, builds,
  and `check:dist-fresh` passed. See
  [../failures/task-create-agent-low-signal-result-feedback.md](../failures/task-create-agent-low-signal-result-feedback.md).

- 2026-07-15 root fix after real mini Markdown Agent authoring exposed a
  callability gap:
  `create_agent` accepted and persisted `model: "default"`, rediscovery reported
  the Agent as callable, but both real and scripted `delegate_agent` calls
  failed because model refs must be `provider/model`. Removing only that field
  restored parent-model inheritance and produced a clean two-run child trace.
  Shared model-ref syntax, actual layered-config resolution before write,
  explicit authoring inheritance aliases that normalize to omission, config
  validation, and fail-closed Markdown discovery now cover the root invariant.
  Focused Host suites passed. Keep the corrected create/delegate flow in the
  real Agent rotation; see
  [../runs/2026-07-15-real-model-broad-code-qa.md](../runs/2026-07-15-real-model-broad-code-qa.md).
  Post-fix real mini create `session_mrlgk00tz82eptt0` and delegated child
  `session_mrlgk7y8p7t3jmxo` both passed; the latter contained 2 completed runs,
  one child read, correct `main` / `mini_reviewer` attribution, and no failures.

## Weak Or Untested

- Real-model delegation decisions are prompt- and model-sensitive.
- Multiple similar delegate calls in one batch can make event pairing and
  repeated-delegate diagnosis harder.
- ACP has a deterministic fixture route covering protocol completion, env
  inheritance, parent write denial, read-write untracked audit, and enforce-mode
  sandbox unavailability. Real external ACP binaries remain environment- and
  installation-sensitive.
- Dynamic `spawn_agent` is read-only by contract; child-write scenarios must use
  configured delegates rather than dynamic spawn.
- Real configured delegates can recover from repeated identical tool calls; keep
  prompt/model-sensitive assertions separate from trace invariants.
- Real mini delegate runs may include harmless parent-side reads before/after
  the delegate call; stable real-model assertions should avoid exact tool order
  unless the harness forces it.
- Real mini may not choose `delegate_parallel` first even under a strongly
  worded prompt; the runtime fan-out path can still be verified by trace
  evidence when it is eventually called, but exact parallel-tool selection is a
  prompt/model-sensitive assertion. The shared ledger now prevents the runtime
  from re-spawning already completed equivalent child work once the redundant
  route has happened; it does not itself force the model to choose
  `delegate_parallel` first.
- Real mini background-agent task monitoring remains weak as of 2026-07-01:
  after a valid `task_create(kind:"agent")` and completed durable task, the
  parent model can still repeat `task_create` instead of monitoring the
  returned task id with `task(action=get|output)`. Keep this separate from the
  fixed task_create kind/payload schema issue. See
  [../runs/2026-07-01-real-mini-background-task-qa.md](../runs/2026-07-01-real-mini-background-task-qa.md),
  [../failures/task-create-agent-kind-payload-contract.md](../failures/task-create-agent-kind-payload-contract.md),
  and [../failures/prompt-induced-tool-loop.md](../failures/prompt-induced-tool-loop.md).
- Pre-fix 2026-07-07 current-source Skill + awaited background-agent rerun
  reproduced the same family under a stronger "exactly one" prompt: the parent
  created three equivalent awaited agent tasks after recovering a wrong Skill
  reference path. The children completed useful read-only work. Post-fix,
  diagnose any recurrence by first checking whether `task_create.nextAction`
  and notification body result summaries reached the prompt.
- Parent final prose can omit a `spawn_agent` partial/finality warning even
  when `tool.completed spawn_agent` and `trace report` clearly flag child
  `step_limit`. Assertions for child write-boundary canaries should inspect
  `subagent.completed.finality` and trace report, not prose alone.
- Real mini can still make prompt-sensitive choices around when to monitor a
  task, but empty-id `task wait` / `task output` placeholders are now guided by
  action-specific schema, rejected by semantic validation, and recovered in
  diagnostics after later concrete same-action monitoring. Keep the real mini
  canary in rotation. See
  [../failures/task-action-empty-id-recovery.md](../failures/task-action-empty-id-recovery.md).
- Real mini can still batch multiple background `agent` task creates and hit
  the default `agent=1` active concurrency cap. The cap is now disclosed in
  `task_create` model-facing description; this remains a sequencing/prompt
  sensitivity to test, not an internal queueing contract.
- Pre-fix real mini could underallocate `payload.maxSteps` for
  `task_create(kind:"agent")` by selecting `maxSteps:1` for a child that needed
  to read two files and synthesize an answer. This was fixed by aligning the
  task payload guidance with `spawn_agent`; keep the canary in rotation because
  exact post-create monitoring route (`wait`, `list`, or notification-driven
  answer) remains model-sensitive.
- Mixed prompts that require parent `bash` while running with
  `--access-mode read-only` fail at the bash policy boundary. Diagnose that
  separately from background-agent task health; use a write-enabled temporary
  fixture for bash behavior canaries.
- Pre-fix successful read-only background-agent task traces could receive a
  medium `LOW_NET_PROGRESS` report finding when parent and child model/tool
  counts were aggregated. This is fixed by run-scoped trace diagnostics; treat
  any similar future finding as a trace diagnostics regression before blaming
  agent runtime. See
  [../failures/trace-background-agent-low-progress.md](../failures/trace-background-agent-low-progress.md).
- Provider-specific schema compatibility for external MCP or future deferred
  tools with arbitrary top-level combinators remains a residual risk. The
  built-in deferred `task` wrapper is fixed and covered by deterministic schema
  checks plus a real Sonnet canary. See
  [../failures/anthropic-deferred-task-schema-oneof.md](../failures/anthropic-deferred-task-schema-oneof.md).
- Nested background-agent behavior is untested by design because the v1 surface
  is flat. Reopen coverage only with a concrete user case and a proposal that
  covers tree-wide authorization, budgets, lineage, cancellation, notification
  correlation, and TUI projection.
- 2026-07-07 real mini follow-up confirmed the normal awaited agent-task reuse
  path is clean when mini loads the deferred `task` schema and waits on the
  returned task id. An intentional repeated agent-task diagnostic exposed a raw
  trace metadata gap: terminal `subagent.completed` events for `agent_task`
  lacked `taskId`, so trace diagnostics could not classify completed
  same-payload repeats as `REPEATED_TASK_CREATE_LIFECYCLE`. See
  [../failures/agent-task-terminal-trace-missing-task-id.md](../failures/agent-task-terminal-trace-missing-task-id.md).
- Post-fix verification on the same date confirmed `agent_task`
  `subagent.completed` now carries the originating task id and trace report
  classifies the repeated same-payload agent task as
  `REPEATED_TASK_CREATE_LIFECYCLE`.

## Focused Route

```bash
npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts
npm --workspace @sparkwright/host test -- test/external-command-agent.test.ts
npm --workspace @sparkwright/host test -- test/acp-child-agent.test.ts
npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate"
npm --workspace @sparkwright/core test -- test/trace.test.ts -t "subagent|delegate"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "delegates run|delegate"
npm run regression:real-agents
```

Add TUI rendering checks when event hierarchy or capability panels change:

```bash
npm --workspace @sparkwright/tui test -- test/event-stream-render.test.ts test/capabilities-panel-render.test.tsx
```

## Scenario Links

- [../scenarios/trace-subagent-write-verify.yaml](../scenarios/trace-subagent-write-verify.yaml)

## Sensitivity Links

- [../matrices/prompt-sensitivity.md](../matrices/prompt-sensitivity.md)
- [../matrices/model-sensitivity.md](../matrices/model-sensitivity.md)
- [../matrices/capability-sensitivity.md](../matrices/capability-sensitivity.md)

## Stale Triggers

- `packages/host/src/acp-child-agent.ts`
- `packages/host/src/delegate-capability.ts`
- `packages/host/src/delegate-runner.ts`
- `packages/host/src/external-command-agent.ts`
- `packages/host/src/runtime.ts`
- `packages/agent-runtime/src/*`
- protocol capability snapshot changes

## Failure Links

- [../failures/trace-subagent-finality.md](../failures/trace-subagent-finality.md)
- [../failures/delegates-run-event-metadata-divergence.md](../failures/delegates-run-event-metadata-divergence.md)
- [../failures/deterministic-demo-adapter-run-goal-state.md](../failures/deterministic-demo-adapter-run-goal-state.md)
- [../failures/model-skips-verification.md](../failures/model-skips-verification.md)
- [../failures/prompt-induced-tool-loop.md](../failures/prompt-induced-tool-loop.md)
- [../failures/task-action-empty-id-recovery.md](../failures/task-action-empty-id-recovery.md)
- [../failures/task-list-resume-run-scope.md](../failures/task-list-resume-run-scope.md)
- [../failures/trace-background-agent-low-progress.md](../failures/trace-background-agent-low-progress.md)
- [../failures/anthropic-deferred-task-schema-oneof.md](../failures/anthropic-deferred-task-schema-oneof.md)
