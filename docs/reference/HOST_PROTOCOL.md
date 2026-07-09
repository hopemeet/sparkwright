# SparkWright Host Protocol

This is a reference contract. If you are new to SparkWright, start with
[the documentation map](../README.md) or the [User Manual](../guides/USER_MANUAL.md).

**Version:** 1.4
**Schema:** [`schemas/host-message.schema.json`](../../schemas/host-message.schema.json)
**Changelog:** [`HOST_PROTOCOL_CHANGELOG.md`](./HOST_PROTOCOL_CHANGELOG.md)

This document specifies the wire protocol spoken between a **SparkWright
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

| Field                  | Type                      | Required | Notes                                                                                                                                                                                                                         |
| ---------------------- | ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal`                 | string                    | yes      | User goal text.                                                                                                                                                                                                               |
| `input.parts`          | array                     | no       | Extensible content parts for the same user turn. Supported part types are `text`, `image`, `file`, and `audio`; image/file/audio parts carry `data` (base64) or `uri`, plus optional `mediaType`, `name`, and `metadata`.     |
| `sessionId`            | string                    | no       | Existing session to write into; host creates a new one if omitted.                                                                                                                                                            |
| `targetPath`           | string                    | no       | Workspace-relative target path the run should focus on when applicable.                                                                                                                                                       |
| `confidentialPaths`    | string[]                  | no       | Additional workspace-relative paths/globs whose contents this run must not read.                                                                                                                                              |
| `confidentialDefaults` | boolean                   | no       | Whether built-in conservative confidential path defaults are included; defaults to `true`.                                                                                                                                    |
| `shouldWrite`          | boolean                   | no       | Whether this run is allowed to request workspace writes.                                                                                                                                                                      |
| `model`                | string                    | no       | Model reference in `provider/model` form, or the reserved `deterministic`.                                                                                                                                                    |
| `workflow`             | string                    | no       | Workflow asset name to instantiate for this run. Omit it to keep ordinary host-run behavior.                                                                                                                                  |
| `accessMode`           | string                    | no       | Preferred high-level run autonomy: `read-only`, `ask`, `accept-edits`, or `bypass`. When present, the host compiles it to `permissionMode` and `shouldWrite`; conflicting legacy fields are ignored and recorded in metadata. |
| `permissionMode`       | string                    | no       | `plan`, `default`, `accept_edits`, `dont_ask`, or `bypass_permissions`.                                                                                                                                                       |
| `traceLevel`           | `"standard"` \| `"debug"` | no       | Trace persistence detail level; defaults to `standard`.                                                                                                                                                                       |
| `metadata`             | object                    | no       | Free-form, propagated to runRecord.                                                                                                                                                                                           |

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

| Field         | Type   | Required | Notes                                                                                                 |
| ------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------- |
| `runId`       | string | yes      | Active run to receive the message.                                                                    |
| `content`     | string | yes      | User message to enqueue into the run loop.                                                            |
| `input.parts` | array  | no       | Additional content parts for the same injected user message; shape matches `run.start` `input.parts`. |
| `metadata`    | object | no       | Free-form source/routing metadata for the trace.                                                      |

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

| Field                  | Type     | Required | Notes                                                                                                                                                                                                                         |
| ---------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`                | string   | yes      | Prior run id to resume.                                                                                                                                                                                                       |
| `sessionId`            | string   | no       | Session scope used to disambiguate where the prior run lives.                                                                                                                                                                 |
| `targetPath`           | string   | no       | Workspace-relative target path the resumed run should focus on if needed.                                                                                                                                                     |
| `confidentialPaths`    | string[] | no       | Additional workspace-relative paths/globs whose contents this resumed run must not read.                                                                                                                                      |
| `confidentialDefaults` | boolean  | no       | Whether built-in conservative confidential path defaults are included; defaults to `true`.                                                                                                                                    |
| `shouldWrite`          | boolean  | no       | Whether this resumed run is allowed to request workspace writes.                                                                                                                                                              |
| `fromTrace`            | boolean  | no       | Reconstruct a best-effort checkpoint from `trace.jsonl` if needed.                                                                                                                                                            |
| `force`                | boolean  | no       | Allow resuming checkpoints that are terminal or normally refused.                                                                                                                                                             |
| `model`                | string   | no       | Model reference in `provider/model` form, or the reserved `deterministic`.                                                                                                                                                    |
| `accessMode`           | string   | no       | Preferred high-level run autonomy: `read-only`, `ask`, `accept-edits`, or `bypass`. When present, the host compiles it to `permissionMode` and `shouldWrite`; conflicting legacy fields are ignored and recorded in metadata. |
| `permissionMode`       | string   | no       | `plan`, `default`, `accept_edits`, `dont_ask`, or `bypass_permissions`.                                                                                                                                                       |
| `traceLevel`           | string   | no       | `standard` or `debug`; defaults to `standard`.                                                                                                                                                                                |
| `metadata`             | object   | no       | Free-form metadata propagated to the resumed run record and trace context.                                                                                                                                                    |

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

