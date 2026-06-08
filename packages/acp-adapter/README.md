# @sparkwright/acp-adapter

Experimental Agent Client Protocol (ACP) agent-server adapter for
Sparkwright.

The adapter exposes Sparkwright as an ACP-compatible coding agent while keeping
the existing Sparkwright host runtime in charge of run lifecycle, policy,
approval, workspace writes, artifacts, and trace.

## CLI

```bash
sparkwright acp --workspace .
```

The command speaks ACP JSON-RPC over stdio. It is intended for local editors
and ACP clients that launch an agent subprocess.

## Boundary

ACP is an edge protocol here. This package maps ACP sessions, prompts,
permission requests, and updates onto `@sparkwright/host` primitives. It does
not bypass SparkWright policy or approval, and it does not create a second
internal run loop.

## External Workers

`@sparkwright/acp-client-adapter` connects SparkWright to another
ACP-compatible coding agent process:

```ts
import { ExternalAcpWorker } from "@sparkwright/acp-client-adapter";

const worker = new ExternalAcpWorker({
  command: "codex",
  args: ["acp"],
});

const result = await worker.run({
  cwd: "/path/to/project",
  goal: "Fix the failing test and summarize the patch.",
});
```

`@sparkwright/acp-adapter` re-exports the client worker helpers for
convenience, but host integrations should depend on the client package to keep
the dependency graph acyclic.
