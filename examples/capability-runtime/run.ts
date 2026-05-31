import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  createBufferedEmitter,
  createRun,
  defineTool,
  type ModelAdapter,
} from "@sparkwright/core";
import {
  createAgentProfilePolicy,
  deriveChildAgentProfile,
  type AgentProfile,
} from "@sparkwright/agent-runtime";
import {
  prepareMcpToolsForRun,
  type McpServerConfig,
  type McpToolPolicy,
} from "@sparkwright/mcp-adapter";
import { prepareSkillsForRun } from "@sparkwright/skills";

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = here.endsWith("/dist") ? dirname(here) : here;
const config = await loadConfig(join(exampleRoot, "capabilities.json"));

// Buffered emitter: extensions run before createRun, so we capture their
// edge-lifecycle events and flush them onto run.events after the run exists.
const pendingEvents = createBufferedEmitter();

const preparedSkills = await prepareSkillsForRun({
  goal: config.goal,
  skillRoots: (config.skills?.roots ?? []).map((root) =>
    join(exampleRoot, root),
  ),
  agent: {
    allowedSkills: config.skills?.allowedSkills,
    deniedSkills: config.skills?.deniedSkills,
  },
  includeLoaderTool: config.skills?.includeLoaderTool,
  loadSelectedSkills: config.skills?.loadSelectedSkills,
  maxSelectedSkills: config.skills?.maxSelectedSkills,
  resourceFileLimit: config.skills?.resourceFileLimit,
  emitter: pendingEvents,
  agentId: config.agent.id,
});

const preparedMcp = await prepareMcpToolsForRun({
  servers: config.mcp?.servers ?? [],
  defaultTimeoutMs: config.mcp?.defaultTimeoutMs,
  namePrefix: config.mcp?.namePrefix,
  policy: config.mcp?.defaultPolicy,
  emitter: pendingEvents,
  agentId: config.agent.id,
});

// Demonstrate the agent.profile.derived hook even when there is no parent.
const derivedAgent = deriveChildAgentProfile({
  childAgent: config.agent,
  emitter: pendingEvents,
});

const inspectDiff = defineTool({
  name: "inspect_diff",
  description: "Return a small deterministic diff summary for the example.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  policy: {
    risk: "safe",
  },
  execute() {
    return {
      files: ["src/example.ts"],
      summary: "One function changed; no tests were updated.",
    };
  },
});

const model: ModelAdapter = {
  async complete(input) {
    const hasObservation = input.context.some(
      (item) => item.type === "tool_result",
    );

    if (!hasObservation) {
      return {
        message: "I will inspect the diff before reviewing.",
        toolCalls: [{ toolName: "inspect_diff", arguments: {} }],
      };
    }

    return {
      message:
        "Review complete: the change touches src/example.ts and should add a focused test for the updated function.",
    };
  },
};

const run = createRun({
  goal: config.goal,
  model,
  tools: [inspectDiff, ...preparedSkills.tools, ...preparedMcp.tools],
  context: preparedSkills.context,
  policy: createAgentProfilePolicy(derivedAgent.effectiveProfile),
  maxSteps: config.agent.maxSteps,
  runBudget: config.agent.runBudget,
  metadata: {
    ...(config.metadata ?? {}),
    agentId: config.agent.id,
    loadedSkills: preparedSkills.loadedSkills,
    indexedSkills: preparedSkills.indexedSkills,
    mcpStatuses: preparedMcp.statuses,
    mcpToolNameMap: preparedMcp.toolNameMap,
  },
});

// Flush buffered extension events onto run.events so they appear in the trace.
pendingEvents.flush(run.events);

try {
  const result = await run.start();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await preparedMcp.close();
}

interface CapabilityRuntimeConfig {
  goal: string;
  skills?: {
    roots?: string[];
    allowedSkills?: string[];
    deniedSkills?: string[];
    includeLoaderTool?: boolean;
    loadSelectedSkills?: boolean;
    maxSelectedSkills?: number;
    resourceFileLimit?: number;
  };
  mcp?: {
    servers?: McpServerConfig[];
    defaultTimeoutMs?: number;
    namePrefix?: string;
    defaultPolicy?: McpToolPolicy;
  };
  agent: AgentProfile;
  metadata?: Record<string, unknown>;
}

async function loadConfig(path: string): Promise<CapabilityRuntimeConfig> {
  const config = JSON.parse(await readFile(path, "utf8"));
  const schemasRoot = join(exampleRoot, "..", "..", "schemas");
  const schemaFiles = [
    "agent-profile.schema.json",
    "mcp-server-config.schema.json",
    "capability-runtime-config.schema.json",
  ];
  const schemas = await Promise.all(
    schemaFiles.map(async (file) => ({
      file,
      schema: JSON.parse(await readFile(join(schemasRoot, file), "utf8")),
    })),
  );
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  ajv.addKeyword({
    keyword: "x-sparkwrightProtocolVersion",
    metaSchema: { type: "string" },
  });
  for (const { file, schema } of schemas) {
    ajv.addSchema(schema, file);
  }

  const validate = ajv.getSchema("capability-runtime-config.schema.json");
  if (!validate?.(config)) {
    throw new Error(
      `Invalid capability config: ${ajv.errorsText(validate?.errors)}`,
    );
  }

  return config as CapabilityRuntimeConfig;
}
