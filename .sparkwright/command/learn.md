---
description: Distill non-obvious session learnings into the nearest instruction file
---

Analyze this session and extract non-obvious learnings into the project's
instruction files, placing each as close to the relevant code as possible.

SparkWright discovers instruction files hierarchically (walking up to the git
root) and injects directory-specific ones when you read files in that area.
Prefer `SPARKWRIGHT.md` (the project's own convention); `AGENTS.md` is also
supported. Place learnings at the right level:

- Project-wide learnings -> root `SPARKWRIGHT.md`
- Package-specific -> `packages/<pkg>/SPARKWRIGHT.md`
- Feature-specific -> the closest directory to the code

What counts as a learning (non-obvious discoveries only):

- Hidden relationships between files or modules that must change together
- Execution paths that differ from how the code reads (e.g. two assembly paths)
- Non-obvious config, env vars, flags, or validation gates
- Debugging breakthroughs where the error message was misleading
- API/tool quirks and the workaround
- Build/test/release commands not already documented

What NOT to include:

- Facts already stated in docs or an existing instruction file
- Standard language/framework behavior
- Verbose explanations or session-specific narration

Process:

1. Review the session for discoveries, multi-attempt fixes, and surprises.
2. Decide the directory scope for each learning.
3. Read the existing instruction file at that level (if any).
4. Create or update the nearest `SPARKWRIGHT.md` with 1-3 line entries.
5. Summarize which files you changed and how many learnings each gained.

Scope hint (optional): $ARGUMENTS
