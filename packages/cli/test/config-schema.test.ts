import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHostConfig } from "@sparkwright/host";
import { runCli } from "../src/cli.js";

// Guards against drift between schemas/config.schema.json and what the CLI
// actually emits (init scaffolds, `config example`) and what the host loader
// accepts. A new field added to the loader/templates but not the schema (or
// vice versa) trips one of these checks.

const schemasDir = fileURLToPath(new URL("../../../schemas/", import.meta.url));

function buildValidator() {
  // validateFormats:false — we are checking structure/keys, not string formats
  // like "uri"; ajv otherwise logs noisy "unknown format" warnings.
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  // Register every sibling schema by $id so cross-file $refs resolve.
  for (const file of readdirSync(schemasDir)) {
    if (!file.endsWith(".schema.json")) continue;
    const schema = JSON.parse(readFileSync(join(schemasDir, file), "utf8"));
    if (schema.$id) ajv.addSchema(schema);
  }
  const configSchema = JSON.parse(
    readFileSync(join(schemasDir, "config.schema.json"), "utf8"),
  );
  return ajv.getSchema(configSchema.$id) ?? ajv.compile(configSchema);
}

function createOutputCapture() {
  let stdout = "";
  return {
    io: {
      stdout: {
        write(chunk: string | Uint8Array) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write() {
          return true;
        },
      },
      stdinIsTTY: false as const,
    },
    stdoutText: () => stdout,
  };
}

describe("config schema drift guard", () => {
  let xdg: string;
  let workspace: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    xdg = await mkdtemp(join(tmpdir(), "sparkwright-schema-xdg-"));
    workspace = await mkdtemp(join(tmpdir(), "sparkwright-schema-ws-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    await rm(xdg, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it("init scaffolds validate against the schema and load without errors", async () => {
    const validate = buildValidator();

    const userOut = createOutputCapture();
    expect((await runCli(["init"], { io: userOut.io })).exitCode).toBe(0);
    const userConfig = JSON.parse(
      await readFile(join(xdg, "sparkwright", "config.json"), "utf8"),
    );
    expect(validate(userConfig), JSON.stringify(validate.errors)).toBe(true);

    const projectOut = createOutputCapture();
    expect(
      (
        await runCli(["init", "--project"], {
          cwd: workspace,
          io: projectOut.io,
        })
      ).exitCode,
    ).toBe(0);
    const projectConfig = JSON.parse(
      await readFile(join(workspace, ".sparkwright", "config.json"), "utf8"),
    );
    expect(validate(projectConfig), JSON.stringify(validate.errors)).toBe(true);

    // The user template seeds the apiKey placeholder; the loader reports it as a
    // real run blocker only at model-resolution time, not as a schema error.
    const loaded = await loadHostConfig(workspace, {
      XDG_CONFIG_HOME: xdg,
    });
    expect(loaded.errors).toEqual([]);
  });

  it("every `config example` snippet validates and loads cleanly", async () => {
    const validate = buildValidator();
    const names = [
      "write",
      "sandbox",
      "run",
      "hooks",
      "verification",
      "mcp",
      "agent",
    ];

    for (const name of names) {
      const out = createOutputCapture();
      const result = await runCli(["config", "example", name], { io: out.io });
      expect(result.exitCode, `example ${name} exit`).toBe(0);
      const snippet = JSON.parse(out.stdoutText());

      expect(
        validate(snippet),
        `example ${name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);

      // Round-trip through the loader: a snippet the schema accepts but the
      // loader rejects is drift we want to catch.
      const ws = await mkdtemp(join(tmpdir(), "sparkwright-schema-ex-"));
      try {
        await mkdir(join(ws, ".sparkwright"), { recursive: true });
        await writeFile(
          join(ws, ".sparkwright", "config.json"),
          JSON.stringify(snippet),
          "utf8",
        );
        const loaded = await loadHostConfig(ws, { XDG_CONFIG_HOME: xdg });
        expect(loaded.errors, `example ${name} load`).toEqual([]);
      } finally {
        await rm(ws, { recursive: true, force: true });
      }
    }
  });

  it("the repository's own project config validates against the schema", async () => {
    const validate = buildValidator();
    const repoRoot = dirname(schemasDir.replace(/\/$/, ""));
    const repoConfig = JSON.parse(
      await readFile(join(repoRoot, ".sparkwright", "config.json"), "utf8"),
    );
    expect(validate(repoConfig), JSON.stringify(validate.errors)).toBe(true);
  });
});
