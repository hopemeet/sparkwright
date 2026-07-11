# Workflow Durable Job Coverage

## Status

- Package A immutable execution/approval identity: `Verified`.
- Package B independent workflow job session: `Verified`.
- Package C mutation write fencing: `Untested` / design gate only.
- Packages D–G: `Untested`; reopen gates closed by C.

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
