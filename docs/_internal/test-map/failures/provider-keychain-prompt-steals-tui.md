# Provider Keychain Prompt Steals TUI

## Record

- Pattern ID: `provider-keychain-prompt-steals-tui`
- Status: `fixed`
- First seen: 2026-08-10
- Last seen: 2026-08-10
- Recorded count: 1

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     1 |
| `test_bug`              |     0 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

After submitting an API key in TUI `/connect` on macOS, the dialog remains on
`working…`. The outer terminal prints `password data for new item:` and
`retype password for new item:` but the TUI owns raw input, so neither the
system command nor the product can make progress normally.

## Root Cause

The Keychain adapter launched `security add-generic-password ... -w` with the
secret on child stdin. With no value attached to `-w`, `security` ignores that
stdin for the password and prompts through its controlling terminal instead.
The child therefore competed with Ink for the same product PTY.

## Diagnostic Move

Run TUI `/connect` under a real PTY using isolated XDG metadata and a disposable
credential. If the system password prompts appear in the outer capture while
the dialog stays busy, inspect the Keychain child process's controlling
terminal rather than the React input component. Verify the fix with a fake
`security` executable that prompts through `/dev/tty`, then repeat against the
real Keychain and remove the exact disposable connection.

## Prevention

- Never assume a command-line credential flag reads stdin; verify its actual
  controlling-terminal behavior.
- Keep secrets out of argv, environment values, config, and retained output.
- Give bounded system password prompts a private PTY and accept only the exact
  expected prompt sequence.
- Fail closed on timeout, helper absence, extra prompts, or unexpected output;
  never fall back silently to plaintext storage.
- Retain a darwin-only PTY regression plus a real TUI checkpoint.

## Resolution

The macOS Keychain writer now starts the system `security` command behind a
private prompt PTY. The secret reaches that helper only through stdin and is
sent only after the two expected prompts arrive in order. Prompt output is not
forwarded to the product terminal. Unknown prompts, wrong order, excess
prompts, timeout, or helper failure reject the connection. Real OpenRouter TUI
QA reached the model picker and remained keyboard-responsive; the disposable
connection and Keychain entry were removed afterward.

## Related

- Coverage: [../coverage/provider-connections.md](../coverage/provider-connections.md)
