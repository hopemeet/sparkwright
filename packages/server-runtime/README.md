# @sparkwright/server-runtime

Transport-neutral backend coordination for SparkWright.

`ExecutionLaneCoordinator` is the canonical Host scheduling primitive. It
coordinates opaque execution drivers and does not own Core, Workflow, Task,
Agent, workspace lease, or protocol event state.

The package also exports the process-local in-flight command dispatcher and the
durable Workflow service, supervisor, and channel coordinators. Durable command
and workflow truth remains in agent-runtime storage and journals; the
coordinators do not create a second state model.

The retired `ConnectionHub`, `ApprovalBroker`, `RunManager`, `SessionManager`,
`ServerCapabilityRegistry`, `createServerRuntime`, and
`DurableCommandDispatcher` compatibility APIs are no longer exported.
