# Host Protocol Changelog

Wire-protocol changes between SparkWright host and clients. Per
[`HOST_PROTOCOL.md`](./HOST_PROTOCOL.md): additions only within a
major; breaking changes bump the major.

## Unreleased

- Add optional `allowWorkspaceWriteApproval` to `run.start` and `run.resume`
  payloads so interactive clients can request per-action write authorization
  while keeping `shouldWrite: false`.
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
- Promote persisted compact artifacts to `session-compact.v2` with top-level
  `freedChars`; unsupported v1 artifacts are ignored rather than migrated.
- Add `metadata.summaryFingerprint` and `metadata.measurement` to compact
  artifacts when available.
- Add canonical `failure` to `run.failed` while keeping deprecated `error` for
  compatibility; clients should use the shared failure shape across terminal
  failure events.

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
