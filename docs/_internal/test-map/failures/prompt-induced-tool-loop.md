# Prompt Induced Tool Loop

## Record

- Pattern ID: `prompt-induced-tool-loop`
- Status: `watch`
- First seen: 2026-06-22
- Last seen: 2026-07-07
- Recorded count: 9

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     3 |
| `test_bug`              |     1 |
| `prompt_underspecified` |     3 |
| `model_variance`        |     2 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

The run repeats similar tool calls, delegate calls, or verification attempts
until a step limit or timeout, and the test is unsure whether this is a runtime
loop or a prompt/model behavior issue.

## Root Cause

Often the prompt leaves completion criteria vague, gives a broad goal without a
stop condition, or asks for repeated checking without saying when enough
evidence has been gathered.

On 2026-06-22, `openai/gpt-5.4-mini` batched parent `read_file` verification
beside a `spawn_agent` call, then repeated the same parent read when trying to
honor "after the child returns"; the repeated-tool guard stopped the run with
`TOOL_DOOM_LOOP`.

On 2026-06-23, `openai/gpt-5.4-nano` repeatedly drafted Skill update proposals
for the same `repo-reviewer` task. The run created 15 draft proposals, made 50
model calls, and hit the regression harness timeout before a final answer. The
trace report correctly flagged `EXCESSIVE_MODEL_CALLS`, `LOW_NET_PROGRESS`, and
`REPEATED_TOOL_REQUESTS`; the harness then failed because the timed-out CLI did
not print a final trace path even though the trace existed on disk.

Later on 2026-06-23, the strengthened Skill update prompt and idempotent draft
reuse passed: the real model created one draft proposal and did not apply it.
The same regression still exposed a weaker create prompt: the skill was created
successfully, then the model repeated the same `create_skill` call. Runtime
guardrails skipped the identical repeated call with
`REPEATED_TOOL_CALL_SKIPPED`, recovered, and produced a final answer.

Also on 2026-06-23, the real-model write-denial regression prompt asked for an
`append_file` tool that is not in the effective tool catalog. The model spent
18 turns calling `tool_search` for an `append_file` schema, then stopped without
attempting a write. This is a test prompt/catalog mismatch, not evidence that
the write guard failed.

On 2026-06-29, `openai/gpt-5.4-mini` repeated canonical `read` calls on a
large paginated file under a strong prompt that explicitly required two reads
and then `grep`. The CLI run alternated
`read {"path":"PROJECT_NOTES.md","offset":1,"limit":2000}` and
`read {"path":"PROJECT_NOTES.md","offset":2001,"limit":2000}` for 23 tool
calls until manually terminated. The TUI run reached `offset:4001` once, then
returned to earlier windows and hit a 6-call budget. `run.health` summaries were
present in prompt context but did not stop the loop, and repeated summaries
accumulated in selected context. Classify this instance as a product bug in
runtime feedback/guardrails rather than prompt underspecification.

On 2026-07-01, `openai/gpt-5.4-nano` completed a read-only Direct Corpus
Interaction prompt that explicitly forbade `tool_search` and required at least
one grep-style corpus search. The run did use only `grep`, `read`, and `glob`
and produced a correct final answer, but it spent 34 model calls, 73 tool calls,
267401 tokens, and 8793 `workspace.read` events before stopping. Trace report
flagged duplicate workspace reads, excessive model calls, low net progress, and
workspace read noise. Classify this instance as `prompt_underspecified`: the
prompt required grep usage and concrete evidence but did not give a hard stop
condition after enough implementation/docs evidence had been found.

Also on 2026-07-01, after `task_create` was hardened to advertise
`kind:"agent"` and the required background-agent payload, a real
`openai/gpt-5.4-mini` run successfully created a background agent task and the
durable task completed. The parent model then repeated the same valid
`task_create` call instead of monitoring the returned task id with `task`, and
the duplicate guard ended the parent run with `TOOL_DOOM_LOOP`. Classify this
as a separate model/capability-monitoring loop, not as a background task runner
or payload-schema failure. Trace:
`/tmp/sparkwright-mini-qa-20260701-task-agent-fixed/session_mr1lz0xua6sedleb/trace.jsonl`.

