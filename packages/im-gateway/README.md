# @sparkwright/im-gateway

IM gateway for Sparkwright. The package contains the shared daemon, Host IM
control bridge, transport dedupe/delivery-attempt store, and a Telegram adapter.
Slack, Discord, and other platforms should be added as adapters instead of
standalone gateway examples.

## Quick Start

Start a Sparkwright host with WebSocket enabled and explicitly permit bounded
IM self-binding for the authenticated gateway:

```sh
sparkwright host --ws --auth-token "$SPARKWRIGHT_HOST_TOKEN" \
  --allow-im-self-binding
```

Then configure the gateway (the token may be supplied in the protected Host
URL or by the deployment's WebSocket auth proxy):

```sh
sparkwright-im-gateway setup \
  --telegram-token "$TELEGRAM_BOT_TOKEN" \
  --host-url ws://127.0.0.1:7320
```

Run the daemon:

```sh
sparkwright-im-gateway run
```

The gateway stores config in `~/.config/sparkwright/im-gateway.json` and only
transport message dedupe plus delivery-attempt facts in
`~/.local/state/sparkwright/im-gateway/state.json` by default.

## Current Scope

- Telegram inbound messages submit bounded platform claims to Host-owned exact
  session bindings and execution lanes.
- Host owns ordinary session ids, active executions, lane queues, approval
  routing, subscriptions, and the bounded replay outbox.
- Run events and approval requests are replayed with stable delivery keys;
  transport failure does not change execution outcome.
- Approval requests are delivered as Telegram inline buttons.
- Gateway retains platform verification, formatting, inbound dedupe, outbound
  delivery attempts, and the existing durable Workflow channel adapter.

Ordinary IM bindings/outbox cursors and accepted execution commands are
single-process memory in this phase. A Host restart requires reconnect/rebind;
there is no durable adoption or multi-Host availability claim.
