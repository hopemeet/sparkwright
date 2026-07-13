import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events.js";
import { createRunId } from "../src/ids.js";
import { createWorkspaceReadScopePolicy } from "../src/policy.js";
import type { RunRecord } from "../src/types.js";
import { ControlledWorkspace, LocalWorkspace } from "../src/workspace.js";
import { WorkspaceCheckpointStore } from "../src/workspace-checkpoint.js";

describe("LocalWorkspace", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sparkwright-workspace-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads files inside the root", async () => {
    await writeFile(join(root, "README.md"), "# Test\n", "utf8");
    const workspace = new LocalWorkspace(root);

    await expect(workspace.readText("README.md")).resolves.toBe("# Test\n");
  });

  it("rejects paths that escape the root", async () => {
    const workspace = new LocalWorkspace(root);

    await expect(workspace.readText("../outside.txt")).rejects.toThrow(
      "Path escapes workspace root",
    );
    await expect(workspace.readText(".")).rejects.toThrow(
      "Path escapes workspace root",
    );
    await expect(
      workspace.readText("nested/../../outside.txt"),
    ).rejects.toThrow("Path escapes workspace root");
  });

  it("rejects symlinks inside the root that point outside the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "sparkwright-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
      // Symlink inside the workspace pointing to an external directory.
      await symlink(outside, join(root, "escape"));

      const workspace = new LocalWorkspace(root);

      await expect(workspace.readText("escape/secret.txt")).rejects.toThrow(
        "Path escapes workspace root",
      );
      await expect(
        workspace.writeText("escape/new.txt", "nope"),
      ).rejects.toThrow("Path escapes workspace root");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects directory symlinks that point back inside the workspace", async () => {
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    const workspace = new LocalWorkspace(root);

    await expect(
      workspace.writeText("alias/new.txt", "nope"),
    ).rejects.toMatchObject({
      code: "WORKSPACE_SYMLINK_WRITE_DENIED",
    });
    await expect(readFile(join(root, "real", "new.txt"))).rejects.toThrow();
  });

  it("rejects file symlinks that point back inside the workspace", async () => {
    await writeFile(join(root, "real.txt"), "before\n", "utf8");
    await symlink(join(root, "real.txt"), join(root, "alias.txt"));
    const workspace = new LocalWorkspace(root);

    await expect(
      workspace.writeText("alias.txt", "after\n"),
    ).rejects.toMatchObject({
      code: "WORKSPACE_SYMLINK_WRITE_DENIED",
    });
    await expect(readFile(join(root, "real.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
  });

  it("creates parent dirs when writing to a not-yet-existing nested path", async () => {
    // Regression: writeText previously called writeFile without mkdir, so a
    // write to a new nested path threw ENOENT and the model could not create
    // files. It now mkdir -p's the parent before writing.
    const workspace = new LocalWorkspace(root);

    await workspace.writeText("docs/notes/new.md", "hello\n");

    await expect(
      readFile(join(root, "docs/notes/new.md"), "utf8"),
    ).resolves.toBe("hello\n");
  });

  it("creates a simple text diff", async () => {
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    const workspace = new LocalWorkspace(root);

    const diff = await workspace.diffText("README.md", "after\n");

    expect(diff).toContain("--- a/README.md");
    expect(diff).toContain("-before");
    expect(diff).toContain("+after");
  });

  it("creates compact line diffs for appends", async () => {
    await writeFile(
      join(root, "README.md"),
      "one\ntwo\nthree\nfour\nfive\nsix\n",
      "utf8",
    );
    const workspace = new LocalWorkspace(root);

    const diff = await workspace.diffText(
      "README.md",
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
    );

    expect(diff).toContain("+seven");
    expect(diff).not.toContain("-one");
    expect(diff).not.toContain("+one");
  });

  it("reads and applies anchored edits through local workspace", async () => {
    await writeFile(join(root, "README.md"), "alpha\nbeta\n", "utf8");
    const workspace = new LocalWorkspace(root);
    const anchored = await workspace.readAnchoredText("README.md");

    await workspace.editAnchoredText("README.md", [
      {
        op: "replace",
        anchor: anchored.lines[1]!.anchor,
        lines: ["BETA"],
      },
    ]);

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "alpha\nBETA\n",
    );
  });

  it("requires approval before writing through controlled workspace", async () => {
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
      approvalResolver(request) {
        expect(run.state).toBe("waiting_approval");
        expect(request.action).toBe("workspace.write");
        expect(request.details.path).toBe("README.md");
        expect(String(request.details.diff)).toContain("-before");
        return {
          approvalId: request.id,
          decision: "approved",
        };
      },
    });

    const result = await workspace.writeText("README.md", "after\n", {
      reason: "test write",
    });

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "after\n",
    );
    expect(result.diffArtifactId).toBe(result.diffArtifact?.id);
    expect(result.summary).toEqual({ lineCount: 1, lastLines: ["after"] });
    expect(run.state).toBe("running");
    expect(events.all().map((event) => event.type)).toEqual([
      "workspace.write.requested",
      "approval.requested",
      "approval.resolved",
      "artifact.created",
      "workspace.write.completed",
    ]);
    expect(
      events.all().find((event) => event.type === "workspace.write.completed")
        ?.payload,
    ).toMatchObject({
      diffArtifactId: result.diffArtifactId,
      summary: { lineCount: 1, lastLines: ["after"] },
    });
  });

  it("canonicalizes absolute paths through controlled workspace", async () => {
    await writeFile(join(root, "README.md"), "public\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
    });

    await expect(
      workspace.canonicalPath(join(root, "README.md")),
    ).resolves.toBe("README.md");
    await expect(workspace.readText(join(root, "README.md"))).resolves.toBe(
      "public\n",
    );
    expect(
      events.all().find((event) => event.type === "workspace.read")?.payload,
    ).toMatchObject({ path: "README.md" });
  });

  it("denies reads of a confidential path and emits workspace.read.denied", async () => {
    await writeFile(join(root, "README.md"), "public\n", "utf8");
    await writeFile(join(root, "secret.txt"), "SECRET_TOKEN=abc\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
      policy: createWorkspaceReadScopePolicy({
        confidentialPaths: ["secret.txt"],
      }),
    });

    // Non-confidential reads still pass.
    await expect(workspace.readText("README.md")).resolves.toBe("public\n");

    await expect(workspace.readText("secret.txt")).rejects.toThrow(
      /READ_SCOPE_DENIED|Workspace read denied/,
    );

    const denied = events
      .all()
      .find((event) => event.type === "workspace.read.denied");
    expect(denied?.payload).toMatchObject({ path: "secret.txt" });
  });

  it("does not write when controlled workspace approval is denied", async () => {
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
      approvalResolver(request) {
        return {
          approvalId: request.id,
          decision: "denied",
        };
      },
    });

    await expect(workspace.writeText("README.md", "after\n")).rejects.toThrow(
      "Workspace write approval denied",
    );

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "before\n",
    );
    expect(events.all().map((event) => event.type)).toContain(
      "workspace.write.denied",
    );
  });

  it("does not write when the file changes after the proposal is created", async () => {
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
      async approvalResolver(request) {
        await writeFile(join(root, "README.md"), "external change\n", "utf8");
        return {
          approvalId: request.id,
          decision: "approved",
        };
      },
    });

    await expect(workspace.writeText("README.md", "after\n")).rejects.toThrow(
      "Workspace write conflicted",
    );

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "external change\n",
    );
    const denied = events
      .all()
      .find((event) => event.type === "workspace.write.denied");
    expect(denied?.payload).toMatchObject({
      path: "README.md",
      reason: "Workspace file changed after the write was proposed.",
    });
  });

  it("verifies anchored edits before the controlled write path", async () => {
    await writeFile(join(root, "README.md"), "alpha\nbeta\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
      approvalResolver(request) {
        expect(request.action).toBe("workspace.write");
        return {
          approvalId: request.id,
          decision: "approved",
        };
      },
    });
    const anchored = await workspace.readAnchoredText("README.md");

    const result = await workspace.editAnchoredText(
      "README.md",
      [
        {
          op: "append",
          anchor: anchored.lines[1]!.anchor,
          lines: ["gamma"],
        },
      ],
      { reason: "append gamma" },
    );

    expect(result.content).toBe("alpha\nbeta\ngamma\n");
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "alpha\nbeta\ngamma\n",
    );
    expect(events.all().map((event) => event.type)).toEqual([
      "workspace.anchored_read",
      "workspace.anchored_edit.requested",
      "workspace.anchored_edit.verified",
      "workspace.write.requested",
      "approval.requested",
      "approval.resolved",
      "artifact.created",
      "workspace.write.completed",
    ]);
  });

  it("rejects stale anchored edits before approval or write proposal", async () => {
    await writeFile(join(root, "README.md"), "alpha\nbeta\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
      approvalResolver() {
        throw new Error("approval should not be requested");
      },
    });
    const anchored = await workspace.readAnchoredText("README.md");
    await writeFile(join(root, "README.md"), "alpha\nchanged\n", "utf8");

    await expect(
      workspace.editAnchoredText("README.md", [
        {
          op: "replace",
          anchor: anchored.lines[1]!.anchor,
          lines: ["BETA"],
        },
      ]),
    ).rejects.toThrow("Anchor hash does not match");

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "alpha\nchanged\n",
    );
    expect(events.all().map((event) => event.type)).toEqual([
      "workspace.anchored_read",
      "workspace.anchored_edit.requested",
      "workspace.anchored_edit.rejected",
    ]);
    expect(
      events
        .all()
        .find((event) => event.type === "workspace.anchored_edit.rejected")
        ?.payload,
    ).toMatchObject({
      error: {
        code: "ANCHOR_HASH_MISMATCH",
      },
    });
  });

  it("does not write when approval is required but unavailable", async () => {
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
    });

    await expect(workspace.writeText("README.md", "after\n")).rejects.toThrow(
      "Workspace write requires approval",
    );

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "before\n",
    );
    expect(events.all().map((event) => event.type)).toContain(
      "workspace.write.denied",
    );
  });

  it("does not write when workspace write validation fails", async () => {
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
      approvalResolver() {
        throw new Error("approval should not be requested");
      },
      validationHooks: [
        {
          name: "write-policy",
          stages: ["workspace_write"],
          validate(input) {
            const proposal = input.subject as { path: string };
            if (proposal.path === "README.md") {
              return {
                status: "failed",
                findings: [
                  {
                    code: "README_LOCKED",
                    message: "README writes are locked.",
                    severity: "error",
                  },
                ],
              };
            }
          },
        },
      ],
    });

    await expect(workspace.writeText("README.md", "after\n")).rejects.toThrow(
      "Workspace write validation failed",
    );

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "before\n",
    );
    expect(events.all().map((event) => event.type)).toEqual([
      "workspace.write.requested",
      "validation.started",
      "validation.failed",
      "workspace.write.denied",
    ]);
    expect(
      events.all().find((event) => event.type === "workspace.write.denied")
        ?.payload,
    ).toMatchObject({
      path: "README.md",
      validation: {
        hookName: "write-policy",
      },
    });
  });

  it("routes approval-driven state transitions through the setState callback", async () => {
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const transitions: string[] = [];

    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
      setState(state) {
        transitions.push(state);
        run.state = state;
        run.updatedAt = new Date().toISOString();
      },
      approvalResolver(request) {
        expect(run.state).toBe("waiting_approval");
        return {
          approvalId: request.id,
          decision: "approved",
        };
      },
    });

    await workspace.writeText("README.md", "after\n");

    expect(transitions).toEqual(["waiting_approval", "running"]);
    expect(run.state).toBe("running");
  });

  it("does not write when policy denies workspace writes", async () => {
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
      policy: {
        decide({ action, metadata = {} }) {
          return {
            action,
            decision: "deny",
            reason: "Writes disabled.",
            metadata,
          };
        },
      },
      approvalResolver() {
        throw new Error("approval should not be requested");
      },
    });

    await expect(workspace.writeText("README.md", "after\n")).rejects.toThrow(
      "Workspace write denied",
    );

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "before\n",
    );
    expect(events.all().map((event) => event.type)).not.toContain(
      "approval.requested",
    );
    expect(events.all().map((event) => event.type)).not.toContain(
      "artifact.created",
    );
  });

  it("normalizes workspace write paths before policy checks", async () => {
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const policyPaths: unknown[] = [];
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: new LocalWorkspace(root),
      policy: {
        decide({ action, metadata = {} }) {
          policyPaths.push(metadata.path);
          return {
            action,
            decision: "deny",
            reason: "Writes disabled.",
            metadata,
          };
        },
      },
    });

    await expect(
      workspace.writeText("./docs/../README.md", "after\n"),
    ).rejects.toThrow("Workspace write denied");

    expect(policyPaths).toEqual(["README.md"]);
    expect(
      events.all().find((event) => event.type === "workspace.write.requested")
        ?.payload,
    ).toMatchObject({ path: "README.md" });
  });
  it("captures pre-images through the controlled write path and rolls back", async () => {
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    const run = createRunRecord();
    const events = new EventLog(run.id);
    const local = new LocalWorkspace(root);
    const checkpointStore = new WorkspaceCheckpointStore();
    const workspace = new ControlledWorkspace({
      run,
      events,
      workspace: local,
      checkpointStore,
      approvalResolver: (request) => ({
        approvalId: request.id,
        decision: "approved",
      }),
    });

    const checkpointId = checkpointStore.openCheckpoint("turn-1");
    await workspace.writeText("README.md", "after\n", { reason: "edit" });
    await workspace.writeText("created.md", "fresh\n", { reason: "create" });

    expect(checkpointStore.listCheckpoints()[0]).toMatchObject({
      id: checkpointId,
      fileCount: 2,
    });

    await checkpointStore.rollback(checkpointId, local);

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "before\n",
    );
    await expect(readFile(join(root, "created.md"), "utf8")).rejects.toThrow();
  });
});

function createRunRecord(): RunRecord {
  const now = new Date().toISOString();

  return {
    id: createRunId(),
    goal: "test",
    state: "running",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
}
