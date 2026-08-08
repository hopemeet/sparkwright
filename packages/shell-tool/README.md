# @sparkwright/shell-tool

Opt-in shell tool for Sparkwright agents. Ships separately from
`@sparkwright/coding-tools` so embedders can compose their own safety posture
without pulling shell execution into the workspace tool surface.

```ts
import { LocalProcessEnvironment } from "@sparkwright/core";
import { createShellTool } from "@sparkwright/shell-tool";

const tool = createShellTool({
  environment: new LocalProcessEnvironment({
    /* policy + executor */
  }),
});
```

## Safety tiers

`evaluateShellSafety(command, options)` returns one of three decisions:

- `allow` — read-only built-ins (`ls`, `cat`, `pwd`, `git status|diff|log`).
- `require_approval` — package installs (`npm install`, `apt`, `brew`),
  `sudo`, `git push`, and anything not in the allow list when
  `defaultRequireApproval` is true.
- `deny` — commands that match `DESTRUCTIVE_PATTERNS` (`rm -rf /`, fork bombs,
  `mkfs`, `dd if=... of=/dev/...`, `curl … | bash`, `git push --force` to
  `main`/`master`, etc.) or pipe directly into a shell interpreter.

The tool advertises `policy: { risk: 'risky', requiresApproval: true }`, so the
core policy layer gates every call before execution. At execute time the
classifier runs again — deny verdicts fail even if approval was granted from a
stale snapshot.

## Override hooks

`createShellTool({ safety })` accepts:

- `safety.allow` / `safety.requireApproval` / `safety.deny` — per-program
  overrides matched against the leading argv token.
- `safety.defaultRequireApproval` — flip the default from
  `require_approval` to `deny` for stricter deployments.

## Why a separate package

- Composability: products that never want shell access can simply omit it.
- Policy alignment: keeps the workspace tool set free of `external` side
  effects so default policies stay tight.
- Independent versioning: safety rules can ship faster than the workspace API
  surface.

This package depends only on `@sparkwright/core` (peer) and `node:child_process`
indirectly via the core's `LocalProcessEnvironment`.
