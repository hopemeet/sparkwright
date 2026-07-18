# Workflow Durable Job Coverage

## Status

- Package A immutable execution/approval identity: `Verified`.
- Package B independent workflow job session: `Verified`.
- Package C mutation write fencing: `Verified` at the store/Host focused gate;
  full release gate recorded below.
- Package D durable control inbox: `Verified` at the focused implementation and
  deterministic fault gate; full release result recorded below.
- Package E durable supervisor/worker ownership: `Verified` at the focused
  implementation/fault gate; full release result recorded below.
- Package F: `Verified`; implementation/focused fault/full release gates passed.
- Package G: `Verified`; implementation, deterministic fault, focused, full
  release, map/test-map, retirement, and independent change-set gates passed.

## Current Evidence

- 2026-07-18 Host ownership consolidation: `WorkflowRuntimeOperations` now
  owns Host-side canonical lookup/list projection, notification delivery,
  durable control processing, resume claims, terminal finalization, and
  journal-bound mutation/projection helpers. Direct owner tests cover shared
  roots/inbox/list projection and durable accept/dispatch/idempotency; existing
  Host, Agent Runtime, and Server Runtime Workflow suites remain the behavior
  backstop. No journal, notification, command, outcome, or protocol shape
  changed.

- 2026-07-17 canonical package identity convergence: Workflow mutation records
  require generation/revision, source layer, v2 package hash/policy, executable
  snapshot ref, and a matching snapshot-backed definition. Journal replay
  quarantines missing pins; focused store/control/channel, Host start/resume/
  shadow/stats/protocol, CLI/TUI, and server-runtime fixtures no longer seed
  durable `contentHash` or revision/generation defaults.
- 2026-07-16 journal-only convergence: `FileWorkflowStore.get/list/eventLog`,
  restart recovery, writer acquire/create/mutate/compensate, and all Host/CLI/TUI
  consumers now use the immutable journal as their only record/event truth.
  Record JSON/event JSONL readers, mirrors, and lazy import were removed; the
  token lease remains the adjacent live-ownership primitive.
- A: TUI full suite 399-test baseline includes immutable permission identity,
  exact run/workflow attribution, client-specific approval cleanup, and active
  main-run session mutation guards.
- B: real Host child integrations prove a main session and two workflow jobs
  use three distinct session ids; workflow records map job session plus control
  session attribution; CLI explicit `--session-id` becomes attribution rather
  than workflow storage; job traces exclude the main-chat sentinel.

## Required Package C Fault World

Use a controllable clock and barriers, not sleep:

1. A claims generation/token and reaches a barrier after its final pre-write
   validation.
2. Advance beyond TTL; B claims a higher generation and writes.
3. Release A; its update, event, and restore attempts must all fail without
   changing B's canonical record/history.
4. A release must not affect B. B must continue through waiting, resume, and
   completion.
5. Competing claims produce one generation winner; torn/corrupt journal slots
   recover one canonical revision without advancing record/event truth.

Do not mark C partially verified from current lease acquire/release tests; they
do not exercise workflow mutation fencing.

## Package C Evidence (2026-07-11)

- Canonical immutable journal separates physical sequence, record revision,
  and fencing generation and is the sole record/event read layout.
- Deterministic tests cover TTL takeover, stale mutation and compensation,
  revision races, stale-generation physical entries, torn publication slots,
  checksum/quarantine diagnostics, restart recovery, canonical event replay,
  and concurrent journal claim.
- Host fresh start, resume input, episode projection/usage, finalization,
  supervisor failure, and rollback use `WorkflowLeaseBoundWriter`; fixture and
  production searches show no external `update/restore/appendEvent` bypass.
- Focused commands: agent-runtime workflow/doc-store 32 tests; Host workflow
  and protocol 79 tests; CLI workflow slice 13 tests; affected typecheck/build
  commands passed.
- Full gate: the first `npm run release:check` stopped only at Prettier for
  seven changed TypeScript files; after formatting, the complete command was
  rerun and passed, including all workspace tests and install smokes.
