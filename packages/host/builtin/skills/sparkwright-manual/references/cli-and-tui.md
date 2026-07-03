# CLI And TUI

Use this reference for practical command workflow. For exact syntax, prefer the
local CLI usage or source in `packages/cli/src/cli.ts`.

## Setup

From the repository root:

```bash
npm install
npm run build --workspaces
```

The root scripts build before running the CLI/TUI. The default `run` path uses
the host/client architecture (`cli -> sdk-node -> host -> core`), matching the
TUI runtime path:

```bash
npm run cli -- run "inspect this repo"
npm run tui
```

If invoking compiled output directly, rebuild first. The CLI binary points at
`packages/cli/dist/index.js`.

## First Run

Host-backed smoke test:

```bash
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --trace-level standard
```

Direct-core deterministic smoke test for development/diagnostics. This bypasses
the host and is intentionally hidden behind an explicit internal switch:

```bash
SPARKWRIGHT_ENABLE_DIRECT_CORE=1 npm exec sparkwright -- run --direct-core "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes \
  --trace-level standard
```

Read-only smoke test:

```bash
npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --trace-level standard
```

Provider-backed run:

```bash
OPENAI_API_KEY=... npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --model openai/<model-name>
```

Scripted host run for deterministic tool-call diagnostics:

```bash
SPARKWRIGHT_SCRIPTED_MODEL_JSON='[{"toolCalls":[{"toolName":"read","arguments":{"path":"README.md"}}]},{"message":"done"}]' \
  npm exec sparkwright -- run "call scripted tools" \
  --workspace examples/repo-pilot \
  --model scripted \
  --trace-level debug
```

## High-Frequency Flags

- `--workspace path`: workspace root for reads, writes, traces, sessions, and
  project config.
- `--target path`: workspace-relative target file for the repo-pilot path.
- `--write`: allow the deterministic path to propose a write.
- `--yes`: approve CLI approval prompts non-interactively.
- `--access-mode mode`: one of `read-only`, `ask`, `accept-edits`, `bypass`.
  The run autonomy preset; compiles to the internal permission/write fields.
- `--trace-level level`: one of `standard`, `debug`.
- `--session-id id`: attach a run to a known session id.
- `--model provider/model`: select a configured provider/model.
- `--model scripted`: run a host-backed scripted model from
  `SPARKWRIGHT_SCRIPTED_MODEL_JSON` or `SPARKWRIGHT_SCRIPTED_MODEL_FILE` for
  repeatable tool-call diagnostics.
- `--direct-core`: bypass the host and run the legacy in-process deterministic
  harness. Requires `SPARKWRIGHT_ENABLE_DIRECT_CORE=1`; keep this for core
  regression tests and diagnostics, not the default product path.

## Command Groups

Current top-level CLI groups include:

- `init`: scaffold user config.
- `run`: start a run or resume a stored run checkpoint.
- `trace`: inspect trace files.
- `session`: inspect, check, repair, or resume sessions.
- `tools`: list or change tool loading settings.
- `skills`: list, validate, or create skills.
- `agents`: list, validate, or create agent profiles/delegate tools.
- `cron`: create, list, update, pause, resume, remove, run, or tick scheduled
  jobs.

Use `npm run cli -- <command>` during development. Use
`npm exec sparkwright -- <command>` for the local workspace package after build.

`run resume <run-id>` uses the host by default (`cli -> sdk-node -> host`).
Use `--direct-core` with `SPARKWRIGHT_ENABLE_DIRECT_CORE=1` only for diagnostics
or core regression coverage; it keeps checkpoint lookup and resume in the CLI
process.

## Trace Commands

```bash
npm exec sparkwright -- trace summary <trace.jsonl> --format text
npm exec sparkwright -- trace events <trace.jsonl> --type tool.failed --limit 20 --jsonl
npm exec sparkwright -- trace timeline <trace.jsonl> --format text
```

Filters include `--type`, `--run-id`, `--contains`, `--limit`,
`--after-sequence`, and `--before-sequence` where supported.

## Session Commands

```bash
npm exec sparkwright -- session summary <session-id> --workspace examples/repo-pilot
npm exec sparkwright -- session check <session-id> --workspace examples/repo-pilot --format text
npm exec sparkwright -- session inspect <session-id> --workspace examples/repo-pilot --compaction --format text
npm exec sparkwright -- session repair <session-id> --workspace examples/repo-pilot --dry-run
npm exec sparkwright -- session resume <session-id> "continue the investigation" --workspace examples/repo-pilot
```

Use `--apply` only when intentionally applying a session repair.

## Tool, Skill, And Agent Commands

```bash
npm exec sparkwright -- capabilities inspect --workspace . --format text
npm exec sparkwright -- tools allow read
npm exec sparkwright -- tools disable bash
npm exec sparkwright -- tools defer read_anchored_text
```

`tools allow`/`tools disable`/`tools defer` take concrete tool names (no
wildcards). Edit `tools.use` directly for broad selector scoping.

Add `--workspace <path>` to inspect or update project tool defaults in
`<workspace>/.sparkwright/config.{json,yaml,yml}`; without it, tools commands
operate on the user config.

```bash
npm exec sparkwright -- skills list --workspace .
npm exec sparkwright -- skills validate --workspace . --format text
npm exec sparkwright -- skills create code-reviewer --description "review code changes" --workspace .
```

```bash
npm exec sparkwright -- agents list --workspace .
npm exec sparkwright -- agents validate --workspace .
npm exec sparkwright -- agents create reviewer \
  --prompt "Review code changes" \
  --model openai/gpt-5.4-mini \
  --use workspace.read \
  --max-steps 4 \
  --workspace .
```

`agents create` covers the common profile fields. Add profile-scoped workflow
hooks by editing `.sparkwright/agents/<id>.md` or
`capabilities.agents.profiles[].hooks`, then run `agents validate` or
`config validate`.

These commands write user or workspace configuration where applicable. Treat
config changes as user-visible state changes.

## TUI

Start the interactive terminal UI:

```bash
npm run tui
```

The TUI uses the host/client path and the same config model. The root script
rebuilds first to avoid stale compiled output.

Use `/sessions`, select a session, and press `i` to inspect diagnostics. When
present, the inspect panel includes the compaction audit from
`session.inspect` with `compaction: true`.
