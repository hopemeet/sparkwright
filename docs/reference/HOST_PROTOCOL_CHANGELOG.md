# Host Protocol Changelog

Wire-protocol changes between SparkWright host and clients. Per
[`HOST_PROTOCOL.md`](./HOST_PROTOCOL.md): additions only within a
major; breaking changes bump the major.

## Unreleased

- Add optional `accessMode` to `run.start` and `run.resume` payloads as the
  preferred high-level run autonomy field. Hosts compile it to legacy
  `permissionMode`/`shouldWrite` and record conflicts in metadata.
- Add optional `confidentialPaths` and `confidentialDefaults` to `run.start`,
  `run.resume`, and `workflow.resume` payloads so clients can add per-run
  read-confidentiality deny globs and explicitly opt out of the built-in
  conservative confidential path defaults.
- Add optional `traceLevel` to `run.start` and `run.resume` payloads.
- Add optional `autoApproved` to `approval.resolve` so clients can mark
  policy/flag-driven approvals structurally.
- Add `session.compact` request for host-owned manual session context
  compaction.
- Extend `session.compact` responses with `freedChars`, `measurement`, optional
  `skippedReason`, and optional `warnings`.
- Add optional `llm` to `session.compact` payloads. Provider/scripted model refs
  route to the model-backed Tier 3 summarizer; deterministic refs keep the
  preview path and return a warning.
- Add optional `model` to capability delegate summaries so clients can inspect
  profile-preferred delegate models.
- Add optional `rules.workflow` to capability snapshots so clients can inspect
  configured workflow hooks, verification invariants, and built-in workflow
  rule availability without changing run behavior.
- Add optional `rules.events` to capability snapshots so clients can inspect
  configured non-blocking event hook subscribers. Workflow rule lifecycles are
  reported with canonical hook names.
- Add optional `workflows` to capability snapshots so clients can inspect
  parsed workflow assets and parse errors before any workflow runtime behavior
  ships.
- Promote persisted compact artifacts to `session-compact.v2` with top-level
  `freedChars`; unsupported v1 artifacts are ignored rather than migrated.
- Add `metadata.summaryFingerprint` and `metadata.measurement` to compact
  artifacts when available.
- Add canonical `failure` to `run.failed` while keeping deprecated `error` for
  compatibility; clients should use the shared failure shape across terminal
  failure events.
- Add host task control requests: `task.join` marks a task awaited for
  on-demand revival, and `task.promote` signals an in-flight foreground wait to
  resolve as a promoted task ticket.
- Add host task snapshot requests: `task.list`, `task.get`, `task.output`, and
  `task.stop`, plus `task_not_found` for missing durable background task ids.
- Add workflow-run snapshot requests: `workflow.list` lists durable workflow
  run records under session `workflow-runs/`, and `workflow.resume` adopts a
  non-terminal workflow run by single-writer lease and starts a new host run
  from the pinned workflow definition snapshot. Hosts advertise both in
  `host.ready.capabilities`.

## 1.3 (2026-06-14)

- Add `session.compact` request shape and SDK client `compactSession()`.
- Host runtime writes `compact.json` session artifacts and uses them to seed
  future runs with a compacted summary plus any later un-compacted turns.

## 1.2 (2026-06-06)

- Add `run.resume` request shape for host-owned checkpoint/trace resume.
- Add SDK client `resumeRun()` wrapper.
- Host runtime implements `run.resume` for session-scoped checkpoints and
  best-effort trace reconstruction, and advertises `run.resume` in
  `host.ready.capabilities`.

## 1.1 (2026-05-24)

- Add `run.inject_message` request for mid-run user-message injection.
- Host advertises `run.inject_message` in `host.ready.capabilities`.

## 1.0 (2026-05-24) — draft

Initial protocol. Not yet implemented. Defines:

- Wire envelopes: `request`, `response`, `event`.
- Request kinds: `handshake`, `run.start`, `run.cancel`,
  `approval.resolve`, `session.list`.
- Event kinds: `host.ready`, `host.log`, `run.event`,
  `approval.requested`, `run.completed`, `run.failed`.
- Error code vocabulary.
- Versioning policy: additive within major, breaking only across.
