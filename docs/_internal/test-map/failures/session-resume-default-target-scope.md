# Session Resume Applies The Default README Target

## Record

- Pattern ID: `session-resume-default-target-scope`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 1
- Cause: `product_bug`

## Symptom

A Host `session resume` command with `--access-mode bypass` and no explicit
`--target` auto-approved shell, but denied every coding-tool write outside
`README.md`. The denial payload reported:

```text
Workspace write is outside the allowed target scope: print_numbers.py
allowedPaths=["README.md"]
```

The same goal in a fresh `run` with the same workspace/model/access mode wrote
`print_numbers.py` and `test_print_numbers.py` successfully. This rules out the
patch, model, workspace, and access ceiling.

## Root Cause

CLI argument parsing initializes `targetPath="README.md"` with
`targetPathSource="default"`. The fresh-run path deliberately passes
`targetPath: undefined` unless `targetPathSource === "cli"`.
`handleSessionResumeCommand()` instead spreads the parsed object directly into
`startHostRun()`. Its separate `policyTargetPath` field does not prevent Host
from receiving the default `targetPath`, so Host policy compiles
`allowedPaths:["README.md"]`.

## Resolution

Fixed 2026-07-19 by removing the parser-level default target and its source
sentinel. Fresh run, run resume, and session resume now forward
`targetPath: undefined` unless `--target` is explicit. Host policy still narrows
to an explicit target and otherwise applies the configured workspace ceiling.

Deterministic evidence: CLI Host integration covers both untargeted non-README
writes and explicit target scoping; Cron CLI integration also asserts no
inferred README target.

## Diagnostic Move

Inspect `workspace.write.denied.payload.policy.metadata.allowedPaths`. If an
untargeted session resume reports only `README.md`, compare the CLI fresh-run
and session-resume forwarding logic before blaming project config or the model.

## Prevention

- Keep a CLI Host regression that creates a read-only session, resumes it with a
  new write-enabled goal and no `--target`, and successfully writes a
  non-README file within the normal multi-file guardrail.
- Keep the paired explicit `--target README.md` assertion to preserve intentional
  single-file scoping.
- Route target forwarding through one helper shared by fresh run, session
  resume, and run resume.

## Evidence

- Resume trace: `/Applications/xgw/projects/AI-native/project/test/.sparkwright/sessions/session_mrqz855uoi04dgdd/trace.jsonl`
- Failing resume run: `run_mrqzi0mfhuk9sd0a`
- Successful fresh control: `session_mrqzkle329yslud3`
- Source: `packages/cli/src/commands/trace-session.ts` and
  `packages/cli/src/cli.ts` fresh-run routing.

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run note: [../runs/2026-07-19-real-terra-broad-refactor-qa.md](../runs/2026-07-19-real-terra-broad-refactor-qa.md)