- Final source audit added writer/record/event identity fail-closed validation;
  its focused rerun passed before the final release rerun.

## Required Package D Fault World

Use exclusive publication hooks/barriers and restartable consumers:

1. duplicate source/idempotency/payload returns one accepted command and one
   terminal outcome; a different payload under the same scope conflicts;
2. expired, unauthorized, stale-generation, wrong-status, wrong-waitId and
   wrong-approvalId commands produce immutable rejected outcomes;
3. two consumers race one command and only one workflow journal mutation is
   canonical;
4. crash after workflow mutation but before outcome is recovered through the
   canonical event `controlCommandId` without applying twice;
5. crash after outcome but before cursor rebuild does not replay the command;
6. torn/corrupt command/outcome entries are isolated and do not wedge later
   commands;
7. producer disconnect does not delete accepted commands; a later consumer can
   process them;
8. duplicate/multi-channel approval or input response has one winner and all
   losers receive already-resolved or state-mismatch outcomes.

## Package D Evidence (2026-07-11)

- Agent-runtime persists immutable typed commands/outcomes with scoped
  idempotency, reconstructible cursor state, corrupt-entry isolation, expiry,
  authorization, generation/status/wait checks, and canonical-event recovery.
- Deterministic tests cover duplicate/conflicting accept, concurrent producers
  and consumers, restart/corrupt cursor, torn command isolation, mutation-before-
  outcome recovery, missing approval authorization, and single canonical apply.
- Host protocol derives source identity, routes `workflow.resume` through the
  inbox, applies live controls with the active fenced writer, and treats a busy
  remote owner as durable acceptance. TUI stop uses `workflow.control` rather
  than requiring a locally owned child connection.
- Focused gate: agent-runtime workflow/control 37 tests, server-runtime 7,
  Host workflow/protocol 80, SDK 10, TUI workflow/SDK 21, and CLI workflow 13;
  affected typecheck/build and schema checks passed.
- Full gate: the first `npm run release:check` found the new serialized
  `connectionId` audit field needed an explicit `@reserved` declaration; after
  adding it, strict reserved-field check passed and a complete release check
  rerun passed through all workspace tests, regression matrix, and both install
  smokes.

## Required Package E Fault World

Use a controllable clock and barriers around registry heartbeat, workflow claim,
and adapter start:

1. worker A registers, heartbeats, claims a running workflow, and blocks before
   its next mutation;
2. A is killed; its worker heartbeat and workflow lease expire independently;
3. worker B registers, publishes the only higher-generation canonical claim,
   and continues the workflow;
4. revived A mutation/compensation/release cannot change B's record or lease;
5. two supervisors race the same inventory candidate and only the claim winner
   invokes the execution adapter;
6. durable drain prevents new claims, reports active/remaining claims, and does
   not label interruption as pause or completion;
7. supervisor restart rebuilds candidates from workflow records/journals and
   pending D commands without an in-memory owner map;
8. waiting/input/approval records remain waiting without an authorized command;
   inbox and notification cursors neither duplicate nor lose accepted work;
9. adapter crash after claim but before episode start is recoverable after TTL;
10. terminal workflows and live unexpired claims are never adopted.

## Package E Evidence (2026-07-11)

- Deterministic registry tests cover heartbeat, expiry, no revival, drain,
  stop, restart read, and immutable worker instance identity.
- Supervisor barriers cover two-worker single adapter winner, drain with active
  claim reporting, restart inventory rebuild, waiting/terminal exclusion, and
  expired worker refusal. Package C tests remain the stale writer/takeover
  backstop for mutation, compensation, and old release fencing.
- Host integration starts a pinned workflow with a supervisor-supplied claimed
  writer and completes at the same generation, proving no second claim while
  retaining the ordinary authorization/execution assembly path.
- Focused gate: agent-runtime workflow worker/control/store 39 tests,
  server-runtime 12, and Host workflow/protocol 81; affected typecheck/build
  commands passed.
