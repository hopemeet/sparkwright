# Protocol

## Purpose

`@sparkwright/protocol` defines host/client wire contracts: requests,
responses, errors, host events, permission modes, trace levels, and capability
inspection shapes.

See also [../maps/safety/approvals.md](../maps/safety/approvals.md) and [../maps/session/session-store.md](../maps/session/session-store.md).

## Main Files

- `packages/protocol/src/index.ts`
- `packages/protocol/test/index.test.ts`
- `docs/reference/HOST_PROTOCOL.md`
- `docs/reference/PROTOCOL.md`

## Owns / Does Not Own

Owns:

- host request and response TypeScript shapes
- stable host event payload shapes
- protocol-level error codes
- capability snapshot types
- shared client-side run-event visibility constants that must stay consistent
  across CLI/TUI products

Does not own:

- implementation of host runtime behavior
- file trace JSONL event schema
- CLI/TUI rendering layout or product-specific event formatting

## Contracts

- Request kinds include `run.start`, `run.resume`, `run.inject_message`, `run.cancel`, `approval.resolve`, `session.list`, `session.inspect`, `session.fork`, `session.compact`, and `capability.inspect`.
- `run.start` and `run.inject_message` keep their text fields (`goal` and
  `content`) as required user-turn summaries and may add `input.parts` for
  extensible text/image/file/audio content.
- `traceLevel` is a protocol field on run start/resume. Valid values are
  `standard` and `debug`.
- `INTERNAL_TRANSCRIPT_EVENT_TYPES` / `isInternalTranscriptEventType()` are the
  shared low-signal event filter used by TUI live transcript rendering and
  `/export`; this is product transcript visibility, not raw trace semantics.
- `LIVE_DEBUG_NOISE_EVENT_TYPES` / `isLiveDebugNoiseEventType()` are the shared
  high-volume event filter for CLI live run output; raw trace diagnostics still
  expose those events. The list currently includes `model.stream.chunk` and
  `run.budget.checked`.
- `approvalId` from `approval.requested` is resolved by `approval.resolve`.
- `CapabilityDelegateToolSummary.protocol` covers `acp`,
  `external_command`, and configured in-process delegates as `in_process`.
  `command`/`args` are optional because in-process delegates do not spawn a
  separate process.
- `CapabilityDelegateToolSummary.requiresApproval` is a legacy config echo.
  Diagnostics should prefer conditional approval facts:
  `approvalRequiredUnderCurrentRun`, `approvalReasons`, and
  `approvalRunOptions`.
- Clients must tolerate unknown metadata.

## Consumers

- `@sparkwright/host`
- `@sparkwright/sdk-*`
- CLI and TUI host clients
- Docs in `docs/reference/`

## Change Checklist

- Update `docs/reference/HOST_PROTOCOL.md`.
- Update SDK tests.
- Check CLI/TUI request construction.
- Keep error code handling backward compatible where possible.

## Known Debts

- Protocol and file trace contracts are related but separate; avoid documenting one as the other.

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/protocol/src/index.ts`, `packages/cli/src/cli.ts`, `docs/reference/HOST_PROTOCOL.md`, `docs/reference/PROTOCOL.md`, `schemas/host-message.schema.json`.
- Tests: `npm --workspace @sparkwright/protocol run build`; `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capabilities inspect"`.
