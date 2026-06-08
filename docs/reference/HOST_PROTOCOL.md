# Sparkwright Host Protocol

This is a reference contract. If you are new to Sparkwright, start with
[the documentation map](../README.md) or the [User Manual](../guides/USER_MANUAL.md).

**Version:** 1.2
**Schema:** [`schemas/host-message.schema.json`](../../schemas/host-message.schema.json)
**Changelog:** [`HOST_PROTOCOL_CHANGELOG.md`](./HOST_PROTOCOL_CHANGELOG.md)

This document specifies the wire protocol spoken between a **Sparkwright
host** (a process that owns the agent runtime) and any **client** (the
built-in TUI, the future browser SDK, an editor plugin, a third-party
TUI, etc).

The host is the single source of truth for what an agent does. Clients
are presentation. Multiple clients may share one host concurrently in
future versions; v1.0 assumes a single client per connection.

---

## Transports

A host exposes the same protocol over two transports. Clients pick
whichever fits their environment.

| Transport     | Used by                                                   | Framing                                                                         |
| ------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **stdio**     | Local Node clients that spawn the host as a child process | Newline-delimited JSON. One message per `\n`-terminated line on stdout / stdin. |
| **WebSocket** | Browser clients, remote attach                            | One message per text frame.                                                     |

WebSocket hosts bind to `127.0.0.1` by default. If an operator binds to a
non-loopback address, they should either set `--auth-token <token>` (or
`SPARKWRIGHT_HOST_TOKEN`) and connect with `Authorization: Bearer <token>` or
`?token=<token>`, or put the host behind trusted network/auth controls.

The host's stderr is **never** part of the protocol. On stdio transport,
hosts route all stderr lines and uncaught exception summaries through
the `host.log` event so they cannot corrupt the JSON stream on stdout.

Clients connecting over WebSocket may receive `host.log` events for the
same content, surfaced by the host's stderr capture.

---

## Message envelope

Every message is exactly one of three envelopes, discriminated by the
`envelope` field.

### Request (client → host)

```json
{
  "envelope": "request",
  "id": "req_01",
  "kind": "handshake",
  "timestamp": "2026-05-24T12:00:00.000Z",
  "payload": { "...kind-specific..." }
}
```

- `id`: chosen by the client. Must be unique within the connection
  lifetime. The host echoes it on the matching response.