- Full gate: the first release run found only the new serialized worker
  `stoppedAt` audit field needed an explicit `@reserved` declaration. After the
  declaration, strict reserved-field check and a complete `npm run release:check`
  rerun passed through all workspace tests, regression matrix, and both install
  smokes.

## Required Package F Fault World

Use a controllable clock plus barriers around instance publication, handoff
accept, workflow record creation, outcome publication, and supervisor claim:

1. two service carriers race one workspace and only one becomes ready;
2. stale instance/pid projection is recovered without treating pid liveness as
   workflow ownership;
3. producer publishes then exits/crashes and the service still accepts/runs;
4. service crashes before accept, after accept, and after workflow record
   creation but before outcome; restart creates at most one workflow;
5. duplicate handoff/idempotency returns one workflow identity, while payload
   conflict, expiry, authorization failure, or wrong workspace is rejected;
6. SIGKILL carrier A, expire worker/workflow leases, start B, and prove revived
   A cannot mutate/release B's workflow;
7. drain prevents new accepts and reports remaining workflows without writing
   pause/completed;
8. different workspace roots cannot see or claim each other's handoffs,
   records, workers, sessions, or logs;
9. bounded concurrency holds under a burst and restart inventory rebuilds from
   durable stores rather than an in-memory queue;
10. waiting with no channel remains waiting; durable Package D control later
    resumes it exactly once;
11. instance projection, outcome projection, and operational log write faults
    do not produce false detached success or duplicate canonical workflows;
12. CLI detach returns only after durable accepted outcome; unavailable or
    timed-out service fails explicitly, while foreground workflow behavior is
    unchanged.

## Package F Evidence (2026-07-11)

- Deterministic service-store tests cover immutable handoff idempotency/conflict,
  live-instance single winner, expiry takeover, instance-scoped drain, recovered
  outcome publication, expired/wrong-workspace rejection, and revived-carrier
  fencing without false rejection.
- Host fixed-id integration proves one service handoff can create only one
  canonical workflow record and persists the handoff recovery linkage; a
  duplicate fresh start cannot create a second record.
- CLI tests prove unavailable service fails before workflow storage mutation,
  status is fail-closed, and detached success is emitted only after a carrier
  publishes the durable accepted outcome. Existing foreground workflow slice
  remains green.
- Focused gate: server-runtime 18 tests, Host workflow/protocol 82 tests, CLI
  workflow slice 15 tests; affected typecheck/build commands passed.
- Full gate: the first release run found only two CLI lint errors introduced by
  the service handler (unused injected env and prefer-const). After fixing them,
  a complete `npm run release:check` rerun passed all workspace tests,
  regression matrix, source install smoke, and release install smoke.

## Required Package G Fault World

1. publish one durable workflow waiting/approval notification and bind two
   independently authenticated adapters with different command scopes;
2. disconnect both after notification publication, reconnect from empty memory,
   and replay from durable delivery receipts/cursors without losing the gap;
3. crash after transport send before receipt, and after receipt before cursor;
   retries may redeliver but must keep one stable delivery/idempotency key;
4. race two authorized responses to the same wait/approval and prove one
   Package D canonical apply winner with an explicit loser outcome;
5. duplicate webhook/message id cannot apply twice; same id with changed payload
   conflicts;
6. expired, revoked, wrong-workspace/session/workflow/source/channel or
   disallowed-command binding fails before D accept;
7. a message-only binding cannot approve or cancel; durable approval also
   requires matching approvalId and authorization snapshot;
8. corrupt receipt/cursor is isolated and rebuilt without skipping later
   notifications;
9. generation takeover makes late old-generation responses stale while the new
   worker/channel can continue;
10. no channel leaves the workflow waiting; later binding/delivery resumes it;
11. TUI, CLI, IM and SDK/Web/API adapters all route through the same binding +
    D command contract and none writes WorkflowRunRecord directly;
