import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemasDir = path.join(root, "schemas");

const protocolDocPath = path.join(root, "docs/reference/PROTOCOL.md");

// Tokens that PROTOCOL.md legitimately mentions but that are NOT event types.
// These are policy action names, tool-call shapes, or otherwise non-event
// identifiers that share the "namespace.verb" form with real event types.
// The PROTOCOL.md round-trip scan below skips these so we don't spam warnings
// for known-good references.
const PROTOCOL_DOC_TOKEN_WHITELIST = new Set([
  // policy action names (PolicyDecision.action) — see PROTOCOL.md §Policy Decision
  "workspace.write",
]);

const schemaFiles = (await readdir(schemasDir))
  .filter((file) => file.endsWith(".schema.json"))
  .sort();

const schemas = await Promise.all(
  schemaFiles.map(async (file) => {
    const absolutePath = path.join(schemasDir, file);
    const contents = await readFile(absolutePath, "utf8");
    return {
      file,
      schema: JSON.parse(contents),
    };
  }),
);

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateSchema: true,
});
addFormats(ajv);

// Register custom annotation keyword used for protocol versioning. Declared
// here so ajv's strict mode does not reject schemas that carry it.
ajv.addKeyword({
  keyword: "x-sparkwrightProtocolVersion",
  metaSchema: { type: "string" },
});

for (const { file, schema } of schemas) {
  ajv.addSchema(schema, file);
}

let failed = false;

const EXPECTED_PROTOCOL_VERSION = "0.2";
const ID_PATTERN =
  /^https:\/\/sparkwright\.dev\/schemas\/v0\/[a-z0-9-]+\.schema\.json$/;

for (const { file, schema } of schemas) {
  const validSchema = ajv.validateSchema(schema);

  if (!validSchema) {
    failed = true;
    console.error(`Invalid JSON Schema: ${file}`);
    console.error(ajv.errorsText(ajv.errors, { separator: "\n" }));
    continue;
  }

  try {
    if (!ajv.getSchema(file)) {
      ajv.compile(schema);
    }
  } catch (error) {
    failed = true;
    console.error(`Failed to compile JSON Schema: ${file}`);
    console.error(error instanceof Error ? error.message : String(error));
  }

  if (typeof schema.$id !== "string" || !ID_PATTERN.test(schema.$id)) {
    failed = true;
    console.error(
      `Protocol versioning: ${file} has $id "${schema.$id}" which does not match ${ID_PATTERN}`,
    );
  }

  if (schema["x-sparkwrightProtocolVersion"] !== EXPECTED_PROTOCOL_VERSION) {
    failed = true;
    console.error(
      `Protocol versioning: ${file} is missing or has wrong x-sparkwrightProtocolVersion (expected "${EXPECTED_PROTOCOL_VERSION}", got ${JSON.stringify(schema["x-sparkwrightProtocolVersion"])})`,
    );
  }
}

const instanceChecks = [
  {
    schema: "capability-runtime-config.schema.json",
    instance: "examples/capability-runtime/capabilities.json",
  },
  {
    schema: "approval.schema.json",
    instance: "schemas/fixtures/approval.pending.json",
  },
  {
    schema: "run-result.schema.json",
    instance: "schemas/fixtures/run-result.completed.json",
  },
  {
    schema: "tool-result.schema.json",
    instance: "schemas/fixtures/tool-result.completed.json",
  },
  {
    schema: "config.schema.json",
    instance: "schemas/fixtures/config.example.json",
  },
  {
    schema: "host-message.schema.json",
    instance: "schemas/fixtures/host-message.request.handshake.json",
  },
  {
    schema: "host-message.schema.json",
    instance: "schemas/fixtures/host-message.request.run-start.json",
  },
  {
    schema: "host-message.schema.json",
    instance: "schemas/fixtures/host-message.request.run-resume.json",
  },
  {
    schema: "host-message.schema.json",
    instance: "schemas/fixtures/host-message.request.run-inject-message.json",
  },
  {
    schema: "host-message.schema.json",
    instance: "schemas/fixtures/host-message.response.ok.json",
  },
  {
    schema: "host-message.schema.json",
    instance: "schemas/fixtures/host-message.response.error.json",
  },
  {
    schema: "host-message.schema.json#/$defs/CapabilitySnapshot",
    instance: "schemas/fixtures/host-message.capability-snapshot.json",
  },
  {
    schema: "host-message.schema.json",
    instance: "schemas/fixtures/host-message.event.host-ready.json",
  },
  {
    schema: "host-message.schema.json",
    instance: "schemas/fixtures/host-message.event.run-event.json",
  },
  {
    schema: "host-message.schema.json",
    instance: "schemas/fixtures/host-message.event.approval-requested.json",
  },
];

for (const check of instanceChecks) {
  const validate = ajv.getSchema(check.schema);
  if (!validate) {
    failed = true;
    console.error(`Missing JSON Schema for instance check: ${check.schema}`);
    continue;
  }

  const absolutePath = path.join(root, check.instance);
  const contents = await readFile(absolutePath, "utf8");
  const instance = JSON.parse(contents);

  if (!validate(instance)) {
    failed = true;
    console.error(`Invalid JSON instance: ${check.instance}`);
    console.error(ajv.errorsText(validate.errors, { separator: "\n" }));
  }
}

