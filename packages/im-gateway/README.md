# @sparkwright/im-gateway

IM gateway for Sparkwright. The package contains the shared daemon,
routing store, run/approval bridge, and a Telegram adapter. Slack, Discord, and
other platforms should be added as adapters instead of standalone gateway
examples.

## Quick Start

Start a Sparkwright host with WebSocket enabled, then configure the gateway:

```sh
sparkwright-im-gateway setup \
  --telegram-token "$TELEGRAM_BOT_TOKEN" \
  --host-url ws://127.0.0.1:7320
```

Run the daemon:

```sh
sparkwright-im-gateway run
```

The gateway stores config in `~/.sparkwright/im-gateway.json` and runtime
routing state in `~/.sparkwright/im-gateway/state.json`.

## Current Scope

- Telegram inbound messages start Sparkwright runs.
- Telegram chat/topic identity maps to stable Sparkwright `sessionId`s.
- Run completion and failure events are pushed back to Telegram.
- Approval requests are delivered as Telegram inline buttons.
- Messages sent while a session has an active run are injected into that run
  through host protocol v1.1. If the connected host is older or injection fails,
  the message falls back to a per-session FIFO queue.
