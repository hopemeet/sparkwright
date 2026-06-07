# Host Protocol Changelog

Wire-protocol changes between Sparkwright host and clients. Per
[`HOST_PROTOCOL.md`](./HOST_PROTOCOL.md): additions only within a
major; breaking changes bump the major.

## Unreleased

- Add optional `traceLevel` to `run.start` and `run.resume` payloads.

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
