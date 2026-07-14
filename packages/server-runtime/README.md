# @sparkwright/server-runtime

Transport-neutral backend coordination for SparkWright. `ExecutionLaneCoordinator`
is the canonical Host scheduling primitive: it coordinates opaque execution
drivers and does not own Core, Workflow, Task, Agent, workspace lease, or
protocol event state.

The following older convenience APIs remain as deprecated compatibility exports
only. HostService and the execution-lane path do not use them:

- `RunManager` for creating, starting, cancelling, and looking up core `RunHandle`s.
- `SessionManager` for creating sessions and associating runs with them.
- `ConnectionHub` for in-process event subscriptions and protocol fan-out.
- `ApprovalBroker` for bridging core `InteractionChannel` approvals, questions, and notifications to subscribers.
- `ServerCapabilityRegistry` for registering model, tool, policy, workspace, context, and custom runtime capabilities.

`InFlightCommandDispatcher` only coalesces concurrent calls while the process is
alive. `DurableCommandDispatcher` is a deprecated naming alias; neither API is a
durable journal or restart-recovery mechanism.

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