- `kind`: see [Request kinds](#request-kinds).
- The host **must** send exactly one `response` with the same `id` per
  request, regardless of success or failure.

### Response (host → client)

```json
{
  "envelope": "response",
  "id": "req_01",
  "ok": true,
  "timestamp": "2026-05-24T12:00:00.050Z",
  "result": { "...kind-specific..." }
}
```

- `id` echoes the request's `id`.
- `ok` is `true` (then `result` is present) or `false` (then `error` is
  present). They are mutually exclusive.
- Errors use a fixed `code` vocabulary; see [Error codes](#error-codes).

### Event (host → client)

```json
{
  "envelope": "event",
  "id": "evt_001",
  "kind": "run.event",
  "timestamp": "2026-05-24T12:00:03.000Z",
  "payload": { "...kind-specific..." }
}
```

- `id` is purely advisory (e.g. for client-side dedup); clients may
  ignore it.
- Events are fire-and-forget. The client never sends a response.
- Hosts emit events in chronological order within a single connection.

---

## Connection lifecycle

```
client                                    host
  │  TCP / spawn established               │
  │                                        │
  │  ──── request handshake ─────────────► │
  │                                        │  (validate protocolVersion)
  │  ◄─── response ok ───────────────────  │
  │  ◄─── event host.ready ──────────────  │
  │                                        │
  │  ──── request run.start ─────────────► │
  │  ◄─── response ok { runId } ─────────  │
  │  ◄─── event run.event (many) ────────  │
  │  ──── request run.inject_message ────► │
  │  ◄─── response ok ───────────────────  │
  │  ◄─── event approval.requested ──────  │
  │  ──── request approval.resolve ──────► │
  │  ◄─── response ok ───────────────────  │
  │  ◄─── event run.event (more) ────────  │
  │  ◄─── event run.completed ───────────  │
  │                                        │
  │  TCP close / process exit              │
```

### Handshake

The client **must** send `handshake` as its first request. Any other
request before a successful handshake responds with
`protocol_version_mismatch` and the connection is closed.

The host responds with `ok` (no result body required) and immediately
emits a `host.ready` event carrying the host's own version and the list
of optional capabilities the host supports.

Version negotiation rule for v1.x: hosts and clients agree if and only
if the **major** version matches. Minor differences are tolerated; the
side with the lower minor will simply not use features added later.

### Disconnect

If the transport drops while a request is pending, the client treats
the request as failed with code `internal_error` and message `transport
closed`. If a run is in flight when the client disconnects, hosts
**should** cancel it with reason `client_disconnected`.

If an approval request is pending when the client disconnects, hosts
**must** treat it as `denied` for safety.

---

## Request kinds

### `handshake`

Negotiate protocol version. See [Handshake](#handshake).

**Payload**

| Field             | Type                 | Required | Notes                                       |
| ----------------- | -------------------- | -------- | ------------------------------------------- |
| `protocolVersion` | string `MAJOR.MINOR` | yes      | Client's spoken version.                    |
| `client.name`     | string               | yes      | Stable identifier (e.g. `sparkwright-tui`). |
| `client.version`  | string               | yes      | semver.                                     |
| `capabilities`    | string[]             | no       | Optional features the client supports.      |

**Response result:** empty object.

### `run.start`

Begin a new agent run.

**Payload**

| Field            | Type                                     | Required | Notes                                                                      |
| ---------------- | ---------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `goal`           | string                                   | yes      | User goal text.                                                            |
| `sessionId`      | string                                   | no       | Existing session to write into; host creates a new one if omitted.         |
| `targetPath`     | string                                   | no       | Workspace-relative target path the run should focus on when applicable.    |
| `shouldWrite`    | boolean                                  | no       | Whether this run is allowed to request workspace writes.                   |
| `model`          | string                                   | no       | Model reference in `provider/model` form, or the reserved `deterministic`. |
| `permissionMode` | string                                   | no       | `plan`, `default`, `accept_edits`, `dont_ask`, or `bypass_permissions`.    |
| `traceLevel`     | `"minimal"` \| `"standard"` \| `"debug"` | no       | Trace persistence detail level; defaults to `standard`.                    |
| `metadata`       | object                                   | no       | Free-form, propagated to runRecord.                                        |

**Response result**

| Field   | Type   | Notes                                                                      |
| ------- | ------ | -------------------------------------------------------------------------- |
| `runId` | string | Use this in subsequent `run.cancel` requests and to correlate `run.event`. |

The run starts asynchronously. The host emits `run.event` events as
they happen and one terminal event (`run.completed` or `run.failed`).

### `run.inject_message`

Inject an additional user message into an active run. This is used by
IM gateways and other remote clients for mid-run steering/follow-up.

**Payload**

| Field      | Type   | Required | Notes                                            |
| ---------- | ------ | -------- | ------------------------------------------------ |
| `runId`    | string | yes      | Active run to receive the message.               |
| `content`  | string | yes      | User message to enqueue into the run loop.       |
| `metadata` | object | no       | Free-form source/routing metadata for the trace. |

**Response result:** empty object. The core run emits normal
`run.command.enqueued` / `run.command.applied` events through
`run.event`; there is no separate host event for injection.

If the run is unknown or already terminal, the host responds with
`run_not_found`.

### `run.resume`

Resume a prior run from a persisted checkpoint. This moves checkpoint lookup,
checkpoint reconstruction, model/tool rehydration, trace append, and terminal
event emission into the host so CLI, TUI, browser, and other clients can share
one resume path.

`run.resume` is part of protocol v1.2. Hosts advertise `run.resume` in
`host.ready.capabilities` once runtime support is available; clients should
prefer checking the host capability list before using it.

**Payload**

| Field            | Type    | Required | Notes                                                                      |
| ---------------- | ------- | -------- | -------------------------------------------------------------------------- |
| `runId`          | string  | yes      | Prior run id to resume.                                                    |
| `sessionId`      | string  | no       | Session scope used to disambiguate where the prior run lives.              |
| `targetPath`     | string  | no       | Workspace-relative target path the resumed run should focus on if needed.  |
| `shouldWrite`    | boolean | no       | Whether this resumed run is allowed to request workspace writes.           |
| `fromTrace`      | boolean | no       | Reconstruct a best-effort checkpoint from `trace.jsonl` if needed.         |
| `force`          | boolean | no       | Allow resuming checkpoints that are terminal or normally refused.          |
| `model`          | string  | no       | Model reference in `provider/model` form, or the reserved `deterministic`. |
| `permissionMode` | string  | no       | `plan`, `default`, `accept_edits`, `dont_ask`, or `bypass_permissions`.    |
| `traceLevel`     | string  | no       | `minimal`, `standard`, or `debug`; defaults to `standard`.                 |
| `metadata`       | object  | no       | Free-form metadata propagated to the resumed run record and trace context. |

**Response result**

| Field              | Type   | Notes                                                                                       |
| ------------------ | ------ | ------------------------------------------------------------------------------------------- |
| `runId`            | string | Active run id for the resumed execution. Core checkpoint resume preserves the prior run id. |
| `resumedFromRunId` | string | Prior run id from the request.                                                              |
| `sessionId`        | string | Present when the resumed run is attached to a session.                                      |

The resumed run starts asynchronously, like `run.start`. The host emits
`run.event` events and one terminal event (`run.completed` or `run.failed`).
If the prior run cannot be found, the host responds with `run_not_found`; if a
specified session cannot be found or does not contain the run, it responds with
`run_not_found`.

Session-scoped runs resume into their existing session. Legacy
`.sparkwright/runs/<runId>` directories do not carry session identity, so a
host-owned resume attaches them to a newly-created session and returns that
`sessionId`.

### `run.cancel`

Cancel a running run.

**Payload**

| Field    | Type   | Required |
| -------- | ------ | -------- |
| `runId`  | string | yes      |
| `reason` | string | no       |

**Response result:** empty object. The run subsequently emits a
`run.completed` event with `stopReason: "manual_cancelled"`.

### `approval.resolve`

Resolve an `approval.requested` event.

**Payload**

| Field        | Type                       | Required | Notes                      |
| ------------ | -------------------------- | -------- | -------------------------- |
| `approvalId` | string                     | yes      | From `approval.requested`. |
| `decision`   | `"approved"` \| `"denied"` | yes      |                            |
| `message`    | string                     | no       | Surfaced in the run trace. |

**Response result:** empty object.

If the approval is unknown or already resolved, the host responds with
`approval_not_found`.

### `session.list`

List recent sessions on disk.

**Payload**

| Field   | Type           | Required | Notes       |
| ------- | -------------- | -------- | ----------- |
| `limit` | integer 1..200 | no       | Default 20. |

**Response result**

```json
{
  "sessions": [
    {
      "id": "session_abc",
      "mtimeMs": 1716000000000,
      "preview": "first user msg…"
    }
  ]
}
```

### `session.inspect`

Return diagnostics for one persisted session. Hosts derive the response from
the session directory; clients should treat it as read-only observability data.

**Payload**

| Field       | Type   | Required | Notes       |
| ----------- | ------ | -------- | ----------- |
| `sessionId` | string | yes      | Session id. |

**Response result**

```json
{
  "sessionId": "session_abc",
  "summary": { "eventCount": 12 },
  "consistency": { "ok": true, "findings": [] },
  "timeline": { "phases": [] }
}
```

### `capability.inspect`

Return the host-authored capability snapshot known to this connection. This is
read-only observability data for clients; it does not grant capabilities and
does not replace run trace.

The host is the source of truth. Clients should not reconstruct this response by
scanning files or interpreting local config.

**Payload**

| Field       | Type   | Required | Notes                             |
| ----------- | ------ | -------- | --------------------------------- |
| `sessionId` | string | no       | Reserved for future scoped views. |

**Response result**

```json
{
  "tools": [{ "name": "read_file", "risk": "safe" }],
  "skills": {
    "indexed": [
      {
        "name": "reviewer",
        "sourcePath": ".sparkwright/skills/reviewer/SKILL.md"
      }
    ],
    "loaded": [{ "name": "reviewer", "selectionReason": "Matched goal." }]
  },
  "mcp": { "statuses": [] },
  "agents": { "profiles": [{ "id": "main", "mode": "primary" }] }
}
```

---

## Event kinds

### `host.ready`

Sent exactly once, immediately after the handshake response. Subsequent
clients ignoring it should not break.

| Field             | Type     | Notes                                |
| ----------------- | -------- | ------------------------------------ |
| `protocolVersion` | string   | Host's spoken version.               |
| `host.name`       | string   |                                      |
| `host.version`    | string   |                                      |
| `capabilities`    | string[] | Optional features the host supports. |

### `host.log`

Out-of-band host log lines (captured stderr, info, warn, error).
Clients should display these in a side panel, never as agent output.

| Field    | Type   | Notes                                                |
| -------- | ------ | ---------------------------------------------------- |
| `level`  | enum   | `stdout` \| `stderr` \| `info` \| `warn` \| `error`. |
| `line`   | string | Single line of text.                                 |
| `source` | string | Optional (e.g. `tool:bash`).                         |

### `run.event`

Wraps a single `SparkwrightEvent` (see
[`schemas/event.schema.json`](../../schemas/event.schema.json)). Clients
that care about a strict event subset may filter on `event.type`.

| Field   | Type   | Notes                        |
| ------- | ------ | ---------------------------- |
| `runId` | string |                              |
| `event` | object | Verbatim `SparkwrightEvent`. |

High-frequency events (e.g. `model.stream.chunk`) **may** be coalesced
by the host into bursts before sending, to bound bandwidth. Coalescing
must preserve event order and may not drop events; only batching is
allowed.

### `approval.requested`

A run is paused waiting for human decision.

| Field        | Type   | Notes                                            |
| ------------ | ------ | ------------------------------------------------ |
| `runId`      | string |                                                  |
| `approvalId` | string | Used in `approval.resolve`.                      |
| `action`     | string | Stable identifier (e.g. `workspace.write`).      |
| `summary`    | string | Human-readable one-liner.                        |
| `details`    | object | Action-specific (e.g. `{ path, reason, diff }`). |

### `run.completed`

Terminal event for a core run that reached a final state. `state` may be
`completed`, `failed`, or `cancelled`; host/runtime protocol errors are reported
with `run.failed` instead.

| Field         | Type   | Notes                                                           |
| ------------- | ------ | --------------------------------------------------------------- |
| `runId`       | string |                                                                 |
| `state`       | string | Final RunState.                                                 |
| `stopReason`  | string | Optional. `manual_cancelled` for user-cancelled.                |
| `outcome`     | object | Optional structured non-clean completion summary.                |
| `failure`     | object | Optional structured cause for `failed` or `cancelled` states.   |
| `todoHandoff` | object | Optional unfinished-todo handoff reason and message.            |

`failure` uses `{ category, code, message, retryable, metadata }`. Providers may
include model-specific details such as HTTP status, timeout kind, or retryability
inside `metadata.modelError`; clients should surface the message/code and treat
unknown metadata as diagnostic context.

### `run.failed`

Terminal event for a host/runtime protocol error before a core run can finish
normally.

| Field   | Type          |
| ------- | ------------- |
| `runId` | string        |
| `error` | ProtocolError |

---

## Error codes

| Code                        | When                                                          |
| --------------------------- | ------------------------------------------------------------- |
| `protocol_version_mismatch` | Handshake major version differs, or request before handshake. |
| `unknown_kind`              | Request or event kind not in the v1.0 enum.                   |
| `invalid_payload`           | Payload fails schema validation.                              |
| `run_not_found`             | `runId` is unknown or already terminal.                       |
| `approval_not_found`        | `approvalId` is unknown or already resolved.                  |
| `session_not_found`         | `sessionId` does not exist on disk.                           |
| `internal_error`            | Anything else. Host should log details to `host.log`.         |

---

## Versioning policy

- The protocol is `MAJOR.MINOR`, declared in `handshake.protocolVersion`
  and `host.ready.protocolVersion`. Patch versions are not used.
- **Within a major (v1.x)**: fields may be **added** to existing
  payloads; new kinds may be added. Fields are never renamed, removed,
  or repurposed. Enums are only extended. Clients ignore unknown fields
  and enum values they do not understand.
- **Across a major (v1 → v2)**: any breaking change. Hosts and clients
  on different majors refuse to connect.
- Every change to the protocol must:
  1. Update [`schemas/host-message.schema.json`](../../schemas/host-message.schema.json).
  2. Add or update a fixture under `schemas/fixtures/host-message.*.json`.
  3. Add an entry to [`HOST_PROTOCOL_CHANGELOG.md`](./HOST_PROTOCOL_CHANGELOG.md).
  4. Pass `npm run schema:check`.

---

## Reference implementation

- **Host:** [`@sparkwright/host`](../../packages/host) — `sparkwright host` /
  `sparkwright-host` bin. WS + stdio transports.
- **Protocol types:** [`@sparkwright/protocol`](../../packages/protocol) —
  TypeScript types mirroring this schema. Zero runtime code; no
  dependency on the runtime.
- **Isomorphic client:** [`@sparkwright/sdk-core`](../../packages/sdk-core)
  — transport-agnostic `Client` class. Browser-safe (no Node imports).
- **Node client:** [`@sparkwright/sdk-node`](../../packages/sdk-node) —
  adds spawn (stdio) and `ws` (WebSocket) transports plus a
  `createClient` factory that auto-resolves between them based on
  `SPARKWRIGHT_HOST_URL`.
- **Browser client:** [`@sparkwright/sdk-browser`](../../packages/sdk-browser)
  — uses native `globalThis.WebSocket`. Pure ESM, `"sideEffects": false`.
- **First client:** [`@sparkwright/tui`](../../packages/tui) — drives runs
  through `@sparkwright/sdk-node`. Does not import core directly.

## Building a non-TypeScript client

Third-party clients (Rust, Go, Python TUI, IDE plugins, …) consume only
the wire protocol. The minimal path:

1. Start a host: `sparkwright host --port 7320`.
2. Open a WebSocket to `ws://localhost:7320`.
3. Send a `handshake` request with `protocolVersion: "1.0"`.
4. Listen for the `response` (matching `id`) and the subsequent
   `host.ready` event.
5. Send `run.start` and stream `run.event` events; resolve any
   `approval.requested` event by sending back `approval.resolve`.

The wire format is plain JSON; no language-specific wrappers are
needed. Validate messages against
[`schemas/host-message.schema.json`](../../schemas/host-message.schema.json)
using your language's standard JSON Schema validator.