12. workflow peer messaging, arbitrary JSON commands, producer-selected model
    context injection, model workflow_start and nested spawn remain rejected.

## Package G Evidence (2026-07-11)

- Binding tests cover immutable publication/conflict, source/workspace/session/
  command scope, expiry, revoke, message-only refusal of cancel, command-expiry
  clamp, webhook duplicate/payload conflict, and two-channel approval single
  canonical winner.
- Delivery tests cover one receipt per binding/notification, stable delivery key,
  send-before-receipt crash retry, failed-to-delivered retry, expired/revoked
  terminal receipts, corrupt cursor rebuild, and restart from durable stores.
- Host removes process-local workflow notification dedupe as truth, includes
  wait identity plus generation/status in durable notification projection, and
  dispatches only pre-existing commands through `workflow.control.process`.
- CLI and TUI integration tests prove stop creates a narrow authenticated
  binding, persists one Package D command, applies it through Host, and reaches
  one cancelled record. SDK protocol helper, IM durable delivery, authenticated
  response, duplicate response, and unauthorized cancel tests pass.
- Focused gate: agent-runtime channel/control 19 tests, server-runtime
  channel/supervisor 15, Host workflow/protocol 83, SDK 10, IM 13, TUI
  workflow/SDK 22, CLI workflow 16; affected typecheck/build, schema, and strict
  reserved-field checks passed.
- Full gate: the first `npm run release:check` stopped only at ESLint for an
  unused `dirname` import in the new channel store; after removing it, the
  complete command was rerun from the beginning and passed all workspace
  tests, regression matrix cases, source-install smoke, and release pack smoke.
- Final map drift/diff checks and the independent Package G commit are the
  closing checks for this change set; no Package G code is mixed into A-F.

### Package G routed-page audit

The final Touch File -> Read Docs drift pass also routed through the following
pages. They were read and need no semantic update for Package G: capability
agent/cron/index maps (no capability declaration or cron behavior changed),
trace summary/raw/export maps (no trace schema or diagnostics path changed),
safety approvals/workspace-writes maps (durable workflow commands remain behind
the existing approval and workspace clamps), runtime run-loop/tool-orchestration
maps (Host dispatch still enters the existing run loop), the MCP capability map
(no MCP surface changed), and the core module map (server-runtime coordination
does not change core ownership). The exact reviewed files were:

- `project-map/maps/capabilities/agents.md`
- `project-map/maps/capabilities/cron.md`
- `project-map/maps/capabilities/README.md`
- `project-map/maps/capabilities/mcp.md`
- `project-map/maps/trace/summary-timeline-verify.md`
- `project-map/maps/trace/raw-trace.md`
- `project-map/maps/trace/export-diagnostics.md`
- `project-map/maps/safety/approvals.md`
- `project-map/maps/safety/workspace-writes.md`
- `project-map/maps/runtime/run-loop.md`
- `project-map/maps/runtime/tool-orchestration.md`
- `project-map/modules/core.md`

## Post-audit concurrency closure (2026-07-11)

- Reproduced the Package D duplicate-acceptance flake: an EEXIST loser could
  observe the winner's final path before JSON publication completed and
  misreport a command-id conflict. Command and outcome publication now use
  bounded read-back.
- Stress testing exposed a Package C false-success window: a later publisher
  could skip a temporarily unreadable winner, publish the next physical slot,
  then mistake the winner's equal revision for its own success. Publisher
  read-back now requires its exact physical sequence to be canonical.
- Async and sync journal readers share `applyCanonicalEntry`; a mismatched
  baseline identity test proves identical quarantine/head results.
- `acquireWriter()` releases and returns null when baseline/claim publication
  loses fencing, preserving existing busy handling.
- Evidence: workflow/control 38/38; combined workflow/control/channel/worker
  stress 20 consecutive runs at 46/46; Host workflow/protocol 83/83;
  server-runtime 21/21; final `npm run release:check` passed all workspace
  tests, regression matrix cases, source-install smoke, and release-install
  smoke.