### `workflow.list`

List durable workflow-run snapshots. Fresh workflow records are stored under the
workspace state root at `.sparkwright/workflow-runs/<workflowRunId>.json` and
retain their `sessionId` in the record. Hosts also read legacy session-root
records from `<sessionRoot>/<sessionId>/workflow-runs/` for compatibility;
malformed records are skipped and reported in `invalidEntries` instead of
failing the list.

Hosts advertise `workflow.list` in `host.ready.capabilities` once durable
workflow storage is available.

**Payload**

| Field       | Type                                                                       | Required | Notes                                                                              |
| ----------- | -------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `sessionId` | string                                                                     | no       | Filter workspace records by `record.sessionId` and legacy records by session path. |
| `status`    | `"running"` \| `"waiting"` \| `"completed"` \| `"failed"` \| `"cancelled"` | no       | Filter by workflow-run status.                                                     |
| `limit`     | integer 1..200                                                             | no       | Maximum snapshots to return after newest-first sort.                               |

**Response result**

```json
{
  "workflows": [
    {
      "id": "workflow_abc",
      "sessionId": "session_123",
      "status": "running",
      "assetName": "bugfix",
      "version": "1.0.0",
      "contentHash": "sha256:...",
      "activeRunId": "run_456",
      "runIds": ["run_456"],
      "currentNodeId": "reproduce",
      "attempts": { "reproduce": 1 },
      "latestVerdict": {
        "nodeId": "reproduce",
        "attempt": 1,
        "verdict": { "status": "passed", "reason": "command_passed" },
        "at": "2026-07-04T00:00:01.000Z"
      },
      "resume": { "verifyOnResume": true },
      "createdAt": "2026-07-04T00:00:00.000Z",
      "updatedAt": "2026-07-04T00:00:01.000Z"
    }
  ],
  "invalidEntries": [
    {
      "path": "/workspace/.sparkwright/sessions/session_123/workflow-runs/bad.json",
      "code": "parse_error",
      "reason": "unsupported workflow run schemaVersion"
    }
  ]
}
```

`latestVerdict` is a bounded presentation projection of the newest durable
workflow verdict log entry. Clients use it for job/session status views; the
full verdict history remains in the workflow-run record.

`waiting` is a terminal-resistant status value with an inline `wait` object
whose `kind` is one of `input`, `task`, or `approval`. P3 human nodes are the
first producer: the host persists `status:"waiting"` plus the `wait` payload,
emits a reliable workflow actor notification, and releases the workflow lease.
`workflow.resume` consumes `input` waits by recording an `input` store event,
clearing `wait`, and continuing from the next node.

### `workflow.resume`

Adopt a non-terminal durable workflow run and start a new host run from its
pinned workflow definition snapshot. The host does not reload the live asset
for execution; it resumes from the record's pinned `{assetName, version,
contentHash}` and `definitionSnapshot`, then appends the new `runId` to the
record.

Hosts advertise `workflow.resume` in `host.ready.capabilities` once durable
workflow resume is available.

**Payload**

| Field                  | Type     | Required | Notes                                                                                                                                                                                                                         |
| ---------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowRunId`        | string   | yes      | Durable workflow instance id, e.g. `workflow_abc`.                                                                                                                                                                            |
| `sessionId`            | string   | no       | Session scope used to disambiguate where the workflow record lives.                                                                                                                                                           |
| `targetPath`           | string   | no       | Workspace-relative target path the resumed run should focus on if needed.                                                                                                                                                     |
| `confidentialPaths`    | string[] | no       | Additional workspace-relative paths/globs whose contents this resumed workflow run must not read.                                                                                                                             |
| `confidentialDefaults` | boolean  | no       | Whether built-in conservative confidential path defaults are included; defaults to `true`.                                                                                                                                    |
| `shouldWrite`          | boolean  | no       | Whether this resumed run is allowed to request workspace writes.                                                                                                                                                              |
| `model`                | string   | no       | Model reference in `provider/model` form, or the reserved `deterministic`.                                                                                                                                                    |
| `accessMode`           | string   | no       | Preferred high-level run autonomy: `read-only`, `ask`, `accept-edits`, or `bypass`. When present, the host compiles it to `permissionMode` and `shouldWrite`; conflicting legacy fields are ignored and recorded in metadata. |
| `permissionMode`       | string   | no       | `plan`, `default`, `accept_edits`, `dont_ask`, or `bypass_permissions`.                                                                                                                                                       |
| `traceLevel`           | string   | no       | `standard` or `debug`; defaults to `standard`.                                                                                                                                                                                |
| `metadata`             | object   | no       | Free-form metadata propagated to the resumed run record and trace context.                                                                                                                                                    |

