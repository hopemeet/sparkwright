import { createRun, defineTool, type ModelAdapter } from "@sparkwright/core";
import { LocalWorkspace } from "@sparkwright/core/internal";

const listPackageScripts = defineTool({
  name: "list_package_scripts",
  description: "Return scripts from a workspace package.json file.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  policy: { risk: "safe" },
  async execute(args, ctx) {
    if (!ctx.workspace) throw new Error("Workspace is not configured.");

    const input = args as { path: string };
    const packageJson = JSON.parse(
      await ctx.workspace.readText(input.path),
    ) as {
      scripts?: Record<string, string>;
    };

    return packageJson.scripts ?? {};
  },
});

const model: ModelAdapter = {
  async complete(input) {
    const hasToolObservation = input.context.some(
      (item) => item.type === "tool_result",
    );

    if (!hasToolObservation) {
      return {
        message: "I will inspect package scripts.",
        toolCalls: [
          {
            toolName: "list_package_scripts",
            arguments: { path: "package.json" },
          },
        ],
      };
    }

    return {
      message: "Package scripts inspected.",
    };
  },
};

const run = createRun({
  goal: "List available package scripts.",
  workspace: new LocalWorkspace(process.cwd()),
  tools: [listPackageScripts],
  model,
});

run.events.subscribe((event) => {
  console.log(`[${event.sequence}] ${event.type}`);
});

const result = await run.start();
console.log(JSON.stringify(result, null, 2));
