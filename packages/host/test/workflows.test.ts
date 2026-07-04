import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadLayeredWorkflowAssets,
  parseWorkflowMarkdownAsset,
} from "../src/workflows.js";
import { HostRuntime } from "../src/runtime.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-workflows-"));
}

async function writeWorkflow(
  root: string,
  name: string,
  workflow: string,
  config?: string,
): Promise<void> {
  const dir = join(root, ".sparkwright", "workflows", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workflow.md"), workflow, "utf8");
  if (config) await writeFile(join(dir, "config.yaml"), config, "utf8");
}

describe("workflow assets", () => {
  it("parses workflow folder assets on the shared markdown-folder primitive", async () => {
    const workspace = await tempWorkspace();
    await writeWorkflow(
      workspace,
      "bugfix",
      [
        "---",
        "version: 1.2.3",
        "description: Fix a bug with evidence.",
        "nodes:",
        "  - id: reproduce",
        "    title: Reproduce",
        "  - id: patch",
        "    execute: model",
        "---",
        "## reproduce",
        "Run the failing command.",
        "",
        "## patch",
        "Patch the code.",
      ].join("\n"),
      ["modelTiers:", "  cheap: deterministic"].join("\n"),
    );

    const report = await loadLayeredWorkflowAssets(workspace, {
      XDG_CONFIG_HOME: join(workspace, "xdg"),
    });

    expect(report.errors).toEqual([]);
    expect(report.assets).toHaveLength(1);
    expect(report.assets[0]).toMatchObject({
      assetName: "bugfix",
      layer: "project",
      version: "1.2.3",
      description: "Fix a bug with evidence.",
      nodeCount: 2,
    });
    expect(report.assets[0]?.definition.nodes).toEqual([
      {
        id: "reproduce",
        title: "Reproduce",
        execute: "model",
        body: "Run the failing command.",
      },
      {
        id: "patch",
        execute: "model",
        body: "Patch the code.",
      },
    ]);
    expect(report.assets[0]?.definition.config).toEqual({
      modelTiers: { cheap: "deterministic" },
    });
  });

  it("rejects deferred human and ask_user nodes at parse time", () => {
    expect(() =>
      parseWorkflowMarkdownAsset({
        assetName: "wait-for-human",
        dir: "/tmp/wait-for-human",
        sourcePath: "/tmp/wait-for-human/workflow.md",
        raw: [
          "---",
          "nodes:",
          "  - id: wait",
          "    execute: human",
          "---",
          "## wait",
          "Ask later.",
        ].join("\n"),
      }),
    ).toThrow(/reserved for a later phase/);
  });

  it("parses P1 verifier and transition fields", () => {
    const detail = parseWorkflowMarkdownAsset({
      assetName: "bugfix",
      dir: "/tmp/bugfix",
      sourcePath: "/tmp/bugfix/workflow.md",
      raw: [
        "---",
        "nodes:",
        "  - id: reproduce",
        "    execute: model",
        "    tools: [read_file, shell]",
        "    verify:",
        "      - id: failing-test",
        "        kind: command",
        "        command: node",
        "        args: [--version]",
        "        expect: zero",
        "        authorized: true",
        "    onPass: patch",
        "    onFail: { retry: 2, then: fail }",
        "  - id: patch",
        "    execute: model",
        "---",
        "## reproduce",
        "Reproduce.",
        "",
        "## patch",
        "Patch.",
      ].join("\n"),
    });

    expect(detail.definition.nodes[0]).toMatchObject({
      id: "reproduce",
      tools: ["read_file", "shell"],
      verify: [
        {
          id: "failing-test",
          kind: "command",
          command: "node",
          args: ["--version"],
          expect: "zero",
          authorized: true,
        },
      ],
      onPass: "patch",
      onFail: { retry: 2, then: "fail" },
    });
  });

  it("keeps stronger workflow layers and records shadows", async () => {
    const workspace = await tempWorkspace();
    const xdg = join(workspace, "xdg");
    await writeWorkflow(
      workspace,
      "release",
      ["---", "version: project", "---", "Project"].join("\n"),
    );
    const userDir = join(xdg, "sparkwright", "workflows", "release");
    await mkdir(userDir, { recursive: true });
    await writeFile(
      join(userDir, "workflow.md"),
      ["---", "version: user", "---", "User"].join("\n"),
      "utf8",
    );

    const report = await loadLayeredWorkflowAssets(workspace, {
      XDG_CONFIG_HOME: xdg,
    });

    expect(report.assets[0]).toMatchObject({
      assetName: "release",
      layer: "project",
      version: "project",
    });
    expect(report.shadows).toEqual([
      expect.objectContaining({ assetName: "release" }),
    ]);
  });

  it("exposes workflow assets through capability snapshots", async () => {
    const workspace = await tempWorkspace();
    await writeWorkflow(
      workspace,
      "inspectable",
      ["---", "version: 0.1", "nodes: [main]", "---", "Main"].join("\n"),
    );
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    });

    const inspected = await runtime.inspectCapabilities();

    expect(inspected).toMatchObject({ ok: true });
    if (!inspected.ok) throw new Error(inspected.error.message);
    expect(inspected.snapshot.workflows?.assets).toEqual([
      expect.objectContaining({
        assetName: "inspectable",
        version: "0.1",
        nodeCount: 1,
      }),
    ]);
  });

  it("keeps workflow run instantiation behind the experimental gate", async () => {
    const workspace = await tempWorkspace();
    await writeWorkflow(
      workspace,
      "gated",
      [
        "---",
        "nodes:",
        "  - id: main",
        "    execute: model",
        "---",
        "## main",
        "Run only when enabled.",
      ].join("\n"),
    );
    const runtime = new HostRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      experimentalWorkflows: false,
      emit: () => {},
    });

    const started = await runtime.startRun({
      goal: "try gated workflow",
      workflow: "gated",
    });

    expect(started).toMatchObject({
      ok: false,
      error: {
        code: "invalid_payload",
        message: expect.stringContaining("experimental"),
      },
    });
  });
});
