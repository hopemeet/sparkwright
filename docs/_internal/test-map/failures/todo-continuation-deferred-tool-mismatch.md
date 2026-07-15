# Todo Continuation Deferred Tool Mismatch

## Symptom

A completed coding run left Todo items open. Its synthetic continuation was
told to call `todo_write`, but that schema was still deferred. A real model
used ordinary `write` on `TODO.md`, consumed the continuation tool budget, and
triggered a third run because the accidental file write counted as progress.

## Root Cause And Fix

The supervisor directive and Host episode catalog described different callable
surfaces. Every Host entrypoint now calls the same `resolveRunToolSurface()`.
The continuation requests eager promotion of an already-admitted `todo_write`
schema; it does not add a config/Profile/Workflow-filtered tool. When the
required tool is absent, Todo supervision hands off before sending the
impossible directive.

## Regression Evidence

Host focused tests cover eager promotion and non-widening. Real Sonnet session
`session_mrlkn469h2ylznbk` called `todo_write` in the continuation's first model
turn, completed in one continuation, and created no workspace `TODO.md`.
Post-refactor real mini session `audit_todo` kept `todo_write` deferred on the
fresh episode and called it directly on the first continuation turn, without a
`tool_search` detour or extra workspace Todo file.
