# Workflow Durable Job Coverage

## Status

- Package A immutable execution/approval identity: `Verified`.
- Package B independent workflow job session: `Verified`.
- Package C mutation write fencing: `Verified` at the store/Host focused gate;
  full release gate recorded below.
- Package D durable control inbox: `Verified` at the focused implementation and
  deterministic fault gate; full release result recorded below.
- Package E: `Untested`; design gate may reopen after the independent D commit.
- Packages F–G: `Untested`; reopen gates remain closed by E.

## Current Evidence

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
5. Competing claims produce one generation winner; crash at every journal /
   snapshot projection boundary must recover one canonical revision.

Do not mark C partially verified from current lease acquire/release tests; they
do not exercise workflow mutation fencing.

## Package C Evidence (2026-07-11)

- Canonical immutable journal separates physical sequence, record revision,
  and fencing generation. Snapshot JSON and event JSONL are projections.
- Deterministic tests cover TTL takeover, stale mutation and compensation,
  revision races, stale-generation physical entries, torn publication slots,
  corrupt projections, lazy-migration retry, and concurrent migration claim.
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
