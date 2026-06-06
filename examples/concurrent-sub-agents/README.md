# concurrent-sub-agents

End-to-end demo of multi sub-agent fan-out using the four concurrency
primitives shipped by `@sparkwright/agent-runtime`:

- **`ConcurrencyCoordinator`** — declarative writes partitioning (glob).
- **`acquireWorktree`** — per-sub-agent git isolation + ff-only merge.
- **`createTodoTools`** — Leader single-writer todo file with 5-state machine.
- **`parseSubAgentResult` / `validateDeclaredWrites`** — structured JSON
  result protocol + writes audit.

## What it shows

```
Leader (primary run)
  │
  ├─ ConcurrencyCoordinator.acquire(taskId, writes)   ─── conflict? queue/reject
  ├─ acquireWorktree(...)                              ─── isolated working tree
  │     └─ child performs its work IN PARALLEL
  ├─ parseSubAgentResult(child.message)                ─── JSON, not LLM re-parse
  ├─ validateDeclaredWrites(declared, actual)          ─── audit the partition
  ├─ worktree.mergeBack()                              ─── ff-only (clean by design)
  └─ todoWrite([...])                                  ─── single-writer state file
```

Three plans run in this demo:

| taskId    | declared writes  | actual writes              | outcome              |
| --------- | ---------------- | -------------------------- | -------------------- |
| `auth`    | `src/auth/**`    | `src/auth/login.ts`        | `[x]` merged         |
| `billing` | `src/billing/**` | `src/billing/invoice.ts`   | `[x]` merged         |
| `rogue`   | `src/docs/**`    | `src/auth/sneak.ts` (lie!) | `[ ] ❌` audit fails |

The Leader also probes the coordinator once with `auth` + `auth-2` (both
claim `src/auth/**`) to demonstrate that the conflict is caught at acquire
time, not at merge time.

The rogue agent's worktree is preserved (`release({ keep: true })`) so a
human can inspect what it tried to do.

## Run

```bash
npm install
npm run -w @sparkwright/example-concurrent-sub-agents test
```

## Where sub-agent dispatch fits in

This demo simulates sub-agent execution in-process (no model adapter, no
tools) to keep the moving parts focused on concurrency control. For the
sub-agent dispatch surface (`spawnSubAgent`, `mountAgentTool`,
`TaskNotificationSink`), see:

- [`docs/reference/EXTENSION_INTERFACES.md` § Sub-agents](../../docs/reference/EXTENSION_INTERFACES.md#sub-agents)
- [`examples/promote-shell-to-task`](../promote-shell-to-task)

In a production setup, the Leader would call `spawnSubAgent` (or a
`mountAgentTool` exposed to its own model) and pass the worktree path as
the child's workspace. The async completion path reuses `TaskManager` +
`TaskNotificationSink` from that existing demo — no new transport.
