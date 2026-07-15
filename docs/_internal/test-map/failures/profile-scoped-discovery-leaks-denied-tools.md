# Profile-Scoped Discovery Leaks Denied Tools

## Record

- Pattern ID: `profile-scoped-discovery-leaks-denied-tools`
- Status: `fixed`
- First seen: 2026-07-15
- Last seen: 2026-07-15
- Recorded count: 1
- Cause: `product_bug`

## Symptom

A Profile physically removed a deferred definition, but retained the upstream
`tool_search` implementation. Direct execution stayed blocked while discovery
still returned the denied descriptor, so model visibility and admission
disagreed.

## Root Cause And Fix

Filtering `ToolDefinition[]` did not filter the closure captured by the
already-created search tool. Main, child, configured delegate, and dynamic
spawn paths now share Profile admission and rebuild scoped discovery from the
retained definitions with `createScopedToolSearch()`.

## Regression Evidence

`agent-tool-admission.test.ts` executes the retained search tool and proves a
denied deferred descriptor is absent. Real session
`session_mrlx0rjs943j3rgy` searched twice; results contained only admitted
tools, with no direct denied call, approval, or write, and trace/session checks
passed.
