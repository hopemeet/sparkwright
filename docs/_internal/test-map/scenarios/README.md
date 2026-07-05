# Scenario Specs

Scenario specs describe test worlds. They are intentionally more specific than
test commands: a command can pass while the prompt, model, capability set, or
environment failed to exercise the intended behavior.

Use YAML for machine-readable shape and short Markdown notes elsewhere when
needed. The template is [_template.yaml](_template.yaml).

## Scenario Fields

- `id`: stable snake/kebab identifier.
- `area`: broad behavior area.
- `status`: one of the test-map status terms.
- `task`: task direction, prompt shape, and expected behavior.
- `model`: baseline and sensitivity notes.
- `capabilities`: tool/capability/policy posture.
- `context`: workspace/session/config state.
- `environment`: OS, trace, sandbox, network, and build-state assumptions.
- `assertions.stable`: facts that should be true for the scenario.
- `assertions.non_stable`: facts not safe to assert.
- `recommended_tests`: commands that exercise this scenario.
- `known_failure_modes`: reusable failure links or short labels.

## Scenario Selection Rule

If a test result can change because of model choice, prompt wording, enabled
tools, permission mode, session state, or platform sandbox support, document it
as a scenario. If it is purely a file-to-test routing rule, document it under
`routes/` instead.

