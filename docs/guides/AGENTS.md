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
  <workspace>/.sparkwright/config.json
  Best for delegateTools, advanced policy, budgets, and exact profile records.
```

If the same id exists in markdown and config, the config profile wins.

## Create A Reviewer

The fastest path is the CLI:

```bash
sparkwright agents create reviewer \
  --name "Reviewer" \
  --prompt "Inspect changes for correctness and risk." \
  --allow read_file \
  --allow glob_paths \
  --max-steps 4 \
  --workspace .
```

This writes a profile into `.sparkwright/config.json` under
`capabilities.agents.profiles`.

You can also commit a markdown profile:

```md
---
name: Reviewer
description: Inspect changes for correctness, risk, and missing tests.
mode: child
allowedTools: [read_file, glob_paths]
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

## Make It Callable

Defining a profile only makes it inspectable. To let the main agent call it,
add a delegate tool:

```bash
sparkwright agents create reviewer \
  --name "Reviewer" \
  --prompt "Inspect changes for correctness and risk." \
  --allow read_file \
  --allow glob_paths \
  --max-steps 4 \
  --delegate delegate_reviewer \
  --workspace .
```

The config shape is:

```json
{
  "capabilities": {
    "agents": {
      "profiles": [
        {
          "id": "reviewer",
          "name": "Reviewer",
          "mode": "child",
          "prompt": "Inspect changes for correctness and risk.",
          "allowedTools": ["read_file", "glob_paths"],
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
main agent.

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
- Giving a child agent too many tools: prefer narrow `allowedTools`.
- Expecting markdown to override config: config wins for the same id.
- Putting secrets in agent prompts or project config: keep credentials in user
  config or environment variables.
- Using delegation to bypass policy: parent restrictions and host policy still
  apply.
