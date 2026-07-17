# Test Map

## Purpose

This directory is SparkWright's internal testing knowledge map. It records how
to choose tests, how to describe a test scenario, what has and has not been
verified, and what previous failures taught us.

It is not a command-output log. A test-map entry should capture reusable
testing knowledge: the task direction, prompt shape, model, capabilities,
policy, environment, stable assertions, non-invariants, and failure pattern.

Use this alongside [../project-map/README.md](../project-map/README.md):

- Project map answers: what code and contracts does this change touch?
- Test map answers: how do we verify those contracts, and what can make the
  verification misleading?

## Directory Layout

- [routes/](routes/) - "Changed X, test Y" routing rules.
- [scenarios/](scenarios/) - structured specs for important test worlds.
- [matrices/](matrices/) - sensitivity notes for model, prompt, capability,
  policy, and environment dimensions.
- [coverage/](coverage/) - confidence state by behavior area, including
  untested and weakly tested edges.
- [failures/](failures/) - reusable failure-pattern notes with cause counts and
  diagnostic moves.
- [runs/](runs/) - bounded test-session notes for stochastic or exploratory
  runs. Store summaries and evidence pointers, not raw terminal dumps.

## Core Concepts

### Scenario

A scenario describes the world being tested. It should say:

- task direction and prompt shape
- model class (`deterministic`, `scripted`, real provider/model)
- enabled tools/capabilities
- permission and approval posture
- session/context state
- trace level and environment assumptions
- stable assertions and known non-invariants

Prefer adding or updating a scenario when the question is "what exactly did we
mean to prove?"

### Route

A route maps changed files or capabilities to focused test commands. Prefer
updating a route when the question is "what should I run after touching this?"

### Coverage

Coverage pages record the current confidence state of an area. They must name
what is weak or untested; absence of evidence should stay visible.

### Failure Pattern

A failure pattern records a reusable diagnostic lesson. It is not "test X failed
once"; it is "this class of failure looks like this, was caused by this, and
should be diagnosed this way."

### Run Note

A run note records one test session when the route, prompt, model, capability
posture, or environment could change the result. Add a run note when a test is
stochastic, exploratory, real-model-backed, or failure-hunting. Deterministic
unit test reruns only need a run note when they reveal a new failure pattern or
change coverage confidence.

## Status Vocabulary

Use these exact terms in `coverage/*` and scenario `status` fields:

- `Verified`: current source was read and the relevant focused tests passed.
- `Partially Verified`: the main path was tested, but known edges remain
  untested or environment-limited.
- `Untested`: no useful direct test evidence exists yet.
- `Stale`: the source/contract changed after the last meaningful verification.
- `Flaky`: the test or scenario is unstable; explain retry and cause policy.
- `Blocked`: the scenario should be tested but current environment/tooling
  cannot exercise it.

## Failure Cause Vocabulary

Use these cause buckets when counting failures:

- `product_bug`: SparkWright behavior was wrong.
- `test_bug`: the test asserted the wrong thing or was malformed.
- `prompt_underspecified`: the prompt did not force the behavior being tested.
- `model_variance`: a real model chose a different valid route.
- `environment`: OS, sandbox, network, file system, timing, or local config.
- `stale_dist`: downstream package imported old `dist` output.
- `dirty_workspace`: unrelated workspace state affected the result.
- `unknown`: root cause was not determined.

## Update Rules

- Add a scenario for any important behavior whose result depends on prompt,
  model, tool selection, policy, context, or environment.
- Update a coverage page when confidence meaningfully changes.
- Add a failure note only when the failure teaches a reusable diagnostic move.
- Do not paste long command output. Summarize symptoms, root cause, and commands.
- Keep stable assertions separate from non-invariants.
- When a real-model run is involved, do not assert exact prose, exact step
  count, or exact tool route unless the prompt and harness force them.
- Do not keep an unsourced QA outline as an active proposal. Start planned QA
  work from a source-linked route, coverage gap, failure pattern, or scenario,
  then record bounded evidence in this test map.

## Minimal Workflow

1. Use project-map to find the touched contracts.
2. Use [routes/package-routes.md](routes/package-routes.md) or
   [routes/capability-routes.md](routes/capability-routes.md) to choose focused
   tests.
3. Check [scenarios/](scenarios/) when model/prompt/capability choices matter.
4. If the test session is stochastic or exploratory, add a bounded note under
   [runs/](runs/).
5. Check [coverage/](coverage/) for known weak spots.
6. If a test fails in a reusable way, update [failures/](failures/).
