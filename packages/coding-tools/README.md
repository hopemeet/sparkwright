# @sparkwright/coding-tools

Official workspace coding tools for Sparkwright agents.

```ts
import { createCodingTools } from "@sparkwright/coding-tools";

const tools = createCodingTools({
  workspaceRoot: "/path/to/workspace",
});
```

The text tools execute through `RuntimeContext.workspace`, so reads emit normal
workspace read events and anchored edits use Sparkwright's verified
`editAnchoredText` write path. Directory, glob, and grep tools need a
`workspaceRoot` at registration time because the current core workspace runtime
does not expose directory enumeration.

## Tools

- `read_text` reads a UTF-8 text file.
- `read_anchored_text` returns anchored line content for verified edits.
- `edit_anchored_text` applies anchored edit operations through the workspace.
- `list_dir` lists workspace files and directories.
- `grep` searches UTF-8 text files under the workspace.
- `glob` returns workspace-relative paths matching glob patterns.

All filesystem discovery is contained to `workspaceRoot` using realpath checks.
Writes never touch the filesystem directly from this package.
