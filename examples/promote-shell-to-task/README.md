# promote-shell-to-task

End-to-end demo wiring three SparkWright pieces:

- **`@sparkwright/shell-tool`** — runs commands through a streaming
  `ExecutionEnvironment`, enforces a foreground deadline.
- **`@sparkwright/agent-runtime`** — `TaskManager` adopts the live process when
  the deadline fires; `InMemoryActorNotificationQueue` buffers terminal
  notifications for the agent loop.
- **`@sparkwright/core`** — provides the `LiveShellHandle` /
  `ShellStreamingResult` contracts the bridge depends on.

## What it shows

```
shell-tool ── onBackground ──▶ TaskManager.spawn (adopts LiveShellHandle)
                                          │
                                          ▼
                              terminal status reached
                                          │
                                          ▼
                          InMemoryActorNotificationQueue
                                          │
                                          ▼
                       agent loop drains on its next turn
```

- **Short command (`echo`)** completes in 5 ms, returns synchronously.
- **Long command (`sleep`)** exceeds the 30 ms foreground ceiling; the live
  process is **not killed** — it is handed to `TaskManager.spawn`, which
  drains stdout/stderr into the task store. The shell tool returns
  `{ promoted: true, taskId }`. When the task finishes, a terminal task actor
  notification lands in the queue.

## Run

```bash
npm install
npm run -w @sparkwright/example-promote-shell-to-task test
```

You will see three log blocks: the short command, the promoted long command,
and the delivered notification.

## How to port to a real host

The demo uses an in-process scripted environment so the example is
hermetic. To run real shells:

1. Implement `executeShellStreaming(request)` on your `ExecutionEnvironment`,
   returning a `LiveShellHandle` backed by `child_process.spawn` (stdout /
   stderr async iterables; `abort()` sends SIGTERM then SIGKILL).
2. Pass that environment to `createShellTool` along with
   `foregroundTimeoutMs: RECOMMENDED_FOREGROUND_TIMEOUT_MS` and the
   `onBackground` bridge shown in [`promote.ts`](./promote.ts).
3. Mount your `InMemoryActorNotificationQueue` (or a custom
   `ActorNotificationSink` + `ActorInbox`) into the agent loop so notifications are
   converted into the next turn's user-visible content.

## Closing the loop with `@sparkwright/streaming-runtime`

The demo uses non-consuming `waitUntilAvailable()` followed by `drain()` for
the smoke test.
In a real agent, hand the queue to `createStreamingRun` via the
`notificationSources` option — every turn drains pending notifications and
injects them as user-role context items before the model is invoked:

```ts
import { createStreamingRun } from "@sparkwright/streaming-runtime";

const queue = new InMemoryActorNotificationQueue();
const manager = new TaskManager({ notificationSink: queue /* ... */ });

const run = createStreamingRun({
  goal: "ship this PR",
  model,
  tools: [shellTool],
  notificationSources: [
    {
      drain: () =>
        queue.drain().map((n) => ({
          content: `<task-notification taskId="${n.source.id}" status="${n.type}">${n.payload.summary}</task-notification>`,
          source: { kind: "task-notification", uri: String(n.source.id) },
          metadata: {
            taskId: n.source.id,
            status: n.type,
            kind: n.payload.kind,
          },
        })),
    },
  ],
});
```

When a promoted shell task finishes, the next model turn sees the
`<task-notification>` block as if the user had typed it — no manual polling
required.