**Response result**

| Field           | Type   | Notes                                             |
| --------------- | ------ | ------------------------------------------------- |
| `runId`         | string | Active run id for the resumed workflow execution. |
| `workflowRunId` | string | Durable workflow instance id from the request.    |
| `sessionId`     | string | Session recorded on the durable workflow run.     |

The host obtains a single-writer file lease before resuming. If another writer
already adopted the record, if the record is terminal (`completed`, `failed`, or
`cancelled`), or if the pinned definition snapshot is missing, the host responds
with `invalid_payload`. If the workflow record cannot be found, the host
responds with `run_not_found`.

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

| Field          | Type                       | Required | Notes                                                                 |
| -------------- | -------------------------- | -------- | --------------------------------------------------------------------- |
| `approvalId`   | string                     | yes      | From `approval.requested`.                                            |
| `decision`     | `"approved"` \| `"denied"` | yes      |                                                                       |
| `message`      | string                     | no       | Surfaced in the run trace.                                            |
| `autoApproved` | boolean                    | no       | Marks policy/flag-driven approvals without requiring message parsing. |

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

| Field        | Type    | Required | Notes                                                                                            |
| ------------ | ------- | -------- | ------------------------------------------------------------------------------------------------ |
| `sessionId`  | string  | yes      | Session id.                                                                                      |
| `compaction` | boolean | no       | Include a compact-artifact/session-event audit view. The compacted summary body is not returned. |

**Response result**

```json
{
  "sessionId": "session_abc",
  "summary": { "eventCount": 12 },
  "consistency": { "ok": true, "findings": [] },
  "timeline": { "phases": [] },
  "compaction": {
    "status": "compacted",
    "artifact": {
      "path": "/workspace/.sparkwright/sessions/session_abc/compact.json",
      "createdAt": "2026-06-22T00:00:00.000Z",
      "throughRunId": "run_123",
      "compactedRunCount": 3,
      "sourceRunIds": ["run_001", "run_002", "run_123"],
      "originalCharCount": 12000,
      "summaryCharCount": 2400,
      "freedChars": 9600,
      "warningCodes": ["SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW"]
    },
    "latestEvent": {
      "sequence": 7,
      "type": "session.compaction.completed",
      "throughRunId": "run_123",
      "artifactPath": "/workspace/.sparkwright/sessions/session_abc/compact.json",
      "freedChars": 9600
    },
    "events": [],
    "consistency": {
      "ok": true,
      "artifactMatchesLatestCompletedEvent": true,
      "findings": []
    }
  }
}
```

`compaction` is omitted unless requested. Its `status` is one of
`not_compacted`, `compacted`, `skipped`, `artifact_only`, `event_only`, or
`stale_artifact`. The report is derived from `compact.json` and
`events.jsonl`; it may include measurement, warning codes, reason metadata, and
summary fingerprint metadata, but never includes `compact.json.content`.

### `session.compact`

Write a host-owned compact context artifact for a persisted session. The
canonical transcript and trace remain intact; future runs in the same session
may seed prior context from the compact artifact plus later un-compacted turns.

**Payload**

