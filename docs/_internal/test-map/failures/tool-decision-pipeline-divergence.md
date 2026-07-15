# Tool Decision Pipeline Divergence

## Symptom

Several individually reasonable helpers made different decisions about the
same tool. Workflow episode narrowing could recreate an upstream-disabled
`tool_search`; Core resolved a legacy alias only at registry lookup after hooks
and policy had evaluated the raw name; `available:false` hid a schema but did
not prevent a guessed call from reaching execution; and Agent deny lists could
remain policy-only while the denied schema stayed model-visible.

## Root Cause

Admission, exposure, discovery, approval, and execution were represented as
mutations of `ToolDefinition[]` at multiple entrypoints instead of explicit,
ordered decisions. Deferred loading and derived discovery helpers could look
like authorization, while fresh/resume/continuation builders assembled their
own arrays.

## Fix

- Config/source catalog and Agent/Profile admission physically produce the
  upstream candidate set.
- Shared Profile admission applies aliases/wildcards and deny-after-allow, and
  rebuilds scoped discovery from retained definitions rather than retaining a
  broader captured index.
- One pure `resolveRunToolSurface()` applies Workflow narrowing, scoped
  discovery, and prompt-required eager promotion without widening or creating
  a parallel diagnostic decision model.
- Fresh, resume, Workflow resume, and Todo continuation use that same planner.
- Core canonicalizes aliases before hooks/policy and checks availability before
  policy/handler execution. Public lifecycle/approval payloads keep the
  requested alias for compatibility and carry `canonicalToolName` for
  diagnosis.
- Call-time policy remains authoritative for argument-sensitive execution;
  approval only confirms operations that policy already admits.

## Regression Evidence

The first review proved one remaining leak in the original fix: filtered
Profiles retained an upstream discovery closure. Table-driven Host tests now
execute scoped search as well as covering allow/deny/deferred, Agent x Workflow narrowing,
alias x deny, MCP wildcard/deferred discovery, read-only visibility versus
execution, continuation promotion, and removed-tool continuation. Core tests
cover alias policy denial and guessed unavailable tools. Real mini traces in
`2026-07-15-tool-decision-architecture-audit.md` show Profile/Workflow clamps,
Todo promotion, deferred discovery, read-only call-time denial, and CLI/TUI
parity. Episode visibility is not persisted as a second permission model.
