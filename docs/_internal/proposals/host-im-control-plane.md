# Host-owned IM control plane

Status: implementation contract for P5 (single process, non-durable control state)

## Boundary

Ordinary IM sessions use one Host-owned control path. The IM gateway verifies
the platform webhook/poll response, converts it to bounded claims, formats
outbound messages, deduplicates transport message ids, and records delivery
attempts. It does not own active execution, lane queue, run target, approval
routing, or session binding policy.

Workflow actor channels keep their existing durable
`WorkflowChannelBinding`/control-inbox path. They are not migrated into the
ordinary live interaction map.

## Principal and claims

- Host creates an immutable connection principal from transport/auth
  configuration before handshake. The configured single bearer credential maps
  to a stable non-secret server-side credential-slot id; unauthenticated
  transports receive only a connection-scoped principal. Handshake contributes
  frozen client type/display metadata and cannot change identity. A request
  cannot supply a principal id, `authenticatedBy`, `system`, or a
  trusted/verified flag.
- Gateway supplies only platform, channel/chat, optional thread, and platform
  user claims. Host treats those as untrusted bounded strings and matches them
  byte-for-byte against a Host binding.
- `CommandSource`-style metadata is attribution and reply routing only. It does
  not grant permissions.

## Binding

A Host binding contains a generated binding id, session id, exact principal,
platform/chat/thread/user subject, explicit permissions, creation/expiry, and
revocation state. Permissions are `message`, `inspect`, `approve`,
`cancel_execution`, and `cancel_lane`.

Self-binding is disabled by default and always requires an authenticated
transport principal. An operator may explicitly enable it for a trusted gateway
connection; even then Host applies the authenticated-only client-name allowlist
and intersects requested permissions
with the configured ceiling and rejects attempts to bind another principal.
Host assigns the session for every new self-binding. A reconnect may echo a
session id only when the same exact principal and platform/chat/thread/user
subject already has that live binding; a bare session id is never authority to
create a new binding or join another binding's execution/outbox.
Revoked or expired bindings never authorize dispatch, subscription, approval,
inspection, or cancellation.

## Dispatch and retention

- Message dispatch first performs atomic injection into the active execution.
  A closed execution becomes a new lane command; there is no message merging.
- Session lane scheduling remains the server-runtime coordinator's ownership.
- A connection may subscribe only through an authorized exact binding. Session
  retention starts only after subscription succeeds.
- A subscribed execution may survive the initiating connection. Its events are
  projected into a bounded Host outbox; this projection is not a second Core
  canonical event log.
- Outbox entries have stable delivery keys. Acknowledgement advances delivery
  state; reconnect replays unacknowledged entries. Overflow emits an explicit
  diagnostic entry before dropping the oldest projection.
- With no live subscription, valid binding, or finite approval/retention
  deadline, an execution is cancelled instead of occupying capacity forever.

## Approval

Host indexes `approvalId -> executionId/sessionId/initiatingPrincipal`. Only the
initiating principal or a bound principal with `approve` may resolve it. The
first valid resolution wins; later resolutions receive a conflict. Approval
payloads are visible only through an authorized subscription. Live approval
timeouts remain finite and free lane capacity. Workflow durable approvals do
not enter this index.

## Delivery and failure

Gateway delivery failure records an attempt and leaves the Host delivery
unacknowledged for replay; it cannot change execution terminal state. Duplicate
inbound platform messages are discarded by the Gateway transport dedupe before
Host dispatch.

## Current durability statement

P5 bindings, subscriptions, ordinary-session outbox cursors, accepted lane
commands, and approval routing are process memory. A Host restart loses them;
an operator must rebind/reconnect and in-flight ordinary executions are not
adopted. Gateway transport dedupe/attempt facts and Workflow durable channels
retain their existing file-backed behavior. This phase does not claim durable
execution recovery or multi-Host availability.

The current single bearer token represents one shared credential/principal.
Multiple independently authorized gateways require future credential-to-
principal configuration; client names must not be used to simulate that split.