// ---------------------------------------------------------------------------
// Protocol consistency checks: event enum, stopReason enum, PROTOCOL.md ←→ schema
// ---------------------------------------------------------------------------

function extractUnionLiterals(source, typeName) {
  const withoutComments = stripTsComments(source);
  // Matches: export type <Name> = | "a" | "b" ... ;
  const re = new RegExp(`export type ${typeName}\\s*=([^;]+);`);
  const m = re.exec(withoutComments);
  if (!m) return null;
  return new Set(
    Array.from(m[1].matchAll(/"([^"]+)"/g)).map((entry) => entry[1]),
  );
}

function stripTsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function diffSets(left, right) {
  const onlyLeft = [...left].filter((v) => !right.has(v));
  const onlyRight = [...right].filter((v) => !left.has(v));
  return { onlyLeft, onlyRight };
}

function getSchemaEnum(file, jsonPointer) {
  const entry = schemas.find((s) => s.file === file);
  if (!entry) return null;
  let node = entry.schema;
  for (const key of jsonPointer.split("/").filter(Boolean)) {
    node = node?.[key];
    if (node === undefined) return null;
  }
  return new Set(node);
}

const eventsTs = await readFile(
  path.join(root, "packages/core/src/events.ts"),
  "utf8",
);
const eventLiterals = extractUnionLiterals(eventsTs, "EventType");
const eventSchemaEnum = getSchemaEnum(
  "event.schema.json",
  "properties/type/enum",
);

if (!eventLiterals || !eventSchemaEnum) {
  failed = true;
  console.error(
    "Protocol consistency: could not extract EventType union or event schema enum.",
  );
} else {
  const { onlyLeft, onlyRight } = diffSets(eventLiterals, eventSchemaEnum);
  if (onlyLeft.length > 0 || onlyRight.length > 0) {
    failed = true;
    console.error(
      "Protocol consistency: EventType vs event.schema.json mismatch",
    );
    if (onlyLeft.length > 0)
      console.error(`  in code but not in schema: ${onlyLeft.join(", ")}`);
    if (onlyRight.length > 0)
      console.error(`  in schema but not in code: ${onlyRight.join(", ")}`);
  }
}

const typesTs = await readFile(
  path.join(root, "packages/core/src/types.ts"),
  "utf8",
);
const stopReasonLiterals = extractUnionLiterals(typesTs, "RunStopReason");
const runStopEnum = getSchemaEnum(
  "run.schema.json",
  "properties/stopReason/enum",
);
const runResultStopEnum = getSchemaEnum(
  "run-result.schema.json",
  "properties/stopReason/enum",
);

for (const [label, schemaEnum] of [
  ["run.schema.json", runStopEnum],
  ["run-result.schema.json", runResultStopEnum],
]) {
  if (!stopReasonLiterals || !schemaEnum) {
    failed = true;
    console.error(
      `Protocol consistency: could not extract RunStopReason or ${label} stopReason enum.`,
    );
    continue;
  }
  const { onlyLeft, onlyRight } = diffSets(stopReasonLiterals, schemaEnum);
  if (onlyLeft.length > 0 || onlyRight.length > 0) {
    failed = true;
    console.error(
      `Protocol consistency: RunStopReason vs ${label} stopReason mismatch`,
    );
    if (onlyLeft.length > 0)
      console.error(`  in code but not in schema: ${onlyLeft.join(", ")}`);
    if (onlyRight.length > 0)
      console.error(`  in schema but not in code: ${onlyRight.join(", ")}`);
  }
}

// PROTOCOL.md round-trip (warn-only). Scan for tokens shaped like event
// types and compare to the schema enum. Heuristic, intentionally permissive.
try {
  const protocolMd = await readFile(protocolDocPath, "utf8");
  const mentioned = new Set();
  for (const match of protocolMd.matchAll(
    /[`"']([a-z][a-z_]*\.[a-z][a-z_.]*)[`"']/g,
  )) {
    const token = match[1];
    if (/^[a-z][a-z_]*(\.[a-z][a-z_]+)+$/.test(token)) {
      mentioned.add(token);
    }
  }
  if (eventSchemaEnum) {
    // Only flag tokens that look like event types (>= 2 dots OR starts with
    // a known event prefix) but are not in the schema enum.
    const eventPrefixes = new Set(
      [...eventSchemaEnum].map((value) => value.split(".")[0]),
    );
    const suspicious = [...mentioned].filter(
      (token) =>
        eventPrefixes.has(token.split(".")[0]) &&
        !eventSchemaEnum.has(token) &&
        !PROTOCOL_DOC_TOKEN_WHITELIST.has(token) &&
        !/\b(json|schema)\b/.test(token),
    );
    const missingInDoc = [...eventSchemaEnum].filter(
      (value) => !mentioned.has(value),
    );
    if (suspicious.length > 0) {
      console.warn(
        `Protocol consistency (warn): PROTOCOL.md mentions event-like tokens not in schema: ${suspicious.join(", ")}`,
      );
    }
    if (missingInDoc.length > 0) {
      console.warn(
        `Protocol consistency (warn): schema events not referenced in PROTOCOL.md: ${missingInDoc.join(", ")}`,
      );
    }
  }
} catch (error) {
  console.warn(
    `Protocol consistency (warn): could not read ${path.relative(root, protocolDocPath)}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${schemas.length} JSON Schema files, ${instanceChecks.length} JSON instances, and protocol consistency.`,
  );
}