On 2026-07-07, a current-source real `openai/gpt-5.4-mini` Agent + Skill
prompt explicitly requested exactly one awaited `task_create(kind:"agent")`
after loading a project Skill and its reference. The model first guessed the
wrong Skill resource path (`task.md` instead of `references/task.md`), recovered
from the loader's available-file hint, then spawned three equivalent awaited
agent tasks instead of monitoring with `task(action:"wait")` / `output`. The
children completed useful read-only work and trace verify/session check were
ok, while trace report surfaced `LOW_NET_PROGRESS` plus the recovered
`SKILL_LOAD_FAILED`. Follow-up root-cause inspection reclassified this instance
as a product feedback issue: detached `task_create` returned no next-action
hint, and terminal task notifications did not put the child result in body
text. Trace:
`/tmp/sparkwright-agent-skill-bg.JCm3sJ/.sparkwright/sessions/session_mra7xnvxy6d8rxwi/trace.jsonl`.

## Diagnostic Move

Classify the repeated calls:

- same tool and same arguments with no new information: likely product or model
  loop, depending on runtime guardrails
- same goal but changing arguments: may be valid exploration
- repeated denied approvals: may be prompt/capability mismatch
- repeated delegate calls: inspect child terminal state and parent evidence
- repeated paginated reads: compare the full window identity (`path`, `offset`,
  `limit`) and inspect whether `run.health` feedback is present, duplicated, and
  specific enough to redirect the model
- repeated `task_create` after a successful background task: inspect the
  durable task record first; if the task completed, diagnose parent monitoring
  guidance/tool discovery separately from task runner health

Then check whether the prompt gave a clear stopping condition.

## Prevention

- Add final-answer conditions to route-specific prompts.
- For multi-step tool-order tests, specify the first tool batch and tell the
  model to stop and answer instead of repeating identical tool arguments.
- For failure-hunting, record the prompt shape and count repeated calls in the
  run note.
- Use trace report repeated-delegate/tool findings as evidence, not prose alone.
- Keep large-file paging prompts explicit about the stop condition and inspect
  whether repeated read feedback is working before attributing the loop only to
  model variance.
- For background tasks, avoid treating a failed parent run as failed child
  execution until the durable task record and `subagent.*` terminal events are
  checked.

## Mitigation

- 2026-06-29: `read_file` now returns structured `nextOffset` for valid
  paginated windows, and live `RunHealthAnalyzer` feedback now includes the
  next unread offset when a model pages backwards to an already-read unchanged
  window.
- Verified deterministically with `packages/host/test/tools.test.ts` and
  `packages/core/test/run.test.ts`. Keep this pattern in `watch` until a real
  mini pagination rerun confirms the mitigation changes model behavior.

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md),
  [../coverage/skills.md](../coverage/skills.md)
- Matrix: [../matrices/prompt-sensitivity.md](../matrices/prompt-sensitivity.md),
  [../matrices/model-sensitivity.md](../matrices/model-sensitivity.md)
- Run note: [../runs/2026-06-29-real-mini-tool-surface-qa.md](../runs/2026-06-29-real-mini-tool-surface-qa.md)
- Run note: [../runs/2026-07-01-real-nano-dci-grep-partial.md](../runs/2026-07-01-real-nano-dci-grep-partial.md)
- Run note: [../runs/2026-07-01-real-mini-background-task-qa.md](../runs/2026-07-01-real-mini-background-task-qa.md)
- Run note: [../runs/2026-07-07-real-mini-agent-skill-multidirection-qa.md](../runs/2026-07-07-real-mini-agent-skill-multidirection-qa.md)
- Root-cause pattern: [task-create-agent-low-signal-result-feedback.md](task-create-agent-low-signal-result-feedback.md)
