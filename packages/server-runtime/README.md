# @sparkwright/server-runtime

Transport-neutral backend control plane helpers for SparkWright. The package is optional and has no HTTP framework dependency; hosts can adapt the protocol messages to WebSocket, SSE, IPC, queues, CLIs, or tests.

The initial surface provides:

- `RunManager` for creating, starting, cancelling, and looking up core `RunHandle`s.
- `SessionManager` for creating sessions and associating runs with them.
- `ConnectionHub` for in-process event subscriptions and protocol fan-out.
- `ApprovalBroker` for bridging core `InteractionChannel` approvals, questions, and notifications to subscribers.
- `ServerCapabilityRegistry` for registering model, tool, policy, workspace, context, and custom runtime capabilities.

## Sketch

```ts
import {
  RunManager,
  ConnectionHub,
  ApprovalBroker,
} from "@sparkwright/server-runtime";

const hub = new ConnectionHub();
const approvals = new ApprovalBroker({ hub });
const runs = new RunManager({ hub, approvalBroker: approvals });

const subscription = hub.subscribe(
  { eventTypes: ["run.completed"] },
  (message) => {
    console.log(message);
  },
);

const run = runs.createRun({
  goal: "Inspect the repo",
  model,
  interactionChannel: approvals.createInteractionChannel(),
});

void runs.startRun(run.record.id);

subscription.unsubscribe();
```

This package defines only SparkWright protocol envelopes around `@sparkwright/core` primitives. It does not copy or implement another product's control protocol.
