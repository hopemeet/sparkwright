# @sparkwright/acp-client-adapter

Experimental Agent Client Protocol (ACP) client-side worker adapter for
SparkWright.

Use this package when SparkWright needs to call another ACP-compatible coding
agent process, such as a local coding assistant exposed over ACP stdio.

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

The default client capabilities intentionally do not expose file-system writes
or terminals to the external worker. Hosts should add those only through a
governed SparkWright policy and approval bridge.
