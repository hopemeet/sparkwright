# Agent Profiles

Agent profiles are reusable run templates for roles such as reviewer, planner,
triage agent, or implementation helper. They describe guidance and constraints;
they do not grant authority by themselves.

Use this guide when you want to answer:

- Where do I define an agent?
- How do I make it callable by the main agent?
- How do I restrict its tools?
- How do I check what the host actually loaded?

## Choose The Right Place

```txt
Project markdown profile
  <workspace>/.sparkwright/agents/<id>.md
  Best for role prompt, description, mode, simple tool allow/deny, and maxSteps.

Project config
  <workspace>/.sparkwright/config.{json,yaml,yml}
  Best for delegateTools, advanced policy, budgets, maxDepth, and exact profile
  records.
```

If the same id exists in markdown and config, the config profile wins.

## Create A Reviewer

The fastest path is the CLI:

```bash
sparkwright agents create reviewer \
  --name "Reviewer" \
  --prompt "Inspect changes for correctness and risk." \
  --use workspace.read \
  --allow read_file \
  --allow glob \
  --max-steps 4 \
  --workspace .
```

This writes a profile into the project config under
`capabilities.agents.profiles`. If a project YAML config already exists, the CLI
preserves it; otherwise it creates `.sparkwright/config.json`.

You can also commit a markdown profile:

```md
---
name: Reviewer
description: Inspect changes for correctness, risk, and missing tests.
mode: child
use: [workspace.read]
allowedTools: [read_file, glob]
deniedTools: [shell]
maxSteps: 4
---

Review the proposed change. Focus on correctness, regressions, and missing
tests. Report findings with file references.
```

Save it as:

```txt
.sparkwright/agents/reviewer.md
```

Implementation delegates should usually combine read and write selectors:

```md
---
name: Implementer
description: Make scoped code changes.
mode: child
use: [workspace.read, workspace.write]
allowedTools: [read_file, glob, apply_patch, edit_anchored_text]
maxSteps: 8
---

Make the requested change, then summarize exactly what changed.
```

Avoid `workspace.write` without `workspace.read` unless the delegate is driven
by a deterministic script. Most model-backed implementers need read tools to
find anchors before they can produce safe patches.

## Make It Callable

Defining a profile only makes it inspectable. To let the main agent call it,
add a delegate tool:

```bash
sparkwright agents create reviewer \
  --name "Reviewer" \
  --prompt "Inspect changes for correctness and risk." \
  --use workspace.read \
  --allow read_file \
  --allow glob \
  --max-steps 4 \
  --delegate delegate_reviewer \
  --workspace .
```

The config shape is:

```json
{
  "capabilities": {
    "agents": {
      "maxDepth": 1,
      "profiles": [
        {
          "id": "reviewer",
          "name": "Reviewer",
          "mode": "child",
          "prompt": "Inspect changes for correctness and risk.",
          "use": ["workspace.read"],
          "allowedTools": ["read_file", "glob"],
          "maxSteps": 4
        }
      ],
      "delegateTools": [
        {
          "profileId": "reviewer",
          "toolName": "delegate_reviewer",
          "requiresApproval": true,
          "forbidNesting": true,
          "maxSteps": 4
        }
      ]
    }
  }
}
```

`profiles` defines the agent. `delegateTools` exposes a callable tool for the
main agent. `use` is a broad selector list shared with top-level `tools.use`;
`allowedTools` remains the concrete-name allowlist. When both are set, the child
only receives tools that pass both filters. `maxDepth` caps nested
child/delegate spawning for this workspace.

## Inspect And Validate

Use these before guessing:

```bash
sparkwright agents list --workspace .
sparkwright agents validate --workspace .
sparkwright capabilities inspect --workspace . --format text
```

Look for:

- the profile id in `agents list`
- `delegate_<name> -> <profileId>` if it should be callable
- agent shadows in `capabilities inspect` if the same id exists in multiple
  layers
- validation errors for delegate tools pointing at missing profile ids

## Common Mistakes

- Defining a profile but forgetting `delegateTools`: the agent exists, but the
  main agent cannot call it.
- Giving a child agent too many tools: prefer narrow `use` selectors first, then
  concrete `allowedTools` when needed.
- Expecting markdown to override config: config wins for the same id.
- Putting secrets in agent prompts or project config: keep credentials in user
  config or environment variables.
- Using delegation to bypass policy: parent restrictions and host policy still
  apply.
