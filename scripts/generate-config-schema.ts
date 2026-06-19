import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { z } from "zod";
import {
  CONFIG_SCHEMA_DESCRIPTION,
  CONFIG_SCHEMA_ID,
  CONFIG_SCHEMA_PROTOCOL_VERSION,
  CONFIG_SCHEMA_TITLE,
  sparkwrightConfigZodSchema,
} from "../packages/host/src/config-zod-schema.js";

type JsonObject = Record<string, unknown>;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "schemas/config.schema.json");
const check = process.argv.includes("--check");

const schema = buildConfigSchema();
const rendered = await format(JSON.stringify(schema, null, 2), {
  parser: "json",
});

if (check) {
  const current = await readFile(outputPath, "utf8");
  if (current !== rendered) {
    console.error(
      "schemas/config.schema.json is stale. Run `npm run schema:generate`.",
    );
    process.exit(1);
  }
} else {
  await writeFile(outputPath, rendered, "utf8");
}

function buildConfigSchema(): JsonObject {
  const generated = z.toJSONSchema(sparkwrightConfigZodSchema, {
    target: "draft-2020-12",
  }) as JsonObject;
  const { $schema, description, ...rest } = generated;
  void description;

  const schema: JsonObject = {
    $schema,
    $id: CONFIG_SCHEMA_ID,
    "x-sparkwrightProtocolVersion": CONFIG_SCHEMA_PROTOCOL_VERSION,
    title: CONFIG_SCHEMA_TITLE,
    description: CONFIG_SCHEMA_DESCRIPTION,
    ...rest,
  };

  patchExternalReferences(schema);
  return schema;
}

function patchExternalReferences(schema: JsonObject): void {
  const rootProperties = properties(schema);
  const capabilities = property(rootProperties, "capabilities");
  const capabilitiesProperties = properties(capabilities);

  const mcp = property(capabilitiesProperties, "mcp");
  const mcpProperties = properties(mcp);
  const servers = property(mcpProperties, "servers");
  servers.items = { $ref: "mcp-server-config.schema.json" };

  const agents = property(capabilitiesProperties, "agents");
  const agentsProperties = properties(agents);
  const profiles = property(agentsProperties, "profiles");
  profiles.items = { $ref: "agent-profile.schema.json" };
}

function properties(schema: JsonObject): JsonObject {
  return property(schema, "properties");
}

function property(schema: JsonObject, key: string): JsonObject {
  const value = schema[key];
  if (!isJsonObject(value)) {
    throw new Error(
      `generated config schema is missing object property ${key}`,
    );
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
