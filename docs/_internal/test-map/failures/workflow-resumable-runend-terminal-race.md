# Workflow RunEnd Claims A Resumable Episode Terminal

## Record

- Pattern ID: `workflow-resumable-runend-terminal-race`
- Status: `fixed`
- First seen: 2026-07-15
- Last seen: 2026-07-15
- Recorded count: 1
- Cause: `product_bug`

## Symptom

A real bounded Workflow episode ended with `max_tool_calls_exceeded`. Its
`RunEnd` projection persisted `workflow.failed` before the Host Todo supervisor
could choose a continuation. The subsequent episode-usage mutation failed with
`stale workflow writer` and the CLI surfaced `internal_error`.

## Root Cause And Fix

Workflow projection and the episode-chain supervisor both claimed terminal
ownership for the same resumable Core stop. The shared
`isTodoResumableStopReason()` predicate now makes Workflow `RunEnd` defer these
reasons; the supervisor chooses continue/handoff, and Host finalization alone
persists the durable terminal state. No persistence retry or new state flag was
added.

## Regression Evidence

The hook test proves resumable `RunEnd` emits neither `workflow.interrupted`
nor `workflow.failed`. A Host scripted integration forces search, pending Todo,
budget stop, continuation promotion, reconciliation, and final completion
across two run ids. The pre-fix real trace is session `session_mrlx1u02`; a
post-fix real trace `session_workflow_f43381186e7d42c089aaca2451541a3a`
created the second episode and exposed `todo_write` as `prompt_required`
without the stale-writer failure (the weak model later exhausted the deliberately
tight continuation budget, classified separately as model variance).
