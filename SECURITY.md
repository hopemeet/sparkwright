# Security Policy

Sparkwright is an agent runtime project. Security is part of the product surface, not an afterthought.

## Current Status

Sparkwright is pre-v0 and not ready for production use.

Do not run it against sensitive workspaces, secrets, production systems, or untrusted tool definitions until the security model matures.

## Security Principles

- Workspace writes should require approval by default.
- Risky tools should be declared explicitly.
- Tool calls should be visible in traces.
- Secrets should not be written into event payloads.
- Traces and artifacts should redact common secret shapes before persistence.
- File operations must stay inside the configured workspace root.
- Shell execution should be policy-gated, approval-aware, and bounded.

## Current Limitations

The intended security model is still ahead of the current implementation.

- `LocalWorkspace.writeText()` is a low-level workspace implementation and writes directly.
- Agent runs wrap configured workspaces with a controlled runtime workspace that checks policy and approval before writes.
- Trace and artifact persistence include default redaction for common secret keys and token-shaped strings, but callers must still avoid placing secrets in event payloads.
- The shell tool includes allow / require-approval / deny tiers and a destructive-command blocklist, but it is not a production sandbox.
- Runtime schema validation currently covers a small dependency-free JSON Schema subset for tool arguments and basic model output shape validation.

Do not treat the current code as a production sandbox.

## Reporting Issues

Report security concerns privately through either of the following channels:

- X (Twitter) DM: [@hopemeet_ai](https://x.com/hopemeet_ai)
- GitHub: [@hopemeet](https://github.com/hopemeet) — preferred path is opening a private security advisory on the Sparkwright repository; profile DM also works.

Please do not file public GitHub issues for suspected vulnerabilities — use one of the channels above first so we can coordinate a fix and disclosure.

Please include:

- affected version or commit
- reproduction steps
- expected behavior
- actual behavior
- potential impact