| Field       | Type    | Required | Notes                                                                                                                                                                      |
| ----------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId` | string  | yes      | Session id.                                                                                                                                                                |
| `reason`    | string  | no       | Optional caller label for diagnostics.                                                                                                                                     |
| `llm`       | boolean | no       | Explicitly requests the Tier 3 summarizer path. Provider/scripted model refs use model-backed summarization; deterministic refs use the preview path and return a warning. |

**Response result**

```json
{
  "sessionId": "session_abc",
  "compactedRunCount": 3,
  "throughRunId": "run_123",
  "originalCharCount": 12000,
  "summaryCharCount": 2400,
  "freedChars": 9600,
  "measurement": {
    "sourceRunCount": 3,
    "savingsRatio": 0.8,
    "freedByTier": {
      "dedup": 0,
      "extract": 1200,
      "evict": 0,
      "summarize": 8400
    },
    "regime": "density_bound",
    "signalCount": 8
  },
  "artifactPath": "/workspace/.sparkwright/sessions/session_abc/compact.json"
}
```

`skippedReason` and `warnings` are omitted when there is nothing to report.
Successful compaction writes a `session-compact.v2` artifact whose top-level
fields include `sourceRunIds`, `throughRunId`, `originalCharCount`,
`summaryCharCount`, and `freedChars`; stage diagnostics live under `metadata`.
Model-backed Tier 3 summaries also record `metadata.summaryFingerprint`
(`modelId`, prompt/oracle versions, input hash, source run ids, through run, and
effective budget) plus `metadata.measurement`.
On the normal path, every successful `session.compact` request appends a
session-local event to `events.jsonl`: `session.compaction.completed` when an
artifact was written, or `session.compaction.skipped` when no artifact was
written. The event payload records counts, `freedChars`, `measurement`,
`artifactPath`, optional `skippedReason`, and warning codes; it does not contain
compacted summary content. If this audit event cannot be written, the compact
response still reflects the compaction result and includes a warning.
When compaction is unnecessary or best-effort compaction cannot safely persist
an artifact, the response remains `ok: true`, `artifactPath` is `null`,
`freedChars` is `0`, and `skippedReason` explains why.

```json
{
  "sessionId": "session_abc",
  "compactedRunCount": 0,
  "throughRunId": null,
  "originalCharCount": 900,
  "summaryCharCount": 900,
  "freedChars": 0,
  "skippedReason": "no_savings",
  "artifactPath": null
}
```

### `task.list`

List durable background tasks known to the host task store. This is a
workspace-scoped snapshot/polling API; clients that need a run-local view should
pass `parentRunId`. It does not subscribe to live output.

**Payload**

| Field         | Type           | Required | Notes                                                        |
| ------------- | -------------- | -------- | ------------------------------------------------------------ |
| `status`      | string         | no       | `pending`, `running`, `completed`, `failed`, or `cancelled`. |
| `kind`        | string         | no       | Filter by task kind.                                         |
| `parentRunId` | string         | no       | Filter to tasks spawned by a run.                            |
| `limit`       | integer 1..200 | no       | Default 50.                                                  |

**Response result:** `{ "tasks": TaskRecordSnapshot[] }`.

### `task.get`

Fetch one durable background task record.

**Payload**

| Field    | Type   | Required |
| -------- | ------ | -------- |
| `taskId` | string | yes      |

**Response result:** a `TaskRecordSnapshot`. Unknown ids return
`task_not_found`.

### `task.output`

Fetch buffered output chunks for a background task. The response drains the
currently buffered snapshot from `fromSequence` and returns immediately; clients
poll again with `nextSequence` to follow new output.

**Payload**

| Field          | Type            | Required | Notes        |
| -------------- | --------------- | -------- | ------------ |
| `taskId`       | string          | yes      | Task id.     |
| `fromSequence` | integer >= 0    | no       | Default 0.   |
| `maxChunks`    | integer 1..1000 | no       | Default 200. |

**Response result**

```json
{
  "taskId": "task_abc",
  "chunks": [
    {
      "taskId": "task_abc",
      "sequence": 0,
      "timestamp": "2026-06-30T00:00:00.000Z",
      "channel": "stdout",
      "data": "line\n"
    }
  ],
  "nextSequence": 1,
  "complete": false,
  "status": "running",
  "stalled": false
}
```

Unknown ids return `task_not_found`.

### `task.stop`

Request cancellation of a live background task. Durable historical task records
can be inspected, but a host can only stop tasks for which the current process
still owns a live handle.

**Payload**

| Field    | Type   | Required |
| -------- | ------ | -------- |
| `taskId` | string | yes      |

**Response result:** `{ "cancelled": boolean, "status"?: string }`. Unknown ids
return `task_not_found`.

### `task.join`

Mark a task as awaited from the host/client side. This is the TUI/on-demand
join control surface; it does not use model-facing `task(...)` JSON.

**Payload**

| Field    | Type   | Required |
| -------- | ------ | -------- |
| `taskId` | string | yes      |

**Response result:** `{ "taskId": string, "awaited": true, "status": string }`.
Unknown ids return `task_not_found`.

### `task.promote`

Request manual promotion of an in-flight foreground task. If the task is
currently blocked inside a foreground `task_create` wait, the wait resolves as a
promoted ticket; otherwise the task is marked awaited and the response reports
`promoted: false`.

**Payload**

| Field    | Type   | Required |
| -------- | ------ | -------- |
| `taskId` | string | yes      |

**Response result:**
`{ "taskId": string, "promoted": boolean, "awaited": boolean, "status": string }`.
Unknown ids return `task_not_found`.

### `capability.inspect`

Return the host-authored capability snapshot known to this connection. This is
read-only observability data for clients; it does not grant capabilities and
does not replace run trace.

The host is the source of truth. Clients should not reconstruct this response by
scanning files or interpreting local config.

**Payload**

| Field             | Type    | Required | Notes                                                                                            |
| ----------------- | ------- | -------- | ------------------------------------------------------------------------------------------------ |
| `sessionId`       | string  | no       | Optional session scope for clients that tie diagnostics to an active interaction.                |
| `model`           | string  | no       | Runtime model to inspect, using `provider/model` or `deterministic`; omitted means host default. |
| `accessMode`      | string  | no       | High-level run autonomy preset used to scope diagnostics. Preferred over legacy fields.          |
| `backgroundTasks` | string  | no       | Foreground/background task policy used to scope diagnostics.                                     |
| `permissionMode`  | string  | no       | Legacy approval mode used when `accessMode` is absent.                                           |
| `shouldWrite`     | boolean | no       | Legacy workspace-write flag used when `accessMode` is absent.                                    |

**Response result**

```json
{
  "access": {
    "accessMode": "ask",
    "permissionMode": "default",
    "shouldWrite": true,
    "backgroundTasks": "enabled"
  },
  "model": {
    "modelRef": "openai/gpt-5.4-mini",
    "providerKey": "openai",
    "modelId": "gpt-5.4-mini",
    "adapterId": "openai:gpt-5.4-mini",
    "pricing": {
      "source": "unavailable",
      "costStatus": "unavailable",
      "costUnavailableReason": "missing_pricing",
      "warning": "No pricing configured for model \"openai/gpt-5.4-mini\"; cost estimates will be unavailable. Add a provider model cost block to enable cost reporting."
    }
  },
  "tools": [{ "name": "read", "risk": "safe" }],
  "skills": {
    "indexed": [
      {
        "name": "reviewer",
        "sourcePath": ".sparkwright/skills/reviewer/SKILL.md"
      }
    ],
    "loaded": [{ "name": "reviewer", "selectionReason": "Matched goal." }],
    "inlineShell": {
      "enabled": true,
      "timeoutMs": 10000,
      "maxOutputChars": 4000,
      "sandboxMode": "enforce",
      "writePolicy": "no-write",
      "failClosed": true
    }
  },
  "mcp": { "statuses": [] },
  "agents": {
    "profiles": [{ "id": "main", "mode": "primary" }],
    "delegateTools": [
      {
        "toolName": "delegate_external_reviewer",
        "profileId": "external_reviewer",
        "protocol": "external_command",
        "risk": "risky",
        "requiresApproval": true,
        "approvalRequiredUnderCurrentRun": true,
        "approvalReasons": [
          "tool.risk:risky",
          "tool.requiresApproval:true",
          "delegate.requiresApproval:true"
        ],
        "approvalRunOptions": { "shouldWrite": false },
        "forbidNesting": true,
        "sideEffects": ["external"],
        "workspaceAccess": "none",
        "shellAccess": false,
        "processSpawn": true,
        "command": "agent-cli",
        "args": ["run", "{{goal}}"]
      },
      {
        "toolName": "delegate_writer",
        "profileId": "writer",
        "protocol": "in_process",
        "model": "anthropic/claude",
        "risk": "safe",
        "requiresApproval": false,
        "approvalRequiredUnderCurrentRun": false,
        "approvalReasons": [],
        "approvalRunOptions": { "shouldWrite": false },
        "forbidNesting": true,
        "sideEffects": ["model", "workspace"],
        "workspaceAccess": "read_write",
        "shellAccess": false,
        "processSpawn": false,
        "gatedByRunWrite": true
      }
    ]
  },
  "rules": {
    "workflow": [
      {
        "name": "verification:fast:test",
        "source": "verification",
        "lifecycle": "Stop",
        "matcher": "run-level invariant after workspace writes",
        "action": "invariant verifier command: npm test",
        "blockingPotential": false,
        "enabled": true,
        "active": true,
        "status": "active",
        "disableHint": "Set capabilities.verification.mode=off or remove this command from the selected profile."
      },
      {
        "name": "documented-command-check",
        "source": "builtin",
        "lifecycle": "Stop",
        "matcher": "write-enabled goals about verification, tests, handoff, release, docs, or documented commands",
        "action": "fail completed run when README documented commands reference missing workspace paths",
        "blockingPotential": false,
        "enabled": true,
        "active": false,
        "status": "available"
      }
    ]
  },
  "shell": {
    "foregroundTimeoutMs": 300000,
    "promotionAvailable": true,
    "sandbox": {
      "mode": "warn",
      "failIfUnavailable": false,
      "runtimeId": "platform",
      "platform": "darwin",
      "available": true,
      "networkMode": "deny",
      "filesystemIsolation": "deny-list-guard"
    }
  }
}
```

`workspaceAccess: "none"` means the external delegate is not handed the project
cwd or `{{workspaceRoot}}`. Use `"read_write"` only for explicitly trusted
delegates that should inspect or mutate the workspace directly.
Delegate summaries may include `model` when a profile declares a preferred
model; omitted means the delegate inherits the parent run model.
Delegate summaries may also include `routing`. When present, `keywords` echo the
profile's deterministic routing hints; after a run goal is evaluated,
`relevance`, `score`, `matchedKeywords`, and `reason` explain the sort-only
routing decision. `mode: "sort"` means no delegate was hidden.
When `capabilities.agents.enableParallelDelegates` is enabled, the opt-in
`delegate_parallel` fan-out surface appears as a regular tool summary in the
capability snapshot. Delegate summaries stay per-profile; parallel eligibility
is enforced by the tool at call time.
For `in_process` delegates, `workspaceAccess` reports the profile-selected
potential capability; `gatedByRunWrite: true` means the current run still needs
workspace writes enabled (for example CLI `--write`) before the delegate can use
workspace write or shell tools. In-process delegate spawn is `risk: "safe"` by
default because the child run enforces its own tool policies; set
`requiresApproval: true` on the delegate only when spawn itself needs approval.
`requiresApproval` is a legacy delegate-config echo. For audit/diagnostics, use
`approvalRequiredUnderCurrentRun`, `approvalReasons`, and `approvalRunOptions`;
those fields describe the runtime gate under the inspected run options rather
than promising an unconditional approval boolean.
Capability snapshots may include `rules.workflow` and `rules.events`,
host-authored inspection summaries for configured workflow hooks, verification
invariants, documented-command verifier rules, and non-blocking event
subscribers. These summaries are diagnostics only:
workflow-rule `lifecycle` uses the canonical workflow hook value,
event-rule `trigger` uses the configured event trigger, `blockingPotential`
describes whether the rule can block under its executor semantics, and `active`
reflects the inspected run context when the host has one. Event rules are
reported with `blockingPotential: false`.

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

| Field         | Type   | Notes                                                         |
| ------------- | ------ | ------------------------------------------------------------- |
| `runId`       | string |                                                               |
| `state`       | string | Final RunState.                                               |
| `stopReason`  | string | Optional. `manual_cancelled` for user-cancelled.              |
| `message`     | string | Optional final answer text for successful final-answer runs.  |
| `outcome`     | object | Optional structured non-clean completion summary.             |
| `failure`     | object | Optional structured cause for `failed` or `cancelled` states. |
| `todoHandoff` | object | Optional unfinished-todo handoff reason and message.          |

`failure` uses `{ category, code, message, retryable, metadata }`. Providers may
include model-specific details such as HTTP status, timeout kind, or retryability
inside `metadata.modelError`; clients should surface the message/code and treat
unknown metadata as diagnostic context.

### `run.failed`

Terminal event for a host/runtime protocol error before a core run can finish
normally.

| Field     | Type          | Notes                                                                 |
| --------- | ------------- | --------------------------------------------------------------------- |
| `runId`   | string        |                                                                       |
| `failure` | object        | Canonical `{ category, code, message, retryable, metadata }` failure. |
| `error`   | ProtocolError | Deprecated compatibility projection of `failure`.                     |

Clients should prefer `failure` for both `run.completed{state:"failed"}` and
`run.failed`. The compatibility `error` field remains present on `run.failed`
for older protocol clients.

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
