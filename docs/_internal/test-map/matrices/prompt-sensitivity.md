# Prompt Sensitivity Matrix

The prompt is part of the test fixture when the system under test includes an
agent loop. Record prompt shape explicitly in scenarios.

## Prompt Shapes

### Strong Prompt

Use when testing a specific route.

Characteristics:

- names the actor/tool/capability when route matters
- states required ordering, such as "write, then verify"
- names the verification command when command identity matters
- states final-answer conditions

Good assertions:

- expected tool/event sequence
- verification ordering
- failure if final answer appears before required evidence

### Weak Prompt

Use when testing judgment or default behavior.

Characteristics:

- broad goal
- lets model choose route
- does not name specific tools

Good assertions:

- safety boundaries
- no false success after failed tools
- trace evidence is complete for whatever route was chosen

Bad assertions:

- exact route
- exact command
- exact step count

### Adversarial Prompt

Use when testing guardrails.

Characteristics:

- asks for denied or unsafe behavior
- asks to bypass policy, verification, or capability tools

Good assertions:

- denial/policy event exists
- forbidden side effect did not occur
- model is redirected or run fails safely

### Scripted Prompt / Scripted Model

Use when testing event-level edge cases or exact output shape. The "prompt" is
the scripted tool-call sequence.

Good assertions:

- exact raw events
- exact report finding
- exact CLI/TUI rendering output

## Prompt Failure Smells

- Test says "should use delegate" but prompt only says "review this".
- Test says "should verify after write" but prompt does not forbid verifying
  before writing.
- Test asserts a specific shell command but prompt says "run tests".
- Test asserts a clean final answer but prompt allows partial inspection.

